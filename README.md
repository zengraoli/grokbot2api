# grokbot2api

Grok Bot（Cursor 系桌面 agent，api2.cursor.sh）→ OpenAI 兼容 API 网关。纯 HTTP 直连，无需运行 exe。

协议于 2026-10-13 从 Grok Bot 桌面客户端 0.70.2 录制逆向（SendGrokBotUserMessage + ListGrokBotTranscriptEntries + /oauth/token），全链路实测通过。

## 架构

```
accounts/*.json ──> AccountPool（轮询/自动刷新 token）
                        │
OpenAI 请求 ──> server.mjs ──> engine.mjs ──> https://api2.cursor.sh (GrokBotService, protobuf)
                        │                        ├── SendGrokBotUserMessage
                        │                        └── ListGrokBotTranscriptEntries（轮询收回复）
                        └── refresh.mjs ──> POST /oauth/token（access 58天 / refresh ~74天，滚动续期）
```

## 快速开始

```bash
# 1. 收割凭证：解密本机 Grok Bot 登录态（Windows DPAPI + AES-256-GCM）
node src/harvester.mjs

# 2. 给账号配一个已存在的会话 id（会话=对话，从官方客户端发条消息后可在 recorder 里拿到；
#    当前导出的账号文件已带）
#    或手动编辑 accounts/<email>.json 增加字段 "session_id": "<uuid>"

# 3. 起服务
node src/server.mjs 3010

# 4. OpenAI 格式调用
curl http://127.0.0.1:3010/v1/chat/completions -H "content-type: application/json" \
  -d '{"model":"grok-bot","messages":[{"role":"user","content":"你好"}]}'

# 运维端点
curl http://127.0.0.1:3010/admin/status
```

## 多账号怎么登录（凭证供给）

Grok Bot 客户端本身就是**多账号结构**（`sand-secrets.json` 的 `cursor-accounts.accounts` 是个 map，
每个账号独立的 access/refresh token 加密条目）：

1. 打开 Grok Bot exe，在设置/账号菜单里**连续添加多个账号**（无需退出前一个）；
2. 每加完一个（或全部加完）跑一次 `node src/harvester.mjs` —— 所有已登录账号一次性全量导出到 `accounts/`；
3. 服务自动轮询使用全部账号，token 临期（48h 余量）自动刷新并回写账号文件。

注意：
- **同机所有账号共享一个 machine_id**（同一安装实例的设备指纹）。目前实测服务端接受；跨机器收割的账号各带各的 machine_id，同样可用。
- refresh token 约 74 天有效，刷新响应若含新 refresh_token 会自动滚动回写；若某个账号 refresh 失效，重开 exe 登录一次再收割即可。
- 出口 IP：直连 api2.cursor.sh 时避免中国 IP（可用 WARP/代理），与社区 grok2api 实践一致。

## 附件自动落盘

bot 生成的文件（HTML/图片等）自动保存到 `files/` 目录（时间戳前缀防覆盖），对话回复中只包含
本地路径 + 在线预览链接；`GET /files/<name>` 由网关直接服务，HTML 附件点开即在浏览器渲染。
超过 200KB 的附件不读取内容，仅显示文件名提示。

## 模型

| model | 行为 | 延迟 |
|---|---|---|
| `grok-bot` | 账号的默认 bot agent，**带跨请求记忆**（上下文持续累积） | 简单问答 ~15s |
| `grok-bot-new` | 每请求一个**全新独立对话**（临时 scratch agent，用完即删），无任何历史记忆 | ~15s（scratch 后台预热） |

## 已知限制 / TODO

- [ ] 非真流式：stream=true 为伪流式（分段推送）。
- [ ] bot 路由是服务端黑盒（grok-bot-default），无法指定底层模型；复杂任务会被派发 Opus 5.5（max/xhigh）。
- [ ] 额度余量查询未接（可用额度耗尽的错误码处理待补）。

## 文件

| 文件 | 作用 |
|---|---|
| `src/harvester.mjs` | 凭证收割：Local State + sand-secrets.json → accounts/*.json |
| `src/engine.mjs` | 协议引擎：headers 构造、send、transcript 轮询 |
| `src/proto.mjs` | 最小 protobuf wire-format 编解码（tag 必须按 varint 编码） |
| `src/accounts.mjs` | 账号池：加载、轮询分配、忙锁 |
| `src/refresh.mjs` | /oauth/token 刷新（client_id=OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE） |
| `src/server.mjs` | OpenAI 兼容 HTTP 服务（/v1/models /v1/chat/completions /admin/status） |
| `start.bat` | Windows 一键启动（可选 `set GROKBOT_API_KEY=` 开启鉴权） |

## 协议备忘（坑）

- scratch agent 必须用 **CreateGrokBotTemporalAgent** 创建（CreateGrokAgent 建的永远 agent-unavailable）；
  创建后仍需 ~90s 就绪窗口（服务端自动预热/等待）
- scratch agent 的 intro 分段和第一轮对话共用 turn 0 —— 回复匹配以发送时间戳为主、turn 号为辅
- bot 回复 = 多条 send-message 分段（开场白/附件/总结），附件经 ReadGrokBotAgentAttachmentChunk
  取回全文（≤200KB 自动内联进回复）

// engine.mjs — Grok Bot pure-HTTP engine (send message + poll transcript reply)
// Protocol captured from Grok Bot desktop (Sand 0.70.x) via SAND_BACKEND_URL recording, 2026-10-13.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { encVarint, str, num, decode } from './proto.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.70.2 Safari/537.36';
const CHECKSUM_PREFIX = '8qKkwpnP'; // recorded from official client; concatenated with machine_id

export class GrokBotEngine {
  /** @param account {access_token, machine_id, agent_id? (legacy uuid of a GrokBot agent, formerly misnamed session_id)}
   *  @param opts {filesDir, filesBaseUrl} — when set, attachment contents are saved to filesDir and the
   *  chat reply carries local path + preview URL instead of the full source text. */
  constructor(account, backend = 'https://api2.cursor.sh', opts = {}) {
    this.account = account;
    this.backend = backend;
    this.agentId = account.agent_id || account.session_id || null;
    this.filesDir = opts.filesDir || null;
    this.filesBaseUrl = opts.filesBaseUrl || null;
  }

  /** persist an attachment to filesDir; returns {absPath, name, url} or null when filesDir unset */
  async saveAttachment(label, content) {
    if (!this.filesDir) return null;
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(this.filesDir, { recursive: true });
    const safe = String(label).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'attachment';
    const name = `${Date.now().toString(36)}-${safe}`;
    const abs = path.join(this.filesDir, name);
    fs.writeFileSync(abs, content, 'utf8');
    return { absPath: abs, name, url: this.filesBaseUrl ? `${this.filesBaseUrl}/files/${encodeURIComponent(name)}` : null };
  }

  headers() {
    const mid = this.account.machine_id;
    return {
      'authorization': `Bearer ${this.account.access_token}`,
      'user-agent': UA,
      'connect-protocol-version': '1',
      'connect-timeout-ms': '20000',
      'content-type': 'application/proto',
      'accept-encoding': 'gzip',
      'x-cursor-checksum': CHECKSUM_PREFIX + mid,
      'x-cursor-client-os': 'win32',
      'x-cursor-client-source': 'sand-desktop',
      'x-cursor-client-type': 'sand',
      'x-cursor-client-version': '0.70.2',
      'x-ghost-mode': 'true',
      'x-sand-box-namespace': 'prod',
      'x-request-id': crypto.randomUUID(),
    };
  }

  async rpc(method, body, service = 'aiserver.v1.GrokBotService') {
    const r = await fetch(`${this.backend}/${service}/${method}`, { method: 'POST', headers: this.headers(), body });
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    if (r.status !== 200) throw new Error(`${method} -> ${r.status}: ${buf.toString('utf8').slice(0, 200)}`);
    return decode(buf);
  }

  /** upload one image (Buffer) into the bot sandbox; returns sandbox path for Send f8 */
  async uploadImage(buf, fileName) {
    const crypto = await import('node:crypto');
    const uploadId = crypto.randomUUID();
    let path = null;
    for (let off = 0; off < buf.length || off === 0; off += 65536) {
      const chunk = buf.slice(off, off + 65536);
      const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/UploadGrokBotAgentAttachmentChunk`, {
        method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-request-id': crypto.randomUUID() },
        body: JSON.stringify({ agentId: this.agentId, uploadId, fileName, offset: off, totalSize: buf.length, data: chunk.toString('base64') }),
      });
      if (r.status !== 200) throw new Error(`uploadImage -> ${r.status}: ${(await r.text()).slice(0, 120)}`);
      const j = await r.json();
      if (j.path) path = j.path;
      if (off + chunk.length >= buf.length) break;
    }
    return path;
  }

  /** resolve an OpenAI image_url entry (data URI or http) to {buf, name} */
  async resolveImage(url, idx) {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.*)$/s.exec(url);
    if (m) return { buf: Buffer.from(m[2], 'base64'), name: `image-${idx}.${m[1] === 'jpeg' ? 'jpg' : m[1]}` };
    if (/^https?:/.test(url)) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`image download ${r.status}`);
      const ct = (r.headers.get('content-type') || 'image/png').split('/')[1] || 'png';
      return { buf: Buffer.from(await r.arrayBuffer()), name: `image-${idx}.${ct === 'jpeg' ? 'jpg' : ct}` };
    }
    return null;
  }

  /** send a user message; images = array of image_url strings; returns { dispatched, workflowId } */
  async send(text, agentId, images = []) {
    const sid = agentId || this.requireAgent();
    const t0 = Date.now();
    const trace = `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`;
    const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const parts = [str(1, sid), str(2, crypto.randomUUID()), str(3, text), num(4, t0), str(5, rich)];
    for (let i = 0; i < images.length; i++) {
      try {
        const img = await this.resolveImage(images[i], i + 1);
        if (!img) continue;
        const path = await this.uploadImage(img.buf, img.name);
        if (path) { parts.push(str(8, path), str(9, img.name)); console.log(`[image] uploaded ${img.name} (${img.buf.length}B) -> ${path.slice(-24)}`); }
      } catch (e) { console.error(`[image] upload failed: ${e.message}`); }
    }
    parts.push(str(10, trace), num(11, t0 - 24), num(13, 1), str(16, this.account.machine_id));
    const body = Buffer.concat(parts);
    const fields = await this.rpc('SendGrokBotUserMessage', body);
    const g = (f) => fields.find(x => x.f === f);
    const refusalBlob = JSON.stringify(fields.filter(x => x.f >= 4).map(x => x.s || ''));
    return { dispatched: g(1)?.v === '1', workflowId: g(3)?.s, agentId: sid, refusal: /unavailable/.test(refusalBlob) ? 'agent-unavailable' : null };
  }

  /** list transcript entries since cursor (0 = all parsed as JSON entries) */
  async listEntries(agentId, cursor = 0) {
    const sid = agentId || this.requireAgent();
    const body = Buffer.concat([str(1, sid), num(4, cursor)]);
    const fields = await this.rpc('ListGrokBotTranscriptEntries', body);
    const entries = [];
    for (const e of fields.filter(x => x.wt === undefined && x.b !== undefined || x.b)) {
      try { const j = JSON.parse(e.s); if (j && j.kind) { entries.push(j); continue; } } catch {}
      if (e.b) for (const inner of decode(e.b)) { try { const j = JSON.parse(inner.s); if (j && j.kind) entries.push(j); } catch {} }
    }
    entries.generation = Number(fields.find(x => x.f === 2)?.v || 0); // server-side transcript version: any change = turn still active
    return entries;
  }

  /** full turn: send text, wait for ALL bot reply segments of the new turn (agent tasks emit
   *  opener -> [silent work] -> attachment + summary; simple chat emits one segment).
   *  Completion = segment set stable for a quiet window (wider when the opener looks like "working on it"). */
  async chat(text, { timeoutMs = 300000, pollMs = 3000, onEntry, images = [] } = {}) {
    const turnOf = (id) => Number((/^t(\d+)[su]/.exec(id || '') || [])[1] || 0);
    const t0 = Date.now();
    const before = await this.listEntries(this.agentId).catch(() => []);
    const maxTurn = before.reduce((m, j) => Math.max(m, turnOf(j.id)), 0);
    // freshly created agents need a cold-start window; retry the send while the backend refuses with agent-unavailable
    let sent = null;
    for (let i = 0; i < 30; i++) {
      sent = await this.send(text, null, images || []);
      if (sent.dispatched || sent.refusal !== 'agent-unavailable') break;
      await new Promise(r => setTimeout(r, 3000));
    }
    const { workflowId } = sent;
    // segment match: timestamp-based primarily (scratch agents share turn 0 with their intro),
    // turn-number fallback for long-lived agents whose clock could drift
    const sendTime = Date.now();

    const deadline = Date.now() + timeoutMs;
    const seen = new Map(); // id -> segment
    let lastChange = Date.now();
    let lastGen = -1;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      const entries = await this.listEntries(this.agentId).catch(() => null);
      if (!entries) continue;
      if (entries.generation !== undefined && entries.generation !== lastGen) { lastGen = entries.generation; lastChange = Date.now(); }
      for (const j of entries) {
        if (j.kind !== 'send-message') continue;
        if (/^tb/.test(j.id || '')) continue; // tbs* bootstrap/intro segments of scratch agents — never reply content
        const ts = j.timestampMs || 0;
        if (!(ts >= sendTime - 3000 || turnOf(j.id) > maxTurn) || ts < t0 - 60000) continue;
        if (!seen.has(j.id)) { seen.set(j.id, j); lastChange = Date.now(); if (onEntry) onEntry(j); }
      }
      if (!seen.size) continue;
      const segs = [...seen.values()];
      const firstText = segs.find(s => s.message?.type === 'text')?.message?.content || '';
      const lastText = segs.filter(s => s.message?.type === 'text').at(-1)?.message?.content || '';
      const working = /正在|稍等|让我|我来|开始|着手|creating|working|let me|on it/i.test(firstText);
      const hasAttachment = segs.some(s => s.message?.type === 'attachment');
      // completion heuristics: attachment segments, closing phrases, and trailing questions all
      // mark turn end — an agent that ends on a question to the user has finished its turn
      const looksDone = hasAttachment || /做好了|完成了|已就绪|已生成|已保存|^done\b|ready\.?$|browser/i.test(lastText) || /[？?]\s*$/.test(lastText.trim());
      // task prediction from the USER request (opener phrasing alone is unreliable: "先做一个" etc.
      // evade any keyword list): non-question + creation verbs/artifact nouns => long-wait tier
      const questionLike = /[？?]$/.test(String(text).trim());
      const taskLike = !questionLike && /创建|生成|制作|写一|做一|画一|帮.{0,6}(做|写|画|生成)|html|文件|网页|动画|图片|视频|ppt|幻灯|表格|海报|修改|调整|改成|换成|更新|调大|调小|加上|去掉|删除|重命名/i.test(String(text));
      const singleShort = segs.length === 1 && firstText.length < 500; // typical direct answer
      const quietNeed = looksDone ? 4000 : ((taskLike || working) ? 60000 : (singleShort ? 2000 : 5000));
      if (Date.now() - lastChange >= quietNeed) break;
    }
    if (!seen.size) throw new Error(`timeout waiting for bot reply (workflow ${workflowId})`);

    const segIdx = (j) => Number((/^t\d+s(\d+)$/.exec(j.id || '') || [])[1] || 0);
    const parts = [];
    for (const j of [...seen.values()].sort((a, b) => segIdx(a) - segIdx(b))) {
      const m = j.message || {};
      if (m.type === 'text' && m.content) { parts.push(m.content); continue; }
      if (m.type === 'attachment') {
        const label = m.file_name || String(m.url || '').split('/').pop() || 'attachment';
        const sandboxPath = String(m.url || '').replace(/^file:\/\//, '');
        let content = null;
        try { content = sandboxPath ? await this.readAttachment(sandboxPath) : null; } catch (e) { console.error('[attach] read failed:', e.message); }
        let piece;
        const saved = content ? await this.saveAttachment(label, content) : null;
        if (saved) {
          piece = `[附件 ${label}] 已保存（${content.length} 字节）\n本地文件: ${saved.absPath}` + (saved.url ? `\n在线预览: ${saved.url}` : '');
        } else {
          piece = content ? `[附件 ${label}]\n${content}` : `[附件 ${label}]（内容暂不可读）`;
        }
        console.log(`[attach] ${label} -> ${saved ? saved.absPath : (content ? 'inlined' : 'unreadable')}`);
        parts.push(piece);
        // stream clients already got the bare marker when the segment arrived live; push the
        // saved-file notice (or inlined content when filesDir is unset) through onEntry now
        if (onEntry && piece) onEntry({ kind: 'send-message', id: j.id + ':inline', message: { type: 'text', content: piece + '\n\n' } });
      }
    }
    return parts.filter(Boolean).join('\n\n');
  }

  requireAgent() { if (!this.agentId) throw new Error('no agent_id: run ensureAgent() or set account.agent_id'); return this.agentId; }

  /** create a scratch chat agent that is immediately usable; returns its legacyAgentId (Send f1).
   *  NOTE: must use CreateGrokBotTemporalAgent — plain CreateGrokBotAgent yields agents stuck
   *  in "agent-unavailable" forever (draft definition, no runtime). */
  async createAgent(name = 'grokbot2api-scratch') {
    const crypto = await import('node:crypto');
    const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/CreateGrokBotTemporalAgent`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({ agentId: crypto.randomUUID(), legacyAgentId: crypto.randomUUID(), name, title: name }),
    });
    if (r.status !== 200) throw new Error(`CreateGrokBotTemporalAgent -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    return { legacyAgentId: j.agent?.legacyAgentId, numericId: j.agent?.id, name: j.agent?.name };
  }

  /** delete leftover scratch agents (names starting with prefix) created by previous runs */
  async cleanupScratchAgents(prefix = 'gb2a-') {
    const crypto = await import('node:crypto');
    const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/ListGrokBotAgents`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-request-id': crypto.randomUUID() }, body: '{}',
    });
    if (r.status !== 200) return 0;
    let n = 0;
    for (const a of ((await r.json()).agents || [])) {
      if ((a.name || '').startsWith(prefix) || a.name === 'grokbot2api-scratch') { if (await this.deleteAgent(a.id)) n++; }
    }
    return n;
  }

  async deleteAgent(numericId) {
    const crypto = await import('node:crypto');
    const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/DeleteGrokBotAgent`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({ id: numericId }),
    });
    return r.status === 200;
  }

  /** read a bot-sandbox attachment fully (chunked); returns utf8 text or null when oversized */
  async readAttachment(path, maxBytes = 204800) {
    const call = async (offset, length) => {
      const crypto = await import('node:crypto');
      const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/ReadGrokBotAgentAttachmentChunk`, {
        method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-request-id': crypto.randomUUID() },
        body: JSON.stringify({ path, offset, length }),
      });
      if (r.status !== 200) throw new Error(`ReadAttachmentChunk -> ${r.status}`);
      return r.json();
    };
    const total = Number((await call(0, 1)).totalSize || 0);
    if (!total || total > maxBytes) return null;
    const chunks = [];
    for (let off = 0; off < total; off += 65536) {
      const j = await call(off, Math.min(65536, total - off));
      chunks.push(Buffer.from(j.data || '', 'base64'));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** discover and persist the default chat agent (name 'Grok Bot', kind AGENT); Send/List f1 = legacyAgentId */
  async ensureAgent(accountFile) {
    if (this.agentId) return this.agentId;
    const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/ListGrokBotAgents`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: '{}',
    });
    if (r.status !== 200) throw new Error(`ListGrokBotAgents -> ${r.status}`);
    const d = await r.json();
    const agents = d.agents || [];
    const def = agents.find(a => a.kind === 'GROK_BOT_AGENT_KIND_AGENT' && a.name === 'Grok Bot') || agents.find(a => a.kind === 'GROK_BOT_AGENT_KIND_AGENT');
    if (!def?.legacyAgentId) throw new Error('no chat agent found in ListGrokBotAgents');
    this.agentId = def.legacyAgentId;
    this.account.agent_id = this.agentId; this.account.session_id = this.agentId; // keep legacy field in sync
    if (accountFile) { const fs = await import('node:fs'); fs.writeFileSync(accountFile, JSON.stringify(this.account, null, 2)); }
    console.log(`[engine] agent discovered: ${def.name} (${this.agentId})`);
    return this.agentId;
  }

  async verifyToken() {
    const r = await fetch(`${this.backend}/aiserver.v1.GrokBotService/ListGrokBotAgents`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: '{}' });
    return r.status === 200;
  }
}

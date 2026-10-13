// server.mjs — grokbot2api: OpenAI-compatible HTTP facade over Grok Bot accounts
// Run: node src/server.mjs [port=3010]   then: curl :3010/v1/chat/completions ...
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { AccountPool } from './accounts.mjs';
import { refreshAccount } from './refresh.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(ROOT, 'public', 'index.html');
const PORT = Number(process.argv[2] || process.env.PORT || 3010);
const API_KEY = process.env.GROKBOT_API_KEY || ''; // set in start.bat to require auth; empty = accept anything
const FILES_DIR = path.join(ROOT, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const pool = new AccountPool(undefined, { filesDir: FILES_DIR, filesBaseUrl: `http://127.0.0.1:${PORT}` }).load();
for (const acc of pool.accounts) { // sweep leftover scratch agents; creation is on-demand (no prewarm: idle scratch agents occupy the account's sandbox slots and block new ones)
  acc.engine.cleanupScratchAgents()
    .then(n => { if (n) console.log(`[pool] cleaned ${n} leftover scratch agents`); })
    .catch(() => {});
}
const authorized = (req) => !API_KEY || req.headers.authorization === `Bearer ${API_KEY}`;

const MODEL = 'grok-bot';
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8') || '{}')); });

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (!authorized(req) && (url.startsWith('/v1/') || url.startsWith('/admin/'))) {
      return json(res, 401, { error: { message: 'invalid api key (set Authorization: Bearer <key>)' } });
    }
    if (url.startsWith('/files/') && req.method === 'GET') { // saved attachment downloads/previews (HTML renders in browser)
      const name = path.basename(decodeURIComponent(url.slice(7)));
      const file = path.join(FILES_DIR, name);
      let data;
      try { data = fs.readFileSync(file); } catch { return json(res, 404, { error: { message: `no such file: ${name}` } }); }
      const ext = name.split('.').pop().toLowerCase();
      const mime = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` });
      return res.end(data);
    }
    if (url === '/v1/models' && req.method === 'GET') {
      return json(res, 200, { object: 'list', data: [
          { id: MODEL, object: 'model', created: 1791827805, owned_by: 'xai' },
          { id: 'grok-bot-new', object: 'model', created: 1791866800, owned_by: 'xai' },
        ] });
    }
    if (url === '/admin/status' && req.method === 'GET') {
      return json(res, 200, { accounts: pool.status() });
    }
    if (url === '/admin/refresh-all' && req.method === 'POST') {
      let n = 0; const errs = [];
      for (const acc of pool.accounts) {
        try { await refreshAccount(acc.data, acc.file); acc.engine.account = acc.data; acc.ok = true; n++; }
        catch (e) { acc.ok = false; errs.push(`${acc.data.email}: ${e.message}`); }
      }
      return json(res, 200, { message: `refreshed ${n}/${pool.accounts.length}${errs.length ? ' | ' + errs.join('; ').slice(0, 200) : ''}` });
    }
    if (url === '/admin/harvest' && req.method === 'POST') {
      const out = await new Promise((resolve) => {
        execFile('node', [path.join(ROOT, 'src', 'harvester.mjs')], { cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) =>
          resolve({ err: err?.message, stdout: String(stdout).trim().split('\n').slice(-6), stderr: String(stderr).slice(0, 200) }));
      });
      let reloadInfo = {};
      try { reloadInfo = pool.reload(); } catch (e) { reloadInfo = { message: 'reload: ' + e.message }; }
      return json(res, 200, { message: (out.err ? 'harvest error: ' + out.err + ' ' + out.stderr : (out.stdout || []).join(' | ')) + `; ${reloadInfo.message ?? ''}` });
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const fresh = body.model === 'grok-bot-new'; // per-request scratch agent (no memory), auto-deleted after
      if (body.model && body.model !== MODEL && !fresh) return json(res, 400, { error: { message: `unknown model ${body.model}, use "${MODEL}" or "grok-bot-new"` } });
      const messages = body.messages || [];
      if (!messages.length) return json(res, 400, { error: { message: 'messages required' } });
      // harnesses inject meta into the conversation two ways: tagged blobs (<system-reminder> skill
      // lists) and bare-text system turns ("workspace is D:\..., write allowed, approvals on ask").
      // Grok Bot is a task agent — it reads both as assignments. So: system turns are never
      // forwarded, tags are stripped, and env-status user turns are skipped.
      // Multimodal content arrays ({type:'text'|'image_url'}) are split: text joins the prompt,
      // images are collected for upload to the bot's sandbox.
      const normalize = (m) => {
        const c = m?.content;
        if (typeof c === 'string') return { text: c, images: [] };
        if (Array.isArray(c)) {
          let text = ''; const images = [];
          for (const p of c) {
            if (p?.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
            else if (p?.type === 'image_url' && p.image_url?.url) images.push(p.image_url.url);
          }
          return { text, images };
        }
        return { text: '', images: [] };
      };
      const norm = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, ...normalize(m) }));
      const images = norm.filter(m => m.role === 'user' && m.images.length).at(-1)?.images || [];
      const strip = (t) => String(t ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<system-ping>[\s\S]*?<\/system-ping>/g, '').trim();
      const isEnvNoise = (t) => /write\s+(is\s+)?(not\s+)?allowed|approvals?\s+(on|off|ask)|permissions?\s+(on|off|ask)|^workspace\s+is|^current runtime context|runtime-context snapshot|^工作区/.test(t);
      const clean = norm
        .map(m => ({ role: m.role, content: strip(m.text) }))
        .filter(m => m.content && !isEnvNoise(m.content));
      console.log(`[chat] model=${body.model} stream=${body.stream === true} incoming=${messages.length} msgs, kept=${clean.length}${images.length ? `, images=${images.length}` : ''}:`);
      // harness session-title generation: answer locally from the referenced messages, never hit the bot
      const titleSrc = messages.find(m => m.role !== 'system' && /^generate the session title/i.test(String(m.content ?? '')));
      if (titleSrc) {
        let title = 'New chat';
        try { const arr = JSON.parse(String(titleSrc.content).match(/\[[\s\S]*\]/)?.[0] || '[]'); title = String(arr.at(-1)?.text || arr[0]?.text || 'New chat').split('\n')[0].slice(0, 40); } catch {}
        console.log(`[chat] title-gen answered locally: "${title}"`);
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-title', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: title }, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n'); return res.end();
        }
        return json(res, 200, { id: 'chatcmpl-title', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: title }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      const oneLine = (t) => String(t ?? '').split('\n').join(' ').slice(0, 90);
      for (const m of messages) console.log(`  IN  ${m.role.padEnd(9)} ${oneLine(m.content)}`);
      for (const m of clean) console.log(`  OUT ${m.role.padEnd(9)} ${oneLine(m.content)}`);
      if (!clean.length) { // pure injection: answer locally, never wake the bot
        const noop = '(已忽略 harness 的空系统消息，未发送给 bot)';
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-noop', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: noop }, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n'); return res.end();
        }
        return json(res, 200, { id: 'chatcmpl-noop', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: noop }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      // flatten conversation into a single prompt (bot session holds its own memory; this keeps OpenAI semantics)
      const prompt = clean.map(m => `${m.role === 'assistant' ? '[assistant]' : m.role === 'system' ? '[system]' : '[user]'} ${m.content}`).join('\n\n')
        + `\n\n[system] Reply to the last user message above directly.`;
      const userMsg = [...clean].reverse().find(m => m.role === 'user')?.content || clean[clean.length - 1].content;

      const id = `chatcmpl-${Date.now().toString(36)}`;
      const stream = body.stream === true;
      const t0 = Date.now();

      // streaming requests get SSE headers + keepalive immediately so clients never see a dead
      // connection while a turn runs (agent tasks can take 30-90s before the first segment).
      // Non-stream requests stay plain JSON: latency is ~15-20s, and an SSE body would break them.
      let heartbeat = null;
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 5000);
        res.write(': connecting\n\n');
      }
      const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

      const sendChunk = (delta, finish = null) => {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(t0 / 1000), model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      };

      const onEntry = stream ? (j) => {
        const m = j.message || {};
        // attachments are delivered once, fully inlined, by engine at turn end — skip bare markers here
        if (m.type === 'text' && m.content) sendChunk({ content: m.content + '\n\n' });
      } : undefined;

      const reply = fresh
        ? await pool.withScratch(async (acc, scratch) => {
            const saved = acc.engine.agentId;
            acc.engine.agentId = scratch.legacyAgentId;
            try { return await acc.engine.chat(userMsg, { timeoutMs: 300000, pollMs: 3000, onEntry, images }); }
            finally { acc.engine.agentId = saved; }
          })
        : await pool.withAccount(acc => acc.engine.chat(stream ? userMsg : prompt, { timeoutMs: 300000, onEntry, images }));
      stopHeartbeat();

      if (stream) {
        sendChunk({}, 'stop'); // segments already streamed live via onEntry; empty delta just closes
        res.write('data: [DONE]\n\n'); return res.end();
      }
      return json(res, 200, {
        id, object: 'chat.completion', created: Math.floor(t0 / 1000), model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(reply.length / 4), total_tokens: Math.ceil((prompt.length + reply.length) / 4) },
        grok_meta: { account: pool.status()[0]?.email, latency_ms: Date.now() - t0 },
      });
    }
    json(res, 404, { error: { message: 'not found. try GET /v1/models, POST /v1/chat/completions, GET /admin/status' } });
  } catch (e) {
    if (res.headersSent) { // SSE already open (stream mode): deliver the error as a terminal chunk instead of invalid JSON
      try { res.write(`data: ${JSON.stringify({ id: 'chatcmpl-err', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: `\n[grokbot2api error] ${e.message}` }, finish_reason: 'stop' }] })}\n\n`); res.write('data: [DONE]\n\n'); } catch {}
      return res.end();
    }
    json(res, 500, { error: { message: e.message } });
  }
});

server.listen(PORT, () => console.log(`grokbot2api listening on http://127.0.0.1:${PORT} — ${pool.accounts.length} account(s), model "${MODEL}"`));

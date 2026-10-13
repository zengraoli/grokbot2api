// accounts.mjs — account pool: loads accounts/*.json, lazy refresh, round-robin dispatch
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokBotEngine } from './engine.mjs';
import { refreshAccount, isExpiring } from './refresh.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'accounts');

export class AccountPool {
  constructor(dir = DIR, engineOpts = {}) {
    this.dir = dir;
    this.engineOpts = engineOpts;
    this.accounts = [];   // { file, data, engine, busy, ok }
    this.rr = 0;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
      const file = path.join(this.dir, f);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const prev = this.accounts.find(a => a.file === file); // keep stats across reloads
        this.accounts.push({ file, data, engine: new GrokBotEngine(data, undefined, this.engineOpts), busy: false, ok: null,
          requests: prev?.requests || 0, last_used: prev?.last_used || null });
        console.log(`[pool] loaded ${data.email || data.id} (exp ${data.access_exp})`);
      } catch (e) { console.warn(`[pool] skip ${f}: ${e.message}`); }
    }
    if (!this.accounts.length) throw new Error(`no accounts in ${this.dir} — run: node src/harvester.mjs`);
    return this;
  }

  /** reload account files (after harvest) while keeping stats of existing ones */
  reload() {
    const removed = this.accounts.length;
    this.accounts = [];
    this.load();
    return { added: this.accounts.length, message: `pool reloaded: ${this.accounts.length} account(s)` };
  }

  /** ensure access token valid; refresh (and persist) when near expiry; auto-discover chat agent */
  async ensureAuth(acc) {
    if (isExpiring(acc.data)) {
      console.log(`[pool] refreshing ${acc.data.email || acc.data.id}...`);
      await refreshAccount(acc.data, acc.file);
      acc.engine.account = acc.data;
    }
    if (!acc.engine.agentId) await acc.engine.ensureAgent(acc.file);
  }

  /** wait for any free account up to timeoutMs (requests queue instead of failing fast).
   *  Claims (sets busy) atomically inside the sync section — selecting first and marking later
   *  across an await boundary let two concurrent requests claim the same account. */
  async acquire(timeoutMs = 120000) {
    const t0 = Date.now();
    for (;;) {
      const free = this.accounts.filter(a => !a.busy);
      if (free.length) { const acc = free[Math.floor(Math.random() * free.length)]; acc.busy = true; return acc; }
      if (Date.now() - t0 >= timeoutMs) return null;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /** pick next free account (queues while all busy), mark busy for the duration of fn */
  async withAccount(fn) {
    const acc = await this.acquire(); // claims busy itself
    if (!acc) throw new Error('all accounts busy (waited 120s)');
    try {
      await this.ensureAuth(acc);
      const out = await fn(acc);
      acc.ok = true; acc.requests++; acc.last_used = new Date().toISOString();
      return out;
    } catch (e) { acc.ok = false; throw e; }
    finally { acc.busy = false; }
  }

  /** run fn with a scratch (fresh) agent: create on demand, delete after.
   *  No prewarm pool: idle scratch agents occupy the account's limited sandbox slots
   *  (~2-3 concurrent) and block creation of new ones (send/agent-unavailable). */
  async withScratch(fn) {
    const acc = await this.acquire(); // claims busy itself
    if (!acc) throw new Error('all accounts busy (waited 120s)');
    let scratch;
    try {
      await this.ensureAuth(acc);
      scratch = await acc.engine.createAgent('gb2a-' + Date.now().toString(36));
      return await fn(acc, scratch);
    } finally {
      acc.busy = false;
      if (scratch) acc.engine.deleteAgent(scratch.numericId).catch(() => {});
    }
  }

  /** pick a specific account by email (substring match); claims busy like acquire */
  async withAccountByEmail(email, fn) {
    const want = String(email || '').toLowerCase();
    const t0 = Date.now();
    for (;;) {
      const acc = this.accounts.find(x => !x.busy && String(x.data.email || x.data.id).toLowerCase().includes(want));
      if (acc) { acc.busy = true; try { await this.ensureAuth(acc); const out = await fn(acc); acc.ok = true; acc.requests++; acc.last_used = new Date().toISOString(); return out; } catch (e) { acc.ok = false; throw e; } finally { acc.busy = false; } }
      if (Date.now() - t0 >= 120000) throw new Error(`account matching "${email}" is busy or not found (waited 120s)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /** per-account weekly quota snapshot */
  async usage() {
    return Promise.all(this.accounts.map(async a => {
      const base = { email: a.data.email || a.data.id };
      try { return { ...base, ...(await a.engine.getUsage()) }; }
      catch (e) { return { ...base, error: e.message }; }
    }));
  }

  status() {
    return this.accounts.map(a => ({ email: a.data.email || a.data.id, exp: a.data.access_exp, busy: a.busy,
      ok: a.ok, requests: a.requests, last_used: a.last_used, agent: a.engine.agentId || a.data.agent_id || a.data.session_id || null }));
  }
}

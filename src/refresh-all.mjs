// refresh-all.mjs — force-refresh every harvested account now
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshAccount } from './refresh.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'accounts');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const file = path.join(dir, f);
  const acc = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    await refreshAccount(acc, file);
    console.log(`✔ ${acc.email || f} -> exp ${acc.access_exp}${acc.refresh_token ? ' (refresh rotated)' : ''}`);
  } catch (e) { console.error(`✘ ${acc.email || f}: ${e.message}`); }
}

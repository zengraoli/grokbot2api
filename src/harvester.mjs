// harvester.mjs — decrypt Grok Bot local credentials into accounts/*.json
// Windows DPAPI (via PowerShell) + AES-256-GCM ("v10" Chromium scheme)
// Usage: node src/harvester.mjs [--appdata <path>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const appData = process.argv.includes('--appdata')
  ? process.argv[process.argv.indexOf('--appdata') + 1]
  : path.join(process.env.APPDATA, 'Grok Bot');
const outDir = new URL('../accounts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// 1. master key: Local State -> os_crypt.encrypted_key (base64, "DPAPI" prefix) -> CryptUnprotectData
const localState = JSON.parse(fs.readFileSync(path.join(appData, 'Local State'), 'utf8'));
const encKey = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
const dpapiBlob = encKey.slice(0, 5).toString() === 'DPAPI' ? encKey.slice(5) : encKey;
const masterKey = Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${dpapiBlob.toString('base64')}'); $k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Convert]::ToBase64String($k)`], { encoding: 'utf8' }).trim(), 'base64');
if (masterKey.length !== 32) throw new Error(`master key length ${masterKey.length} != 32`);
console.log(`master key: ${masterKey.toString('hex').slice(0, 12)}...`);

// 2. decrypt "djEw"(v10) blobs: v10 | 12B IV | ciphertext | 16B GCM tag
function decryptBlob(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 3).toString() === 'v10') {
    const iv = raw.slice(3, 15), tag = raw.slice(raw.length - 16), data = raw.slice(15, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }
  if (b64.startsWith('plaintext:v1:')) return b64.slice('plaintext:v1:'.length);
  throw new Error('unknown blob prefix: ' + raw.slice(0, 4).toString('hex'));
}

// 3. walk sand-secrets.json
const secrets = JSON.parse(fs.readFileSync(path.join(appData, 'sand-secrets.json'), 'utf8'));
const machineId = decryptBlob(secrets['cursor-machine-id']);
const accountsIdx = JSON.parse(secrets['cursor-accounts']);
fs.mkdirSync(outDir, { recursive: true });

const jwtPayload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
let n = 0;
for (const [id, blobs] of Object.entries(accountsIdx.accounts || {})) {
  const access = decryptBlob(blobs['cursor-access-token']);
  const refresh = decryptBlob(blobs['cursor-refresh-token']);
  let profile = {};
  try { profile = JSON.parse(decryptBlob(blobs['cursor-account-profile'])); } catch {}
  const payload = jwtPayload(access);
  const account = {
    id, machine_id: machineId, active: accountsIdx.active === id,
    email: profile.email || payload.email || '', sub: payload.sub || '',
    access_token: access, refresh_token: refresh,
    access_exp: new Date(Number(payload.exp) * 1000).toISOString(),
  };
  const file = path.join(outDir, `${(account.email || id).replace(/[^a-z0-9@._-]/gi, '_')}.json`);
  try { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); if (prev.session_id) account.session_id = prev.session_id; } catch {} // keep known session across re-harvests
  fs.writeFileSync(file, JSON.stringify(account, null, 2));
  console.log(`✔ ${account.email || id}  access_exp=${account.access_exp}  -> ${path.basename(file)}`);
  n++;
}
console.log(`\n${n} account(s) harvested into ${outDir} (machine_id=${machineId})`);

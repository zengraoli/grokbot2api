// refresh.mjs — pure-HTTP access token refresh (recorded from official client: POST /oauth/token)
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ID = 'OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE';

/** POST /oauth/token with grant_type=refresh_token; persists rotated tokens back into the account file */
export async function refreshAccount(account, accountFile, backend = 'https://api2.cursor.sh') {
  const r = await fetch(`${backend}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'node', accept: '*/*' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: account.refresh_token }),
  });
  if (r.status !== 200) throw new Error(`refresh -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('refresh response missing access_token: ' + JSON.stringify(j).slice(0, 200));
  account.access_token = j.access_token;
  if (j.refresh_token) account.refresh_token = j.refresh_token; // rotated if present
  const payload = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64').toString('utf8'));
  account.access_exp = new Date(Number(payload.exp) * 1000).toISOString();
  if (accountFile) fs.writeFileSync(accountFile, JSON.stringify(account, null, 2));
  return account;
}

export const isExpiring = (account, marginMs = 48 * 3600 * 1000) =>
  Date.now() > new Date(account.access_exp).getTime() - marginMs;

import { config } from './config.js';

let token = null;

async function getAppToken(force = false) {
  if (!force && token && Date.now() < token.expiresAt - 60_000) return token.accessToken;
  const res = await fetch(`${config.twitchAuthBase}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.twitchClientId,
      client_secret: config.twitchClientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  token = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.accessToken;
}

async function helix(path, param, values, extraParams = {}) {
  const url = new URL(config.twitchApiBase + path);
  for (const v of values) url.searchParams.append(param, v);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

  const request = async (force) => fetch(url, {
    headers: {
      'Client-ID': config.twitchClientId,
      Authorization: `Bearer ${await getAppToken(force)}`,
    },
  });

  let res = await request(false);
  if (res.status === 401) res = await request(true);
  if (!res.ok) throw new Error(`Twitch API ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function getUsers(logins) {
  const results = await Promise.all(
    chunks(logins, 100).map((c) => helix('/users', 'login', c)),
  );
  return results.flat();
}

export async function getStreams(logins) {
  const results = await Promise.all(
    chunks(logins, 100).map((c) => helix('/streams', 'user_login', c, { type: 'live', first: 100 })),
  );
  return results.flat();
}

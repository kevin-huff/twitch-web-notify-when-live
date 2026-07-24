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

async function helix(method, path, { params = {}, body } = {}) {
  const url = new URL(config.twitchApiBase + path);
  for (const [key, value] of Object.entries(params)) {
    for (const item of [].concat(value)) url.searchParams.append(key, item);
  }
  const request = async (force) => fetch(url, {
    method,
    headers: {
      'Client-ID': config.twitchClientId,
      Authorization: `Bearer ${await getAppToken(force)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await request(false);
  if (res.status === 401) res = await request(true);
  return res;
}

async function helixJson(method, path, opts) {
  const res = await helix(method, path, opts);
  if (!res.ok) throw new Error(`Twitch API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function getUsers(logins) {
  const results = await Promise.all(
    chunks(logins, 100).map((c) => helixJson('GET', '/users', { params: { login: c } })),
  );
  return results.flatMap((r) => r.data);
}

export async function getStreams(logins) {
  const results = await Promise.all(
    chunks(logins, 100).map((c) =>
      helixJson('GET', '/streams', { params: { user_login: c, type: 'live', first: 100 } })),
  );
  return results.flatMap((r) => r.data);
}

export async function listEventSubSubscriptions() {
  return (await helixJson('GET', '/eventsub/subscriptions')).data;
}

export async function createEventSubSubscription(broadcasterId, callback, secret) {
  const res = await helix('POST', '/eventsub/subscriptions', {
    body: {
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: 'webhook', callback, secret },
    },
  });
  if (res.status === 409) return 'exists';
  if (!res.ok) throw new Error(`EventSub create failed: ${res.status} ${await res.text()}`);
  return 'created';
}

export async function deleteEventSubSubscription(id) {
  const res = await helix('DELETE', '/eventsub/subscriptions', { params: { id } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`EventSub delete failed: ${res.status} ${await res.text()}`);
  }
}

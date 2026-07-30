import { config } from './config.js';

let token = null;

async function getAppToken(force = false) {
  if (!force && token && Date.now() < token.expiresAt - 60_000) return token.accessToken;
  const res = await fetch(`${config.kickAuthBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.kickClientId,
      client_secret: config.kickClientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Kick token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  token = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.accessToken;
}

async function api(method, path, { params = {}, body } = {}) {
  const url = new URL(config.kickApiBase + path);
  for (const [key, value] of Object.entries(params)) {
    for (const item of [].concat(value)) url.searchParams.append(key, item);
  }
  const request = async (force) => fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAppToken(force)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await request(false);
  if (res.status === 401) res = await request(true);
  return res;
}

async function apiJson(method, path, opts) {
  const res = await api(method, path, opts);
  if (!res.ok) throw new Error(`Kick API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function getChannels(slugs) {
  const results = await Promise.all(
    chunks(slugs, 50).map((c) => apiJson('GET', '/channels', { params: { slug: c } })),
  );
  return results.flatMap((r) => r.data ?? []);
}

export async function getUsers(ids) {
  const results = await Promise.all(
    chunks(ids, 50).map((c) => apiJson('GET', '/users', { params: { id: c } })),
  );
  return results.flatMap((r) => r.data ?? []);
}

export async function listEventSubscriptions() {
  return (await apiJson('GET', '/events/subscriptions')).data ?? [];
}

export async function createEventSubscription(broadcasterUserId) {
  const res = await api('POST', '/events/subscriptions', {
    body: {
      broadcaster_user_id: Number(broadcasterUserId),
      events: [{ name: 'livestream.status.updated', version: 1 }],
      method: 'webhook',
    },
  });
  if (!res.ok) throw new Error(`Kick event subscribe failed: ${res.status} ${await res.text()}`);
  return 'created';
}

export async function deleteEventSubscription(id) {
  const res = await api('DELETE', '/events/subscriptions', { params: { id } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Kick event unsubscribe failed: ${res.status} ${await res.text()}`);
  }
}

export async function getPublicKey() {
  return (await apiJson('GET', '/public-key')).data?.public_key ?? null;
}

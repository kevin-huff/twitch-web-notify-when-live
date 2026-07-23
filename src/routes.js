import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import * as db from './db.js';
import { getUsers, getStreams } from './twitch.js';
import { vapidPublicKey, sendToSubscription } from './push.js';
import { handleLiveStream } from './poller.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const router = express.Router();

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' https://static-cdn.jtvnw.net",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function pageHeaders(res) {
  res.set('Content-Security-Policy', PAGE_CSP);
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
}

router.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

router.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (config.allowedOrigins.size) {
    if (origin && !config.allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
  } else {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const LOGIN_RE = /^[a-z0-9_]{3,25}$/;

async function resolveChannel(rawLogin) {
  const login = String(rawLogin ?? '').trim().toLowerCase();
  if (!LOGIN_RE.test(login)) return { status: 404, error: 'channel_not_found' };
  if (config.channelAllowlist.size && !config.channelAllowlist.has(login)) {
    return { status: 403, error: 'channel_not_allowed' };
  }
  let row = db.getChannel(login);
  if (!row) {
    const users = await getUsers([login]);
    if (!users.length) return { status: 404, error: 'channel_not_found' };
    const user = users[0];
    db.upsertChannel({
      login,
      broadcaster_id: user.id,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url ?? null,
    });
    row = db.getChannel(login);
  }
  return { row };
}

router.get('/api/config', async (req, res) => {
  const { row, status, error } = await resolveChannel(req.query.channel);
  if (error) return res.status(status).json({ error });
  res.json({
    vapidPublicKey,
    channel: {
      login: row.login,
      displayName: row.display_name,
      profileImageUrl: row.profile_image_url,
    },
  });
});

router.post('/api/subscribe', async (req, res) => {
  const { channel, subscription } = req.body ?? {};
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)
    || typeof p256dh !== 'string' || !p256dh
    || typeof auth !== 'string' || !auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  const { row, status, error } = await resolveChannel(channel);
  if (error) return res.status(status).json({ error });
  db.addSubscription({
    channel: row.login,
    endpoint,
    p256dh,
    auth,
    origin: req.headers.origin ?? null,
  });
  res.status(201).json({ ok: true });
  sendWelcomeIfLive(row, { endpoint, p256dh, auth }).catch((err) =>
    console.warn('[push] welcome check failed:', err.message ?? err));
});

// New subscribers get an immediate notification if the channel is already
// live, so they can see it works. Claim the stream id afterwards so the
// poller doesn't send them the same stream again.
async function sendWelcomeIfLive(channelRow, sub) {
  const [stream] = await getStreams([channelRow.login]);
  if (!stream) return;
  await sendToSubscription(sub, {
    title: `Notifications are on — ${channelRow.display_name} is live right now!`,
    body: stream.title
      ? stream.game_name ? `${stream.title} — ${stream.game_name}` : stream.title
      : 'Streaming now on Twitch',
    icon: channelRow.profile_image_url || undefined,
    url: `https://twitch.tv/${channelRow.login}`,
    tag: `twn-${channelRow.login}-${stream.id}`,
  });
  db.claimStream(channelRow.login, String(stream.id));
}

router.post('/api/unsubscribe', (req, res) => {
  const { channel, endpoint } = req.body ?? {};
  const login = String(channel ?? '').trim().toLowerCase();
  if (!LOGIN_RE.test(login) || typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  db.removeSubscription(login, endpoint);
  res.json({ ok: true, remainingChannelsForEndpoint: db.countChannelsForEndpoint(endpoint) });
});

router.post('/api/test/notify', async (req, res) => {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { row, status, error } = await resolveChannel(req.body?.channel);
  if (error) return res.status(status).json({ error });
  const stream = {
    id: req.body?.streamId ?? `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    title: req.body?.title ?? 'Test notification',
    game_name: req.body?.gameName ?? '',
    thumbnail_url: null,
  };
  const result = await handleLiveStream(row, stream);
  res.json({ ok: true, ...result });
});

router.get('/sw.js', (req, res) => {
  res.type('text/javascript');
  res.set('Cache-Control', 'no-cache');
  res.send(`importScripts('${config.publicBaseUrl}/sw-core.js');\n`);
});

router.get('/subscribe', (req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(publicDir, 'subscribe.html'));
});

router.get('/faq', (req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(publicDir, 'faq.html'));
});

router.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

router.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    res.set('Cache-Control', 'public, max-age=300');
    if (filePath.endsWith('.html')) pageHeaders(res);
  },
}));

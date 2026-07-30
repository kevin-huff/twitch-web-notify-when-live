import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { config, allowlistHas } from './config.js';
import * as db from './db.js';
import { getUsers, searchChannels } from './twitch.js';
import * as kick from './kick.js';
import { PLATFORMS, normalizePlatform, fetchLiveStream, liveNotificationPayload } from './platforms.js';
import { vapidPublicKey, sendToSubscription } from './push.js';
import { handleLiveStream } from './poller.js';
import { callbackHandler, ensureChannelSubscription, eventsubStatus } from './eventsub.js';
import * as kickevents from './kickevents.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const router = express.Router();

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' https://static-cdn.jtvnw.net https://files.kick.com https://images.kick.com",
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

// Fixed-window in-memory rate limiter, one bucket map per route group.
function rateLimiter(max, windowMs = 60_000) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now - entry.start > windowMs) hits.delete(key);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

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

function validLogin(platform, rawLogin) {
  const login = String(rawLogin ?? '').trim().toLowerCase();
  return PLATFORMS[platform].loginRe.test(login) ? login : null;
}

function channelJson(row) {
  return {
    platform: row.platform,
    login: row.login,
    displayName: row.display_name,
    profileImageUrl: row.profile_image_url,
    isLive: Boolean(row.is_live),
  };
}

// Kick's channels endpoint has the slug and broadcaster id but not the
// display name/avatar — those come from the users endpoint.
async function upsertKickChannels(slugs) {
  const channels = await kick.getChannels(slugs);
  if (!channels.length) return;
  const users = await kick.getUsers(channels.map((c) => c.broadcaster_user_id)).catch(() => []);
  const byId = new Map(users.map((u) => [String(u.user_id), u]));
  for (const c of channels) {
    const user = byId.get(String(c.broadcaster_user_id));
    db.upsertChannel({
      platform: 'kick',
      login: c.slug.toLowerCase(),
      broadcaster_id: String(c.broadcaster_user_id),
      display_name: user?.name || c.slug,
      profile_image_url: user?.profile_picture || null,
    });
  }
}

async function resolveChannel(rawLogin, rawPlatform) {
  const platform = normalizePlatform(rawPlatform);
  if (!platform) return { status: 400, error: 'platform_not_supported' };
  const login = validLogin(platform, rawLogin);
  if (!login) return { status: 404, error: 'channel_not_found' };
  if (config.channelAllowlist.size && !allowlistHas(platform, login)) {
    return { status: 403, error: 'channel_not_allowed' };
  }
  let row = db.getChannel(platform, login);
  if (!row) {
    if (platform === 'kick') {
      await upsertKickChannels([login]);
    } else {
      const users = await getUsers([login]);
      if (users.length) {
        db.upsertChannel({
          platform: 'twitch',
          login,
          broadcaster_id: users[0].id,
          display_name: users[0].display_name,
          profile_image_url: users[0].profile_image_url ?? null,
        });
      }
    }
    row = db.getChannel(platform, login);
    if (!row) return { status: 404, error: 'channel_not_found' };
  }
  return { row };
}

router.get('/api/config', rateLimiter(60), async (req, res) => {
  const { row, status, error } = await resolveChannel(req.query.channel, req.query.platform);
  if (error) return res.status(status).json({ error });
  res.json({ vapidPublicKey, channel: channelJson(row) });
});

router.post('/api/subscribe', rateLimiter(30), async (req, res) => {
  const { channel, platform, subscription } = req.body ?? {};
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)
    || typeof p256dh !== 'string' || !p256dh
    || typeof auth !== 'string' || !auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  const { row, status, error } = await resolveChannel(channel, platform);
  if (error) return res.status(status).json({ error });
  db.addSubscription({
    platform: row.platform,
    channel: row.login,
    endpoint,
    p256dh,
    auth,
    origin: req.headers.origin ?? null,
  });
  res.status(201).json({ ok: true });
  if (db.countSubscriptionsForChannel(row.platform, row.login) === 1) {
    const ensure = row.platform === 'kick'
      ? kickevents.ensureChannelSubscription
      : ensureChannelSubscription;
    ensure(row.login).catch(() => {});
  }
  sendWelcomeIfLive(row, { endpoint, p256dh, auth }).catch((err) =>
    console.warn('[push] welcome check failed:', err.message ?? err));
});

// New subscribers get an immediate notification if the channel is already
// live, so they can see it works. Claim the stream id afterwards so the
// poller doesn't send them the same stream again.
async function sendWelcomeIfLive(channelRow, sub) {
  const stream = await fetchLiveStream(channelRow.platform, channelRow.login);
  if (!stream) return;
  await sendToSubscription(sub, {
    ...liveNotificationPayload(channelRow, stream),
    title: `Notifications are on — ${channelRow.display_name} is live right now!`,
    image: undefined,
  });
  db.claimStream(channelRow.platform, channelRow.login, String(stream.id));
}

router.post('/api/unsubscribe', rateLimiter(30), (req, res) => {
  const { channel, platform: rawPlatform, endpoint } = req.body ?? {};
  const platform = normalizePlatform(rawPlatform);
  const login = platform && validLogin(platform, channel);
  if (!login || typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  db.removeSubscription(platform, login, endpoint);
  res.json({ ok: true, remainingChannelsForEndpoint: db.countChannelsForEndpoint(endpoint) });
});

// Fan-facing: lets a subscriber send themselves one test push. Knowing the
// (unguessable) endpoint URL is proof of ownership; a per-endpoint cooldown
// keeps it from becoming a spam vector.
const testCooldown = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, at] of testCooldown) if (now - at > 60_000) testCooldown.delete(key);
}, 60_000).unref();

router.post('/api/test-notification', rateLimiter(10), async (req, res) => {
  const { channel, platform: rawPlatform, endpoint } = req.body ?? {};
  const platform = normalizePlatform(rawPlatform);
  const login = platform && validLogin(platform, channel);
  if (!login || typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const sub = db.getSubscription(platform, login, endpoint);
  if (!sub) return res.status(404).json({ error: 'subscription_not_found' });
  const last = testCooldown.get(endpoint) ?? 0;
  if (Date.now() - last < 30_000) return res.status(429).json({ error: 'rate_limited' });
  testCooldown.set(endpoint, Date.now());

  const row = db.getChannel(platform, login);
  const result = await sendToSubscription(sub, {
    title: 'This is your test notification 🔔',
    body: `Notifications for ${row.display_name} are working.`,
    icon: row.profile_image_url || undefined,
    url: PLATFORMS[platform].channelUrl(login),
    tag: `twn-test-${platform}-${login}`,
  });
  res.json({ ok: result === 'sent', result });
});

// Viewer-facing: search channels to subscribe to. Twitch has a fuzzy search
// API; Kick's public API has none, so a query that looks like a slug is tried
// as an exact match. Results are filtered by the allowlist so viewers only
// see channels this instance will watch.
router.get('/api/search', rateLimiter(20), async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || q.length > 50) return res.json({ channels: [] });
  const platform = String(req.query.platform ?? '').trim().toLowerCase() || null;
  const channels = [];

  if (config.kickEnabled && (platform === 'kick' || !platform)) {
    const slug = q.toLowerCase();
    if (PLATFORMS.kick.loginRe.test(slug)
      && (!config.channelAllowlist.size || allowlistHas('kick', slug))) {
      const { row } = await resolveChannel(slug, 'kick').catch(() => ({}));
      if (row) channels.push(channelJson(row));
    }
  }

  if (platform === 'twitch' || !platform) {
    const results = await searchChannels(q, 10).catch(() => []);
    const allowed = config.channelAllowlist.size
      ? results.filter((c) => allowlistHas('twitch', c.broadcaster_login.toLowerCase()))
      : results;
    // Twitch ranks fuzzily; an exact login match belongs on top.
    const qLower = q.toLowerCase();
    allowed.sort((a, b) =>
      (b.broadcaster_login.toLowerCase() === qLower) - (a.broadcaster_login.toLowerCase() === qLower));
    channels.push(...allowed.slice(0, 8).map((c) => ({
      platform: 'twitch',
      login: c.broadcaster_login.toLowerCase(),
      displayName: c.display_name,
      profileImageUrl: c.thumbnail_url || null,
      isLive: Boolean(c.is_live),
    })));
  }

  res.json({ channels });
});

// Viewer-facing: on allowlisted instances, the watchable channels as a
// browsable list (search alone would mostly return channels we'd refuse).
router.get('/api/directory', rateLimiter(30), async (req, res) => {
  if (!config.channelAllowlist.size) return res.json({ restricted: false, channels: [] });
  const entries = [...config.channelAllowlist].slice(0, 50)
    .map((entry) => {
      const [platform, login] = entry.split(':');
      return platformEnabledEntry(platform, login);
    })
    .filter(Boolean);

  const missing = entries.filter(({ platform, login }) => !db.getChannel(platform, login));
  const missingTwitch = missing.filter((e) => e.platform === 'twitch').map((e) => e.login);
  const missingKick = missing.filter((e) => e.platform === 'kick').map((e) => e.login);
  if (missingTwitch.length) {
    const users = await getUsers(missingTwitch).catch(() => []);
    for (const user of users) {
      db.upsertChannel({
        platform: 'twitch',
        login: user.login.toLowerCase(),
        broadcaster_id: user.id,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url ?? null,
      });
    }
  }
  if (missingKick.length) await upsertKickChannels(missingKick).catch(() => {});

  res.json({
    restricted: true,
    channels: entries
      .map(({ platform, login }) => db.getChannel(platform, login))
      .filter(Boolean)
      .map(channelJson),
  });
});

function platformEnabledEntry(platform, login) {
  if (!(platform in PLATFORMS)) return null;
  if (platform === 'kick' && !config.kickEnabled) return null;
  return PLATFORMS[platform].loginRe.test(login) ? { platform, login } : null;
}

// Viewer-facing: everything this browser is subscribed to. Same trust model
// as /api/test-notification — knowing the unguessable endpoint URL is proof
// of ownership. POST keeps the endpoint out of URLs and access logs.
router.post('/api/my-subscriptions', rateLimiter(30), (req, res) => {
  const { endpoint } = req.body ?? {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  res.json({ channels: db.channelsForEndpoint(endpoint).map(channelJson) });
});

router.post('/api/eventsub/callback', callbackHandler);
router.post('/api/kick/callback', kickevents.callbackHandler);

router.get('/api/admin/stats', (req, res) => {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const channels = db.channelsWithCounts().map((c) => ({
    platform: c.platform,
    login: c.login,
    displayName: c.display_name,
    isLive: Boolean(c.is_live),
    subscribers: c.subscribers,
    lastStreamId: c.last_stream_id,
    lastNotifiedAt: c.last_notified_at,
    createdAt: c.created_at,
  }));
  res.json({
    totals: { channels: channels.length, subscriptions: db.countAllSubscriptions() },
    eventsub: eventsubStatus,
    kickEvents: kickevents.kickEventsStatus,
    pollIntervalSeconds: config.pollIntervalSeconds,
    channels,
  });
});

router.post('/api/test/notify', async (req, res) => {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { row, status, error } = await resolveChannel(req.body?.channel, req.body?.platform);
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

router.get('/my', (req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(publicDir, 'my.html'));
});

router.get('/faq', (req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(publicDir, 'faq.html'));
});

router.get('/admin', (req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(publicDir, 'admin.html'));
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

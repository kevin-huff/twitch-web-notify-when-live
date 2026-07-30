import crypto from 'node:crypto';
import { config, allowlistHas } from './config.js';
import * as db from './db.js';
import { getStreams, listEventSubSubscriptions, createEventSubSubscription, deleteEventSubSubscription } from './twitch.js';
import { normalizeTwitchStream } from './platforms.js';
import { handleLiveStream } from './poller.js';

const CALLBACK_PATH = '/api/eventsub/callback';

// Twitch requires an HTTPS callback; the poller alone covers plain-HTTP
// self-hosts. EVENTSUB_FORCE exists for local testing against a mock.
export const eventsubEnabled = config.publicBaseUrl.startsWith('https://')
  || process.env.EVENTSUB_FORCE === '1';

let secret = process.env.EVENTSUB_SECRET || db.getKV('eventsub_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  db.setKV('eventsub_secret', secret);
}

export const eventsubStatus = { enabled: eventsubEnabled, active: 0, lastReconcile: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function callbackHandler(req, res) {
  const msgId = req.header('Twitch-Eventsub-Message-Id');
  const timestamp = req.header('Twitch-Eventsub-Message-Timestamp');
  const signature = req.header('Twitch-Eventsub-Message-Signature');
  if (!msgId || !timestamp || !signature || !req.rawBody) return res.sendStatus(403);

  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(msgId + timestamp)
    .update(req.rawBody)
    .digest('hex');
  if (expected.length !== signature.length
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return res.sendStatus(403);
  }

  const type = req.header('Twitch-Eventsub-Message-Type');
  if (type === 'webhook_callback_verification') {
    return res.type('text/plain').send(req.body.challenge);
  }
  if (type === 'revocation') {
    console.warn(`[eventsub] subscription revoked: ${req.body.subscription?.status} (poller still covers this channel)`);
    return res.sendStatus(204);
  }
  res.sendStatus(204);
  if (type === 'notification' && req.body.subscription?.type === 'stream.online') {
    handleOnline(req.body.event).catch((err) =>
      console.error('[eventsub] online handler failed:', err.message ?? err));
  }
}

async function handleOnline(event) {
  const login = String(event?.broadcaster_user_login ?? '').toLowerCase();
  const row = db.getChannel('twitch', login);
  if (!row) return;
  if (config.channelAllowlist.size && !allowlistHas('twitch', login)) return;

  // stream.online carries no title/category/thumbnail — fetch them, with one
  // retry because Get Streams can lag a few seconds behind the event.
  let stream = null;
  for (let attempt = 0; attempt < 2 && !stream; attempt++) {
    if (attempt) await sleep(7000);
    [stream] = await getStreams([login]).catch(() => []);
  }
  stream = stream
    ? normalizeTwitchStream(stream)
    : { id: event.id, title: '', game_name: '', thumbnail_url: null };

  const result = await handleLiveStream(row, stream);
  if (!result.deduped) {
    console.log(`[eventsub] ${login} went live (stream ${stream.id}): sent=${result.sent} pruned=${result.pruned}`);
  }
}

export async function ensureChannelSubscription(login) {
  if (!eventsubEnabled) return;
  const row = db.getChannel('twitch', login);
  if (!row) return;
  try {
    await createEventSubSubscription(row.broadcaster_id, config.publicBaseUrl + CALLBACK_PATH, secret);
    eventsubStatus.active += 1;
  } catch (err) {
    console.warn(`[eventsub] could not subscribe ${login}:`, err.message ?? err);
  }
}

const KEEP_STATUSES = new Set(['enabled', 'webhook_callback_verification_pending']);

export async function reconcile() {
  if (!eventsubEnabled) {
    console.log('[eventsub] disabled (PUBLIC_BASE_URL is not HTTPS) — using poller only');
    return;
  }
  try {
    const callback = config.publicBaseUrl + CALLBACK_PATH;
    let subscribed = db.distinctSubscribedChannels().filter((s) => s.platform === 'twitch');
    if (config.channelAllowlist.size) {
      subscribed = subscribed.filter((s) => allowlistHas('twitch', s.channel));
    }
    const wanted = new Set(
      subscribed.map((s) => db.getChannel('twitch', s.channel)?.broadcaster_id).filter(Boolean));

    let active = 0;
    for (const sub of await listEventSubSubscriptions()) {
      if (sub.type !== 'stream.online' || sub.transport?.callback !== callback) continue;
      const broadcasterId = sub.condition?.broadcaster_user_id;
      if (KEEP_STATUSES.has(sub.status) && wanted.has(broadcasterId)) {
        wanted.delete(broadcasterId);
        active++;
      } else {
        await deleteEventSubSubscription(sub.id).catch(() => {});
      }
    }
    for (const broadcasterId of wanted) {
      await createEventSubSubscription(broadcasterId, callback, secret);
      active++;
    }
    eventsubStatus.active = active;
    eventsubStatus.lastReconcile = new Date().toISOString();
    console.log(`[eventsub] reconciled: ${active} active subscription(s)`);
  } catch (err) {
    console.warn('[eventsub] reconcile failed (poller still active):', err.message ?? err);
  }
}

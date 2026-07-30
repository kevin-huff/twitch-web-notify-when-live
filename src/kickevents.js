import crypto from 'node:crypto';
import { config, allowlistHas } from './config.js';
import * as db from './db.js';
import * as kick from './kick.js';
import { kickStreamId, fetchLiveStream } from './platforms.js';
import { handleLiveStream } from './poller.js';

export const CALLBACK_PATH = '/api/kick/callback';

// Kick delivers webhooks to the callback URL registered in the app's dev
// dashboard (not per subscription), so all we can do is ask for events.
export const kickEventsEnabled = config.kickEnabled
  && (config.publicBaseUrl.startsWith('https://') || process.env.KICK_EVENTS_FORCE === '1');

// Kick signs webhooks with this published key (docs.kick.com/events/webhook-security);
// also served at /public/v1/public-key, which reconcile() uses to stay current.
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

let publicKey = process.env.KICK_PUBLIC_KEY || DEFAULT_PUBLIC_KEY;

export const kickEventsStatus = { enabled: kickEventsEnabled, active: 0, lastReconcile: null };

const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const seenMessageIds = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, at] of seenMessageIds) if (now - at > TIMESTAMP_TOLERANCE_MS) seenMessageIds.delete(id);
}, 60_000).unref();

export function callbackHandler(req, res) {
  const msgId = req.header('Kick-Event-Message-Id');
  const timestamp = req.header('Kick-Event-Message-Timestamp');
  const signature = req.header('Kick-Event-Signature');
  if (!msgId || !timestamp || !signature || !req.rawBody) return res.sendStatus(403);

  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > TIMESTAMP_TOLERANCE_MS) {
    return res.sendStatus(403);
  }

  // Signature covers `messageId.timestamp.body`, RSA-SHA256, base64.
  const signed = Buffer.concat([Buffer.from(`${msgId}.${timestamp}.`), req.rawBody]);
  let valid = false;
  try {
    valid = crypto.verify('RSA-SHA256', signed, publicKey, Buffer.from(signature, 'base64'));
  } catch { /* malformed signature/key */ }
  if (!valid) return res.sendStatus(403);

  if (seenMessageIds.has(msgId)) return res.sendStatus(200);
  seenMessageIds.set(msgId, Date.now());

  res.sendStatus(200);
  if (req.header('Kick-Event-Type') === 'livestream.status.updated') {
    handleStatusUpdate(req.body).catch((err) =>
      console.error('[kick-events] status handler failed:', err.message ?? err));
  }
}

async function handleStatusUpdate(event) {
  const login = String(event?.broadcaster?.channel_slug ?? '').toLowerCase();
  const row = db.getChannel('kick', login);
  if (!row) return;
  if (config.channelAllowlist.size && !allowlistHas('kick', login)) return;

  if (!event.is_live) {
    db.setLive('kick', login, false);
    console.log(`[kick-events] ${login} went offline`);
    return;
  }

  // The webhook payload has no category/thumbnail — enrich from the channels
  // endpoint, falling back to what the event carries.
  let stream = await fetchLiveStream('kick', login).catch(() => null);
  if (!stream) {
    stream = { id: kickStreamId(event.started_at), title: event.title ?? '', game_name: '', thumbnail_url: null };
  }

  const result = await handleLiveStream(row, stream);
  if (!result.deduped) {
    console.log(`[kick-events] ${login} went live (stream ${stream.id}): sent=${result.sent} pruned=${result.pruned}`);
  }
}

export async function ensureChannelSubscription(login) {
  if (!kickEventsEnabled) return;
  const row = db.getChannel('kick', login);
  if (!row) return;
  try {
    await kick.createEventSubscription(row.broadcaster_id);
    kickEventsStatus.active += 1;
  } catch (err) {
    console.warn(`[kick-events] could not subscribe ${login}:`, err.message ?? err);
  }
}

export async function reconcile() {
  if (!config.kickEnabled) return;
  if (!kickEventsEnabled) {
    console.log('[kick-events] disabled (PUBLIC_BASE_URL is not HTTPS) — using poller only');
    return;
  }
  console.log(`[kick-events] make sure your Kick app's webhook URL is set to ${config.publicBaseUrl}${CALLBACK_PATH}`);
  try {
    const fresh = await kick.getPublicKey().catch(() => null);
    if (fresh) publicKey = fresh;

    let subscribed = db.distinctSubscribedChannels().filter((s) => s.platform === 'kick');
    if (config.channelAllowlist.size) {
      subscribed = subscribed.filter((s) => allowlistHas('kick', s.channel));
    }
    const wanted = new Set(
      subscribed.map((s) => db.getChannel('kick', s.channel)?.broadcaster_id).filter(Boolean));

    let active = 0;
    for (const sub of await kick.listEventSubscriptions()) {
      if (sub.event !== 'livestream.status.updated') continue;
      const broadcasterId = String(sub.broadcaster_user_id);
      if (wanted.has(broadcasterId)) {
        wanted.delete(broadcasterId);
        active++;
      } else {
        await kick.deleteEventSubscription(sub.id).catch(() => {});
      }
    }
    for (const broadcasterId of wanted) {
      await kick.createEventSubscription(broadcasterId);
      active++;
    }
    kickEventsStatus.active = active;
    kickEventsStatus.lastReconcile = new Date().toISOString();
    console.log(`[kick-events] reconciled: ${active} active subscription(s)`);
  } catch (err) {
    console.warn('[kick-events] reconcile failed (poller still active):', err.message ?? err);
  }
}

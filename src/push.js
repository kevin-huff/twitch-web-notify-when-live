import webpush from 'web-push';
import { config } from './config.js';
import { getKV, setKV, subscriptionsForChannel, deleteEndpointEverywhere } from './db.js';

let publicKey = getKV('vapid_public_key');
let privateKey = getKV('vapid_private_key');
if (!publicKey || !privateKey) {
  ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
  setKV('vapid_public_key', publicKey);
  setKV('vapid_private_key', privateKey);
  console.log('[push] generated new VAPID keypair (persisted in DB)');
}
webpush.setVapidDetails(config.vapidSubject, publicKey, privateKey);

export const vapidPublicKey = publicKey;

const SEND_CHUNK = 50;

export async function sendToChannel(login, payloadObj) {
  const subs = subscriptionsForChannel(login);
  const payload = JSON.stringify(payloadObj);
  let sent = 0;
  let pruned = 0;

  for (let i = 0; i < subs.length; i += SEND_CHUNK) {
    const results = await Promise.allSettled(
      subs.slice(i, i + SEND_CHUNK).map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 3600 },
        ),
      ),
    );
    results.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        sent++;
        return;
      }
      const status = result.reason?.statusCode;
      if (status === 404 || status === 410) {
        deleteEndpointEverywhere(subs[i + j].endpoint);
        pruned++;
      } else {
        console.warn(`[push] send failed for ${login}: ${status ?? result.reason}`);
      }
    });
  }
  return { sent, pruned };
}

export async function sendToSubscription(sub, payloadObj) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payloadObj),
      { TTL: 3600 },
    );
    return 'sent';
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      deleteEndpointEverywhere(sub.endpoint);
      return 'pruned';
    }
    console.warn(`[push] single send failed: ${err?.statusCode ?? err}`);
    return 'failed';
  }
}

export async function notifyChannelLive(channelRow, stream) {
  const payload = {
    title: `${channelRow.display_name} is live!`,
    body: stream.title
      ? stream.game_name ? `${stream.title} — ${stream.game_name}` : stream.title
      : 'Streaming now on Twitch',
    icon: channelRow.profile_image_url || undefined,
    image: stream.thumbnail_url
      ? stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360')
      : undefined,
    url: `https://twitch.tv/${channelRow.login}`,
    tag: `twn-${channelRow.login}-${stream.id}`,
  };
  return sendToChannel(channelRow.login, payload);
}

import { config } from './config.js';
import * as db from './db.js';
import { getStreams } from './twitch.js';
import { notifyChannelLive } from './push.js';

export async function handleLiveStream(channelRow, stream) {
  const streamId = String(stream.id);
  if (channelRow.last_stream_id === streamId) {
    db.setLive(channelRow.login, true);
    return { sent: 0, pruned: 0, deduped: true };
  }
  const result = await notifyChannelLive(channelRow, stream);
  db.markNotified(channelRow.login, streamId);
  return { ...result, deduped: false };
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let logins = db.distinctSubscribedChannels();
    if (config.channelAllowlist.size) {
      logins = logins.filter((l) => config.channelAllowlist.has(l));
    }
    if (!logins.length) return;

    const streams = await getStreams(logins);
    const liveByLogin = new Map(streams.map((s) => [s.user_login.toLowerCase(), s]));

    for (const login of logins) {
      const row = db.getChannel(login);
      if (!row) continue;
      const stream = liveByLogin.get(login);
      if (stream) {
        const r = await handleLiveStream(row, stream);
        if (!r.deduped) {
          console.log(`[poller] ${login} went live (stream ${stream.id}): sent=${r.sent} pruned=${r.pruned}`);
        }
      } else if (row.is_live) {
        db.setLive(login, false);
        console.log(`[poller] ${login} went offline`);
      }
    }
  } catch (err) {
    console.error('[poller] tick failed:', err.message ?? err);
  } finally {
    ticking = false;
  }
}

export function startPoller() {
  tick();
  setInterval(tick, config.pollIntervalSeconds * 1000);
  console.log(`[poller] polling every ${config.pollIntervalSeconds}s`);
}

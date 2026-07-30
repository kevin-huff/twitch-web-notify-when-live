import { config, allowlistHas } from './config.js';
import * as db from './db.js';
import { getStreams } from './twitch.js';
import * as kick from './kick.js';
import { normalizeTwitchStream, normalizeKickChannel } from './platforms.js';
import { notifyChannelLive } from './push.js';

export async function handleLiveStream(channelRow, stream) {
  const streamId = String(stream.id);
  // Atomic claim: the WHERE clause is the dedupe check, so it operates on the
  // latest committed state even if channelRow was read stale.
  const claimed = db.claimStream(channelRow.platform, channelRow.login, streamId);
  if (!claimed) {
    if (channelRow.last_stream_id !== streamId) {
      console.warn(`[poller] stale read caught for ${channelRow.platform}:${channelRow.login}: row had ${channelRow.last_stream_id}, DB already claimed ${streamId}`);
    }
    db.setLive(channelRow.platform, channelRow.login, true);
    return { sent: 0, pruned: 0, deduped: true };
  }
  const result = await notifyChannelLive(channelRow, stream);
  return { ...result, deduped: false };
}

// Per-platform batch live lookups, each returning Map<login, normalized stream>.
const fetchers = {
  async twitch(logins) {
    const streams = await getStreams(logins);
    return new Map(streams.map((s) => [s.user_login.toLowerCase(), normalizeTwitchStream(s)]));
  },
  async kick(logins) {
    const channels = await kick.getChannels(logins);
    return new Map(channels
      .filter((c) => c.stream?.is_live)
      .map((c) => [c.slug.toLowerCase(), normalizeKickChannel(c)]));
  },
};

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let subscribed = db.distinctSubscribedChannels();
    if (config.channelAllowlist.size) {
      subscribed = subscribed.filter((s) => allowlistHas(s.platform, s.channel));
    }

    for (const [platform, fetchLive] of Object.entries(fetchers)) {
      if (platform === 'kick' && !config.kickEnabled) continue;
      const logins = subscribed.filter((s) => s.platform === platform).map((s) => s.channel);
      if (!logins.length) continue;

      let liveByLogin;
      try {
        liveByLogin = await fetchLive(logins);
      } catch (err) {
        console.error(`[poller] ${platform} fetch failed:`, err.message ?? err);
        continue;
      }

      for (const login of logins) {
        const row = db.getChannel(platform, login);
        if (!row) continue;
        const stream = liveByLogin.get(login);
        if (stream) {
          const r = await handleLiveStream(row, stream);
          if (!r.deduped) {
            console.log(`[poller] ${platform}:${login} went live (stream ${stream.id}): sent=${r.sent} pruned=${r.pruned}`);
          }
        } else if (row.is_live) {
          db.setLive(platform, login, false);
          console.log(`[poller] ${platform}:${login} went offline`);
        }
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

import { config } from './config.js';
import * as twitch from './twitch.js';
import * as kick from './kick.js';

export const PLATFORMS = {
  twitch: {
    name: 'Twitch',
    loginRe: /^[a-z0-9_]{3,25}$/,
    channelUrl: (login) => `https://twitch.tv/${login}`,
  },
  kick: {
    name: 'Kick',
    loginRe: /^[a-z0-9_-]{3,25}$/,
    channelUrl: (login) => `https://kick.com/${login}`,
  },
};

export function platformEnabled(platform) {
  if (!(platform in PLATFORMS)) return false;
  return platform === 'kick' ? config.kickEnabled : true;
}

// Returns the canonical platform id, or null for unknown/disabled ones.
// Absent means twitch so pre-Kick clients keep working.
export function normalizePlatform(raw) {
  const platform = String(raw ?? 'twitch').trim().toLowerCase() || 'twitch';
  return platformEnabled(platform) ? platform : null;
}

// Internal stream shape both platforms are normalized to:
// { id, title, game_name, thumbnail_url } with a concrete thumbnail URL.
export function normalizeTwitchStream(s) {
  return {
    id: String(s.id),
    title: s.title ?? '',
    game_name: s.game_name ?? '',
    thumbnail_url: s.thumbnail_url
      ? s.thumbnail_url.replace('{width}', '640').replace('{height}', '360')
      : null,
  };
}

// Kick has no stream id in its API or webhook payloads; the stream's start
// time (as epoch seconds) is the stable per-broadcast identifier used for
// dedupe across the poller and webhooks.
export function kickStreamId(startedAt) {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? String(Math.floor(t / 1000)) : String(startedAt);
}

export function normalizeKickChannel(c) {
  return {
    id: kickStreamId(c.stream?.start_time),
    title: c.stream_title ?? '',
    game_name: c.category?.name ?? '',
    thumbnail_url: c.stream?.thumbnail || null,
  };
}

// Live check for a single channel, normalized; null when offline.
export async function fetchLiveStream(platform, login) {
  if (platform === 'kick') {
    const [channel] = await kick.getChannels([login]);
    return channel?.stream?.is_live ? normalizeKickChannel(channel) : null;
  }
  const [stream] = await twitch.getStreams([login]);
  return stream ? normalizeTwitchStream(stream) : null;
}

export function liveNotificationPayload(channelRow, stream) {
  const platform = PLATFORMS[channelRow.platform] ?? PLATFORMS.twitch;
  return {
    title: `${channelRow.display_name} is live!`,
    body: stream.title
      ? stream.game_name ? `${stream.title} — ${stream.game_name}` : stream.title
      : `Streaming now on ${platform.name}`,
    icon: channelRow.profile_image_url || undefined,
    image: stream.thumbnail_url || undefined,
    url: platform.channelUrl(channelRow.login),
    tag: `twn-${channelRow.platform}-${channelRow.login}-${stream.id}`,
  };
}

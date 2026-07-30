function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

function csvSet(name, { lowercase = false } = {}) {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((s) => (lowercase ? s.trim().toLowerCase() : s.trim()))
      .filter(Boolean),
  );
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL
  ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
if (!publicBaseUrl) required('PUBLIC_BASE_URL');

// Allowlist entries are `login` (Twitch, back-compat) or `platform:login`.
// Stored normalized as `platform:login`.
const channelAllowlist = new Set(
  [...csvSet('CHANNEL_ALLOWLIST', { lowercase: true })]
    .map((entry) => (entry.includes(':') ? entry : `twitch:${entry}`)),
);

export const config = {
  twitchClientId: required('TWITCH_CLIENT_ID'),
  twitchClientSecret: required('TWITCH_CLIENT_SECRET'),
  kickClientId: process.env.KICK_CLIENT_ID || null,
  kickClientSecret: process.env.KICK_CLIENT_SECRET || null,
  kickEnabled: Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET),
  publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? 'data/notify.db',
  pollIntervalSeconds: Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS ?? 60)),
  channelAllowlist,
  allowedOrigins: csvSet('ALLOWED_ORIGINS'),
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  adminToken: process.env.ADMIN_TOKEN || null,
  twitchApiBase: (process.env.TWITCH_API_BASE ?? 'https://api.twitch.tv/helix').replace(/\/+$/, ''),
  twitchAuthBase: (process.env.TWITCH_AUTH_BASE ?? 'https://id.twitch.tv').replace(/\/+$/, ''),
  kickApiBase: (process.env.KICK_API_BASE ?? 'https://api.kick.com/public/v1').replace(/\/+$/, ''),
  kickAuthBase: (process.env.KICK_AUTH_BASE ?? 'https://id.kick.com').replace(/\/+$/, ''),
};

export const allowlistHas = (platform, login) =>
  config.channelAllowlist.has(`${platform}:${login}`);

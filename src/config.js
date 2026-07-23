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

export const config = {
  twitchClientId: required('TWITCH_CLIENT_ID'),
  twitchClientSecret: required('TWITCH_CLIENT_SECRET'),
  publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? 'data/notify.db',
  pollIntervalSeconds: Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS ?? 60)),
  channelAllowlist: csvSet('CHANNEL_ALLOWLIST', { lowercase: true }),
  allowedOrigins: csvSet('ALLOWED_ORIGINS'),
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  adminToken: process.env.ADMIN_TOKEN || null,
  twitchApiBase: (process.env.TWITCH_API_BASE ?? 'https://api.twitch.tv/helix').replace(/\/+$/, ''),
  twitchAuthBase: (process.env.TWITCH_AUTH_BASE ?? 'https://id.twitch.tv').replace(/\/+$/, ''),
};

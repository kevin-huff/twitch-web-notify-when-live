import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channels (
    platform          TEXT NOT NULL DEFAULT 'twitch',
    login             TEXT NOT NULL,
    broadcaster_id    TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    profile_image_url TEXT,
    is_live           INTEGER NOT NULL DEFAULT 0,
    last_stream_id    TEXT,
    last_notified_at  INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (platform, login)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY,
    platform   TEXT NOT NULL DEFAULT 'twitch',
    channel    TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    origin     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (platform, channel, endpoint),
    FOREIGN KEY (platform, channel) REFERENCES channels(platform, login) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(platform, channel);
  CREATE INDEX IF NOT EXISTS idx_subs_endpoint ON subscriptions(endpoint);
`;

// Pre-Kick databases have no platform column and login as the bare primary
// key. SQLite can't alter primary keys, so rebuild both tables in place and
// stamp every existing row as twitch.
const oldSchema = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get()
  && !db.prepare("SELECT 1 FROM pragma_table_info('channels') WHERE name = 'platform'").get();

if (oldSchema) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    DROP INDEX IF EXISTS idx_subs_channel;
    DROP INDEX IF EXISTS idx_subs_endpoint;
    ALTER TABLE channels RENAME TO channels_v1;
    ALTER TABLE subscriptions RENAME TO subscriptions_v1;
    ${SCHEMA}
    INSERT INTO channels (platform, login, broadcaster_id, display_name, profile_image_url,
                          is_live, last_stream_id, last_notified_at, created_at)
      SELECT 'twitch', login, broadcaster_id, display_name, profile_image_url,
             is_live, last_stream_id, last_notified_at, created_at
      FROM channels_v1;
    INSERT INTO subscriptions (id, platform, channel, endpoint, p256dh, auth, origin, created_at)
      SELECT id, 'twitch', channel, endpoint, p256dh, auth, origin, created_at
      FROM subscriptions_v1;
    DROP TABLE subscriptions_v1;
    DROP TABLE channels_v1;
    COMMIT;
  `);
  db.pragma('foreign_keys = ON');
  console.log('[db] migrated to multi-platform schema (existing rows marked twitch)');
} else {
  db.exec(SCHEMA);
}

const stmt = {
  getKV: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKV: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  getChannel: db.prepare('SELECT * FROM channels WHERE platform = ? AND login = ?'),
  upsertChannel: db.prepare(`
    INSERT INTO channels (platform, login, broadcaster_id, display_name, profile_image_url)
    VALUES (@platform, @login, @broadcaster_id, @display_name, @profile_image_url)
    ON CONFLICT(platform, login) DO UPDATE SET
      broadcaster_id = excluded.broadcaster_id,
      display_name = excluded.display_name,
      profile_image_url = excluded.profile_image_url
  `),
  addSubscription: db.prepare(`
    INSERT INTO subscriptions (platform, channel, endpoint, p256dh, auth, origin)
    VALUES (@platform, @channel, @endpoint, @p256dh, @auth, @origin)
    ON CONFLICT(platform, channel, endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      origin = excluded.origin
  `),
  removeSubscription: db.prepare('DELETE FROM subscriptions WHERE platform = ? AND channel = ? AND endpoint = ?'),
  getSubscription: db.prepare('SELECT * FROM subscriptions WHERE platform = ? AND channel = ? AND endpoint = ?'),
  countSubscriptionsForChannel: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE platform = ? AND channel = ?'),
  countAllSubscriptions: db.prepare('SELECT COUNT(*) AS n FROM subscriptions'),
  channelsWithCounts: db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM subscriptions s
                 WHERE s.platform = c.platform AND s.channel = c.login) AS subscribers
    FROM channels c ORDER BY subscribers DESC, c.platform, c.login
  `),
  countChannelsForEndpoint: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE endpoint = ?'),
  channelsForEndpoint: db.prepare(`
    SELECT c.* FROM channels c
    JOIN subscriptions s ON s.platform = c.platform AND s.channel = c.login
    WHERE s.endpoint = ?
    ORDER BY c.display_name COLLATE NOCASE
  `),
  subscriptionsForChannel: db.prepare('SELECT * FROM subscriptions WHERE platform = ? AND channel = ?'),
  deleteEndpointEverywhere: db.prepare('DELETE FROM subscriptions WHERE endpoint = ?'),
  distinctSubscribedChannels: db.prepare('SELECT DISTINCT platform, channel FROM subscriptions'),
  claimStream: db.prepare(`
    UPDATE channels SET last_stream_id = @streamId, last_notified_at = unixepoch(), is_live = 1
    WHERE platform = @platform AND login = @login
      AND (last_stream_id IS NULL OR last_stream_id <> @streamId)
  `),
  setLive: db.prepare('UPDATE channels SET is_live = ? WHERE platform = ? AND login = ?'),
};

export const getKV = (key) => stmt.getKV.get(key)?.value ?? null;
export const setKV = (key, value) => stmt.setKV.run(key, value);
export const getChannel = (platform, login) => stmt.getChannel.get(platform, login);
export const upsertChannel = (channel) => stmt.upsertChannel.run(channel);
export const addSubscription = (sub) => stmt.addSubscription.run(sub);
export const removeSubscription = (platform, channel, endpoint) => stmt.removeSubscription.run(platform, channel, endpoint);
export const getSubscription = (platform, channel, endpoint) => stmt.getSubscription.get(platform, channel, endpoint);
export const countSubscriptionsForChannel = (platform, channel) => stmt.countSubscriptionsForChannel.get(platform, channel).n;
export const countAllSubscriptions = () => stmt.countAllSubscriptions.get().n;
export const channelsWithCounts = () => stmt.channelsWithCounts.all();
export const countChannelsForEndpoint = (endpoint) => stmt.countChannelsForEndpoint.get(endpoint).n;
export const channelsForEndpoint = (endpoint) => stmt.channelsForEndpoint.all(endpoint);
export const subscriptionsForChannel = (platform, channel) => stmt.subscriptionsForChannel.all(platform, channel);
export const deleteEndpointEverywhere = (endpoint) => stmt.deleteEndpointEverywhere.run(endpoint);
export const distinctSubscribedChannels = () => stmt.distinctSubscribedChannels.all();
export const claimStream = (platform, login, streamId) => stmt.claimStream.run({ platform, login, streamId }).changes === 1;
export const setLive = (platform, login, live) => stmt.setLive.run(live ? 1 : 0, platform, login);

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

  CREATE TABLE IF NOT EXISTS channels (
    login             TEXT PRIMARY KEY,
    broadcaster_id    TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    profile_image_url TEXT,
    is_live           INTEGER NOT NULL DEFAULT 0,
    last_stream_id    TEXT,
    last_notified_at  INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY,
    channel    TEXT NOT NULL REFERENCES channels(login) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    origin     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (channel, endpoint)
  );
  CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(channel);
  CREATE INDEX IF NOT EXISTS idx_subs_endpoint ON subscriptions(endpoint);
`);

const stmt = {
  getKV: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKV: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  getChannel: db.prepare('SELECT * FROM channels WHERE login = ?'),
  upsertChannel: db.prepare(`
    INSERT INTO channels (login, broadcaster_id, display_name, profile_image_url)
    VALUES (@login, @broadcaster_id, @display_name, @profile_image_url)
    ON CONFLICT(login) DO UPDATE SET
      broadcaster_id = excluded.broadcaster_id,
      display_name = excluded.display_name,
      profile_image_url = excluded.profile_image_url
  `),
  addSubscription: db.prepare(`
    INSERT INTO subscriptions (channel, endpoint, p256dh, auth, origin)
    VALUES (@channel, @endpoint, @p256dh, @auth, @origin)
    ON CONFLICT(channel, endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      origin = excluded.origin
  `),
  removeSubscription: db.prepare('DELETE FROM subscriptions WHERE channel = ? AND endpoint = ?'),
  countChannelsForEndpoint: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE endpoint = ?'),
  subscriptionsForChannel: db.prepare('SELECT * FROM subscriptions WHERE channel = ?'),
  deleteEndpointEverywhere: db.prepare('DELETE FROM subscriptions WHERE endpoint = ?'),
  distinctSubscribedChannels: db.prepare('SELECT DISTINCT channel FROM subscriptions'),
  markNotified: db.prepare("UPDATE channels SET last_stream_id = ?, last_notified_at = unixepoch(), is_live = 1 WHERE login = ?"),
  setLive: db.prepare('UPDATE channels SET is_live = ? WHERE login = ?'),
};

export const getKV = (key) => stmt.getKV.get(key)?.value ?? null;
export const setKV = (key, value) => stmt.setKV.run(key, value);
export const getChannel = (login) => stmt.getChannel.get(login);
export const upsertChannel = (channel) => stmt.upsertChannel.run(channel);
export const addSubscription = (sub) => stmt.addSubscription.run(sub);
export const removeSubscription = (channel, endpoint) => stmt.removeSubscription.run(channel, endpoint);
export const countChannelsForEndpoint = (endpoint) => stmt.countChannelsForEndpoint.get(endpoint).n;
export const subscriptionsForChannel = (channel) => stmt.subscriptionsForChannel.all(channel);
export const deleteEndpointEverywhere = (endpoint) => stmt.deleteEndpointEverywhere.run(endpoint);
export const distinctSubscribedChannels = () => stmt.distinctSubscribedChannels.all().map((r) => r.channel);
export const markNotified = (login, streamId) => stmt.markNotified.run(streamId, login);
export const setLive = (login, live) => stmt.setLive.run(live ? 1 : 0, login);

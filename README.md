# twitch-web-notify-when-live

Self-hostable web push notifications for when a Twitch channel goes live — with a drop-in widget any streamer can paste into their website.

Visitors click a "Notify me when live" button, grant notification permission once, and get a real browser push notification (even with the site closed) the moment the channel goes live. No accounts, no third-party push provider — just this service, your Twitch app credentials, and the browser Push API.

## How it works

- The service polls the Twitch Helix API (default every 60 s) for the channels people have subscribed to. When a channel's stream id changes, it sends a web push ("**SomeChannel is live!** *stream title — category*", click opens the Twitch channel) to every subscriber.
- Push subscriptions are stored in SQLite. VAPID keys are auto-generated on first boot and persisted in the DB — **don't delete the DB casually; rotating VAPID keys orphans every existing subscriber**.
- The widget is a single vanilla-JS file served by this service. No build step, no framework.

## Deploy the service

1. Create a Twitch application at <https://dev.twitch.tv/console/apps> (any OAuth redirect URL — it isn't used; only client credentials are).
2. ```sh
   cp .env.example .env   # fill in TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, PUBLIC_BASE_URL
   docker compose up -d
   ```
3. Put it behind your reverse proxy with TLS. `PUBLIC_BASE_URL` must be the public HTTPS URL (e.g. `https://notify.example.com`) — it's baked into the generated service worker and popup URLs.

Without Docker: Node ≥ 20, `npm install`, `node --env-file=.env src/server.js`.

## Embed the widget

Paste where the button should appear:

```html
<script src="https://notify.example.com/widget.js" data-channel="somechannel" async></script>
```

That's it — the button works immediately using a subscribe popup hosted on the service's domain. Multiple tags with different `data-channel` values on one page are fine. Style it with CSS custom properties on any ancestor: `--twn-bg`, `--twn-color`, `--twn-radius`, `--twn-font`, `--twn-bg-subscribed`.

### Optional: notifications from your own domain

By default, notifications are delivered via the service's domain (the popup flow). If you want them to come from **your** site's domain and skip the popup, download `https://notify.example.com/sw.js` and put it at your site's root (it must be reachable at `https://yoursite.com/sw.js`). It's one line:

```js
importScripts('https://notify.example.com/sw-core.js');
```

The widget detects it automatically and subscribes visitors right on your site.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | yes | — | App token via client credentials |
| `PUBLIC_BASE_URL` | yes | — | Public HTTPS URL of this service |
| `PORT` | no | `8080` | Listen port |
| `DB_PATH` | no | `data/notify.db` (`/data/notify.db` in Docker) | SQLite location |
| `POLL_INTERVAL_SECONDS` | no | `60` | Twitch poll cadence (min 10) |
| `CHANNEL_ALLOWLIST` | no | *(any)* | Comma-separated logins this instance will watch. **Recommended in production** — otherwise anyone can make your instance poll arbitrary channels |
| `ALLOWED_ORIGINS` | no | *(open CORS)* | Comma-separated origins allowed to call the API |
| `VAPID_SUBJECT` | no | `mailto:admin@example.com` | Contact for push services |
| `ADMIN_TOKEN` | no | *(off)* | Enables `POST /api/test/notify` |

## Testing without going live

With `ADMIN_TOKEN` set, fire the real notification path with a synthetic stream:

```sh
curl -X POST "$PUBLIC_BASE_URL/api/test/notify" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"somechannel","title":"Testing!"}'
# → {"ok":true,"sent":1,"pruned":0,"deduped":false}
```

Local development works without TLS (localhost is a secure browser context): run the service on `:8080`, serve a test page containing the embed snippet from another port, and subscribe from there.

## Limitations

- **iOS Safari**: Apple only allows web push for sites added to the Home Screen. The subscribe popup shows a hint; there is nothing a website can do beyond that.
- The widget needs HTTPS (or localhost) on the embedding page — on plain HTTP it shows a disabled "unsupported" button.
- Going-live detection is polling-based, so notifications arrive up to `POLL_INTERVAL_SECONDS` after the stream starts. Twitch EventSub support is a planned follow-up.

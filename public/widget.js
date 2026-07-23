(() => {
  const script = document.currentScript;
  if (!script) return;

  const channel = (script.dataset.channel || '').trim().toLowerCase();
  if (!channel) {
    console.warn('[twitch-notify] widget script tag is missing data-channel');
    return;
  }

  const base = script.src.replace(/\/widget\.js(\?.*)?$/, '');
  const serviceOrigin = new URL(script.src).origin;
  const lsKey = 'twn:sub:' + channel;

  const LABELS = {
    default: 'Notify me when live',
    working: 'Working…',
    subscribed: "✓ You'll be notified",
    blocked: 'Notifications blocked',
    unsupported: 'Notifications unsupported',
  };

  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';

  if (!document.getElementById('twn-style')) {
    const style = document.createElement('style');
    style.id = 'twn-style';
    style.textContent = [
      '.twn-btn{display:inline-flex;align-items:center;gap:.5em;padding:.6em 1.1em;border:0;cursor:pointer;',
      'background:var(--twn-bg,#9146ff);color:var(--twn-color,#fff);border-radius:var(--twn-radius,8px);',
      'font:var(--twn-font,600 14px/1.2 system-ui,sans-serif);transition:filter .15s,background .15s}',
      '.twn-btn:hover:not(:disabled){filter:brightness(1.1)}',
      '.twn-btn:disabled{opacity:.6;cursor:not-allowed}',
      '.twn-btn[data-state="subscribed"]{background:var(--twn-bg-subscribed,#00a86b)}',
      '.twn-btn svg{width:1.1em;height:1.1em;fill:currentColor;flex:none}',
    ].join('');
    document.head.appendChild(style);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'twn-btn';
  const label = document.createElement('span');
  btn.innerHTML = BELL;
  btn.appendChild(label);
  script.insertAdjacentElement('beforebegin', btn);

  function setState(state, title) {
    btn.dataset.state = state;
    label.textContent = LABELS[state];
    btn.disabled = state === 'working' || state === 'blocked' || state === 'unsupported';
    btn.title = title || '';
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

  async function subscribeSameOrigin(reg, cfg) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setState(permission === 'denied' ? 'blocked' : 'default',
        permission === 'denied' ? 'Notifications are blocked in your browser settings for this site' : '');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
    });
    const res = await fetch(base + '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, subscription: sub.toJSON() }),
    });
    if (!res.ok) throw new Error('subscribe failed: ' + res.status);
    localStorage.setItem(lsKey, '1');
    setState('subscribed');
  }

  async function unsubscribeSameOrigin(reg) {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const res = await fetch(base + '/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, endpoint: sub.endpoint }),
      });
      const data = await res.json();
      if (data.remainingChannelsForEndpoint === 0) await sub.unsubscribe();
    }
    localStorage.removeItem(lsKey);
    setState('default');
  }

  function openPopup() {
    window.open(
      base + '/subscribe?channel=' + encodeURIComponent(channel),
      'twn-' + channel,
      'width=420,height=560,popup=yes',
    );
  }

  async function boot() {
    if (!supported) {
      setState('unsupported', 'This browser does not support push notifications (or the page is not HTTPS)');
      return;
    }

    setState('working');

    let cfg;
    try {
      const res = await fetch(base + '/api/config?channel=' + encodeURIComponent(channel));
      if (!res.ok) {
        console.warn('[twitch-notify] channel rejected by server:', (await res.json()).error);
        btn.remove();
        return;
      }
      cfg = await res.json();
    } catch (err) {
      console.warn('[twitch-notify] could not reach notification server', err);
      btn.remove();
      return;
    }

    // Probe once (shared across widget tags): does this site host /sw.js?
    // Registering never prompts the user; a rejection (404 / SPA HTML response)
    // means we fall back to the popup on the service origin.
    window.__twnSwProbe ??= navigator.serviceWorker.register('/sw.js').then((r) => r, () => null);
    const reg = await window.__twnSwProbe;

    if (Notification.permission === 'denied') {
      setState('blocked', 'Notifications are blocked in your browser settings for this site');
      return;
    }

    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (!sub) localStorage.removeItem(lsKey);
    }
    setState(localStorage.getItem(lsKey) ? 'subscribed' : 'default');

    window.addEventListener('message', (event) => {
      if (event.origin !== serviceOrigin) return;
      const msg = event.data;
      if (!msg || msg.channel !== channel) return;
      if (msg.type === 'twn:subscribed') {
        localStorage.setItem(lsKey, '1');
        setState('subscribed');
      } else if (msg.type === 'twn:unsubscribed') {
        localStorage.removeItem(lsKey);
        setState('default');
      }
    });

    btn.addEventListener('click', async () => {
      const state = btn.dataset.state;
      if (state !== 'default' && state !== 'subscribed') return;
      if (!reg) {
        // Popup must open synchronously within the click gesture.
        openPopup();
        return;
      }
      setState('working');
      try {
        if (state === 'subscribed') await unsubscribeSameOrigin(reg);
        else await subscribeSameOrigin(reg, cfg);
      } catch (err) {
        console.warn('[twitch-notify]', err);
        setState(state);
      }
    });
  }

  boot();
})();

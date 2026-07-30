(() => {
  const params = new URLSearchParams(location.search);
  const channel = (params.get('channel') || '').trim().toLowerCase();
  const platform = (params.get('platform') || 'twitch').trim().toLowerCase();
  const platformName = platform === 'kick' ? 'Kick' : 'Twitch';
  // Twitch keys keep their pre-Kick format so existing subscriptions stay recognized.
  const lsKey = 'twn:sub:' + (platform === 'kick' ? 'kick:' + channel : channel);

  const el = {
    avatar: document.getElementById('avatar'),
    title: document.getElementById('title'),
    desc: document.getElementById('desc'),
    action: document.getElementById('action'),
    test: document.getElementById('test'),
    hint: document.getElementById('hint'),
  };

  function fail(message) {
    el.title.textContent = 'Something went wrong';
    el.desc.textContent = message;
  }

  function hint(message) {
    el.hint.textContent = message;
    el.hint.classList.remove('hidden');
  }

  function notifyOpener(type) {
    if (window.opener) window.opener.postMessage({ type, channel, platform }, '*');
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function setButton(subscribed, displayName) {
    el.action.classList.remove('hidden');
    el.action.disabled = false;
    el.action.classList.toggle('subscribed', subscribed);
    el.action.textContent = subscribed ? '✓ Subscribed — click to unsubscribe' : 'Notify me when live';
    el.desc.textContent = subscribed
      ? `You'll get a notification when ${displayName} goes live.`
      : `Get a browser notification when ${displayName} goes live on ${platformName}.`;
    el.test.classList.toggle('hidden', !subscribed);
  }

  async function main() {
    if (!channel) return fail('No channel specified.');

    const res = await fetch('/api/config?channel=' + encodeURIComponent(channel)
      + '&platform=' + encodeURIComponent(platform));
    if (!res.ok) return fail('Channel not found or not allowed on this server.');
    const cfg = await res.json();

    el.title.textContent = cfg.channel.displayName;
    if (cfg.channel.profileImageUrl) {
      el.avatar.src = cfg.channel.profileImageUrl;
      el.avatar.style.display = 'inline-block';
    }

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      el.desc.textContent = 'This browser does not support push notifications.';
      if (isIos) hint('On iPhone/iPad: notifications only work after adding this site to your Home Screen (Share → Add to Home Screen), then opening it from there.');
      return;
    }

    const reg = await navigator.serviceWorker.register('/sw.js');
    const existing = await reg.pushManager.getSubscription();
    let subscribed = Boolean(existing && localStorage.getItem(lsKey));
    setButton(subscribed, cfg.channel.displayName);

    if (Notification.permission === 'denied') {
      el.action.disabled = true;
      el.action.textContent = 'Notifications blocked';
      hint('Notifications are blocked for this site. Allow them in your browser settings, then reload.');
      return;
    }

    el.test.addEventListener('click', async () => {
      el.test.disabled = true;
      el.test.textContent = 'Sending…';
      try {
        const sub = await reg.pushManager.getSubscription();
        if (!sub) throw new Error('no subscription');
        const r = await fetch('/api/test-notification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, platform, endpoint: sub.endpoint }),
        });
        const data = await r.json();
        el.test.textContent = data.ok ? 'Sent — check your notifications' : 'Could not send. Try again in a moment.';
      } catch {
        el.test.textContent = 'Could not send. Try again in a moment.';
      }
      setTimeout(() => {
        el.test.disabled = false;
        el.test.textContent = 'Send a test notification';
      }, 5000);
    });

    el.action.addEventListener('click', async () => {
      el.action.disabled = true;
      try {
        if (subscribed) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            const r = await fetch('/api/unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel, platform, endpoint: sub.endpoint }),
            });
            const data = await r.json();
            if (data.remainingChannelsForEndpoint === 0) await sub.unsubscribe();
          }
          localStorage.removeItem(lsKey);
          subscribed = false;
          notifyOpener('twn:unsubscribed');
          setButton(subscribed, cfg.channel.displayName);
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            el.action.disabled = false;
            if (permission === 'denied') {
              el.action.disabled = true;
              el.action.textContent = 'Notifications blocked';
            }
            return;
          }
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
          });
          const r = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, platform, subscription: sub.toJSON() }),
          });
          if (!r.ok) throw new Error('subscribe failed');
          localStorage.setItem(lsKey, '1');
          subscribed = true;
          notifyOpener('twn:subscribed');
          setButton(subscribed, cfg.channel.displayName);
          if (window.opener) {
            hint('All set! This window will close.');
            setTimeout(() => window.close(), 2000);
          }
        }
      } catch (err) {
        console.warn('[twitch-notify]', err);
        el.action.disabled = false;
        fail('Could not update your subscription. Please try again.');
      }
    });
  }

  main().catch((err) => {
    console.warn('[twitch-notify]', err);
    fail('Could not load channel info.');
  });
})();

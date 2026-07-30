(() => {
  const el = {
    banner: document.getElementById('banner'),
    search: document.getElementById('search'),
    results: document.getElementById('results'),
    directory: document.getElementById('directory'),
    directoryNote: document.getElementById('directory-note'),
    chips: document.getElementById('platform-chips'),
    kickNote: document.getElementById('kick-note'),
    mine: document.getElementById('mine'),
    mineEmpty: document.getElementById('mine-empty'),
  };

  let reg = null;
  let pushSub = null;
  let lastResults = [];
  let directoryChannels = [];
  let directoryFilter = '';
  let searchPlatform = '';
  let kickEnabled = false;
  let mineChannels = [];
  const subscribed = new Set();

  function banner(message) {
    el.banner.textContent = message;
    el.banner.classList.toggle('hidden', !message);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  const key = (c) => (c.platform || 'twitch') + ':' + c.login;
  // Twitch keys keep their pre-Kick format so existing entries stay valid.
  const lsKey = (c) => 'twn:sub:' + (c.platform === 'kick' ? 'kick:' + c.login : c.login);
  const HOSTS = { twitch: 'twitch.tv/', kick: 'kick.com/' };

  function syncLocalStorage() {
    try {
      const keep = new Set(mineChannels.map((c) => lsKey(c)));
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('twn:sub:') && !keep.has(key)) localStorage.removeItem(key);
      }
      for (const key of keep) localStorage.setItem(key, '1');
    } catch { /* sandboxed iframe etc. — state just won't persist */ }
  }

  function channelRow(channel, actions) {
    const li = document.createElement('li');
    li.className = 'row';
    const img = document.createElement('img');
    img.alt = '';
    if (channel.profileImageUrl) img.src = channel.profileImageUrl;
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = channel.displayName;
    if (kickEnabled) {
      const badge = document.createElement('span');
      const p = channel.platform === 'kick' ? 'kick' : 'twitch';
      badge.className = 'platform-badge ' + p;
      badge.textContent = p.toUpperCase();
      name.appendChild(badge);
    }
    if (channel.isLive) {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      dot.textContent = 'LIVE';
      name.appendChild(dot);
    }
    const login = document.createElement('div');
    login.className = 'login';
    login.textContent = (HOSTS[channel.platform] || HOSTS.twitch) + channel.login;
    who.append(name, login);
    li.append(img, who, ...actions);
    return li;
  }

  function addButton(channel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (subscribed.has(key(channel))) {
      btn.className = 'btn-added';
      btn.textContent = '✓ Added';
      btn.disabled = true;
    } else {
      btn.className = 'btn-add';
      btn.textContent = 'Notify me';
      btn.addEventListener('click', () => add(channel, btn));
    }
    return btn;
  }

  function render() {
    el.results.replaceChildren(
      ...lastResults.map((c) => channelRow(c, [addButton(c)])));
    let visibleDirectory = searchPlatform
      ? directoryChannels.filter((c) => (c.platform || 'twitch') === searchPlatform)
      : directoryChannels;
    if (directoryFilter) {
      visibleDirectory = visibleDirectory.filter((c) =>
        c.login.includes(directoryFilter) || c.displayName.toLowerCase().includes(directoryFilter));
    }
    el.directory.replaceChildren(
      ...visibleDirectory.map((c) => channelRow(c, [addButton(c)])));
    el.mine.replaceChildren(...mineChannels.map((c) => {
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'linkish';
      test.textContent = 'Test';
      test.title = 'Send yourself a test notification';
      test.addEventListener('click', () => sendTest(c, test));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeChannel(c, remove));
      return channelRow(c, [test, remove]);
    }));
    el.mineEmpty.classList.toggle('hidden', mineChannels.length > 0);
  }

  async function refreshMine() {
    subscribed.clear();
    mineChannels = [];
    if (pushSub) {
      const res = await fetch('/api/my-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: pushSub.endpoint }),
      });
      if (res.ok) {
        mineChannels = (await res.json()).channels;
        for (const c of mineChannels) subscribed.add(key(c));
      }
    }
    syncLocalStorage();
    render();
  }

  async function add(channel, btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const cfgRes = await fetch('/api/config?channel=' + encodeURIComponent(channel.login)
        + '&platform=' + encodeURIComponent(channel.platform || 'twitch'));
      if (!cfgRes.ok) throw new Error('channel unavailable');
      const cfg = await cfgRes.json();

      if (!pushSub) {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          if (permission === 'denied') {
            banner('Notifications are blocked for this site. Allow them in your browser settings (icon left of the address bar), then reload.');
          }
          render();
          return;
        }
        if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
        pushSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
        });
      }

      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channel.login,
          platform: channel.platform || 'twitch',
          subscription: pushSub.toJSON(),
        }),
      });
      if (!res.ok) throw new Error('subscribe failed');
      banner('');
      await refreshMine();
    } catch (err) {
      console.warn('[twitch-notify]', err);
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }

  async function removeChannel(channel, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channel.login,
          platform: channel.platform || 'twitch',
          endpoint: pushSub.endpoint,
        }),
      });
      const data = await res.json();
      if (data.remainingChannelsForEndpoint === 0) {
        await pushSub.unsubscribe();
        pushSub = null;
      }
      await refreshMine();
    } catch (err) {
      console.warn('[twitch-notify]', err);
      btn.disabled = false;
    }
  }

  async function sendTest(channel, btn) {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/test-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channel.login,
          platform: channel.platform || 'twitch',
          endpoint: pushSub.endpoint,
        }),
      });
      const data = await res.json();
      btn.textContent = data.ok ? 'Sent!' : 'Wait a moment';
    } catch {
      btn.textContent = 'Failed';
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Test';
    }, 5000);
  }

  let searchTimer = null;
  let searchSeq = 0;
  async function runSearch(q) {
    // Allowlisted instance: the input just filters the fixed directory.
    if (directoryChannels.length) {
      directoryFilter = q.toLowerCase();
      return render();
    }
    const seq = ++searchSeq;
    if (q.length < 2) {
      lastResults = [];
      return render();
    }
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q)
        + (searchPlatform ? '&platform=' + encodeURIComponent(searchPlatform) : ''));
      if (!res.ok || seq !== searchSeq) return;
      lastResults = (await res.json()).channels;
      render();
    } catch { /* transient — keep previous results */ }
  }

  async function main() {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      el.search.disabled = true;
      banner(isIos
        ? 'On iPhone/iPad, notifications only work after adding this site to your Home Screen (Share → Add to Home Screen), then opening it from there.'
        : 'This browser does not support push notifications.');
      return;
    }

    // Wire the UI before any push/service-worker work so a slow registration
    // can't leave the page unresponsive.
    el.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = el.search.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 300);
    });

    el.chips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      searchPlatform = chip.dataset.platform;
      for (const c of el.chips.querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
      const kickSearch = searchPlatform === 'kick' && !directoryChannels.length;
      el.kickNote.classList.toggle('hidden', !kickSearch);
      el.search.placeholder = directoryChannels.length
        ? 'Filter channels…'
        : kickSearch ? 'Exact Kick username…' : 'Search channels…';
      runSearch(el.search.value.trim());
    });

    fetch('/api/directory')
      .then((res) => (res.ok ? res.json() : { restricted: false, channels: [] }))
      .then((data) => {
        if (data.platforms?.includes('kick')) {
          kickEnabled = true;
          el.chips.classList.remove('hidden');
          render();
        }
        if (!data.restricted) return;
        directoryChannels = data.channels;
        el.directoryNote.classList.remove('hidden');
        el.search.placeholder = 'Filter channels…';
        render();
      })
      .catch(() => {});

    if (Notification.permission === 'denied') {
      banner('Notifications are blocked for this site. Allow them in your browser settings (icon left of the address bar), then reload.');
    }

    reg = await navigator.serviceWorker.register('/sw.js');
    pushSub = await reg.pushManager.getSubscription();
    await refreshMine();
  }

  main().catch((err) => {
    console.warn('[twitch-notify]', err);
    banner('Something went wrong loading this page. Please refresh and try again.');
  });
})();

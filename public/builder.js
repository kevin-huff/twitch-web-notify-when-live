(() => {
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
  const DEFAULTS = { label: 'Notify me when live', labelSubscribed: "✓ You'll be notified", bgSubscribed: '#00a86b', radius: '8' };
  // The widget's built-in defaults per platform — colors matching these are
  // omitted from the snippet.
  const PLATFORM_COLORS = {
    twitch: { bg: '#9146ff', color: '#ffffff' },
    kick: { bg: '#53fc18', color: '#000000' },
  };
  const PLATFORM_NAMES = { twitch: 'Twitch', kick: 'Kick' };
  const el = (id) => document.getElementById(id);
  const inputs = {
    platform: el('platform'), channel: el('channel'), label: el('label'), labelSubscribed: el('label-subscribed'),
    bg: el('bg'), color: el('color'), bgSubscribed: el('bg-subscribed'), radius: el('radius'),
    iconOnly: el('icon-only'),
  };
  const tryBox = el('try');
  const trySlot = el('try-slot');
  let validChannel = null;
  const pvDefault = el('pv-default');
  const pvSubscribed = el('pv-subscribed');
  const code = el('code');
  const copyBtn = el('copy');
  const status = el('channel-status');

  el('csp-code').textContent = `script-src ${location.origin}; connect-src ${location.origin}`;

  function setButton(btn, text) {
    btn.innerHTML = BELL;
    const span = document.createElement('span');
    span.textContent = text;
    btn.appendChild(span);
  }

  function attr(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function currentValues() {
    return {
      platform: inputs.platform.value,
      label: inputs.label.value.trim() || DEFAULTS.label,
      labelSubscribed: inputs.labelSubscribed.value.trim() || DEFAULTS.labelSubscribed,
      bg: inputs.bg.value, color: inputs.color.value,
      bgSubscribed: inputs.bgSubscribed.value, radius: inputs.radius.value,
      iconOnly: inputs.iconOnly.checked,
    };
  }

  function customAttrs(v) {
    const attrs = [];
    const colors = PLATFORM_COLORS[v.platform] || PLATFORM_COLORS.twitch;
    if (v.platform !== 'twitch') attrs.push(['data-platform', v.platform]);
    if (v.label !== DEFAULTS.label) attrs.push(['data-label', v.label]);
    if (v.labelSubscribed !== DEFAULTS.labelSubscribed) attrs.push(['data-label-subscribed', v.labelSubscribed]);
    if (v.bg !== colors.bg) attrs.push(['data-bg', v.bg]);
    if (v.color !== colors.color) attrs.push(['data-color', v.color]);
    if (v.bgSubscribed !== DEFAULTS.bgSubscribed) attrs.push(['data-bg-subscribed', v.bgSubscribed]);
    if (v.radius !== DEFAULTS.radius) attrs.push(['data-radius', v.radius]);
    if (v.iconOnly) attrs.push(['data-style', 'icon']);
    return attrs;
  }

  function update() {
    const v = currentValues();
    for (const b of [pvDefault, pvSubscribed]) {
      b.style.setProperty('--pv-bg', v.bg);
      b.style.setProperty('--pv-color', v.color);
      b.style.setProperty('--pv-bg-subscribed', v.bgSubscribed);
      b.style.setProperty('--pv-radius', v.radius + 'px');
      b.classList.toggle('icon', v.iconOnly);
    }
    setButton(pvDefault, v.iconOnly ? '' : v.label);
    setButton(pvSubscribed, v.iconOnly ? '' : v.labelSubscribed);

    const channel = inputs.channel.value.trim().toLowerCase() || 'yourchannel';
    const parts = [`src="${location.origin}/widget.js"`, `data-channel="${attr(channel)}"`]
      .concat(customAttrs(v).map(([name, value]) => `${name}="${attr(value)}"`));
    code.textContent = `<script ${parts.join('\n        ')} async><\/script>`;

    scheduleTryRefresh();
  }

  // The try-it button is the real widget, loaded from /widget.js with the
  // current customization. Recreated (debounced) whenever settings change.
  let tryTimer;
  function scheduleTryRefresh() {
    clearTimeout(tryTimer);
    tryTimer = setTimeout(renderTry, 400);
  }

  function renderTry() {
    tryBox.classList.toggle('hidden', !validChannel);
    trySlot.replaceChildren();
    if (!validChannel) return;
    const v = currentValues();
    const s = document.createElement('script');
    s.src = location.origin + '/widget.js';
    s.setAttribute('data-channel', validChannel);
    for (const [name, value] of customAttrs(v)) s.setAttribute(name, value);
    s.async = true;
    trySlot.appendChild(s);
  }

  let debounce;
  function checkChannel() {
    const channel = inputs.channel.value.trim().toLowerCase();
    const platform = inputs.platform.value;
    const platformName = PLATFORM_NAMES[platform] || platform;
    status.className = '';
    status.textContent = '';
    validChannel = null;
    scheduleTryRefresh();
    if (!channel) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const res = await fetch('/api/config?channel=' + encodeURIComponent(channel)
          + '&platform=' + encodeURIComponent(platform));
        if (res.ok) {
          const cfg = await res.json();
          validChannel = cfg.channel.login;
          scheduleTryRefresh();
          status.className = 'ok';
          status.innerHTML = '';
          if (cfg.channel.profileImageUrl) {
            const img = document.createElement('img');
            img.src = cfg.channel.profileImageUrl;
            img.alt = '';
            status.appendChild(img);
          }
          status.appendChild(document.createTextNode(cfg.channel.displayName + ' — found on ' + platformName));
        } else {
          const { error } = await res.json();
          status.className = 'bad';
          status.textContent = error === 'channel_not_allowed'
            ? 'This server is not set up to watch that channel.'
            : error === 'platform_not_supported'
              ? 'This server does not have ' + platformName + ' support enabled.'
              : 'That channel was not found on ' + platformName + '.';
        }
      } catch {
        status.className = 'bad';
        status.textContent = 'Could not reach the server. Try again.';
      }
    }, 450);
  }

  for (const input of Object.values(inputs)) {
    input.addEventListener('input', update);
  }
  inputs.channel.addEventListener('input', checkChannel);

  // Switching platform swaps in that platform's default colors — unless the
  // streamer already customized them — and re-validates the channel there.
  let lastPlatform = inputs.platform.value;
  inputs.platform.addEventListener('input', () => {
    const prev = PLATFORM_COLORS[lastPlatform];
    const next = PLATFORM_COLORS[inputs.platform.value] || PLATFORM_COLORS.twitch;
    if (inputs.bg.value === prev.bg) inputs.bg.value = next.bg;
    if (inputs.color.value === prev.color) inputs.color.value = next.color;
    lastPlatform = inputs.platform.value;
    update();
    checkChannel();
  });

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code.textContent);
    copyBtn.textContent = 'Copied ✓';
    copyBtn.classList.add('done');
    setTimeout(() => { copyBtn.textContent = 'Copy snippet'; copyBtn.classList.remove('done'); }, 2000);
  });

  update();
})();

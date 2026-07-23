(() => {
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
  const DEFAULTS = { label: 'Notify me when live', labelSubscribed: "✓ You'll be notified", bg: '#9146ff', color: '#ffffff', bgSubscribed: '#00a86b', radius: '8' };
  const el = (id) => document.getElementById(id);
  const inputs = {
    channel: el('channel'), label: el('label'), labelSubscribed: el('label-subscribed'),
    bg: el('bg'), color: el('color'), bgSubscribed: el('bg-subscribed'), radius: el('radius'),
  };
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

  function update() {
    const v = {
      label: inputs.label.value.trim() || DEFAULTS.label,
      labelSubscribed: inputs.labelSubscribed.value.trim() || DEFAULTS.labelSubscribed,
      bg: inputs.bg.value, color: inputs.color.value,
      bgSubscribed: inputs.bgSubscribed.value, radius: inputs.radius.value,
    };
    for (const b of [pvDefault, pvSubscribed]) {
      b.style.setProperty('--pv-bg', v.bg);
      b.style.setProperty('--pv-color', v.color);
      b.style.setProperty('--pv-bg-subscribed', v.bgSubscribed);
      b.style.setProperty('--pv-radius', v.radius + 'px');
    }
    setButton(pvDefault, v.label);
    setButton(pvSubscribed, v.labelSubscribed);

    const channel = inputs.channel.value.trim().toLowerCase() || 'yourchannel';
    const attrs = [`src="${location.origin}/widget.js"`, `data-channel="${attr(channel)}"`];
    if (v.label !== DEFAULTS.label) attrs.push(`data-label="${attr(v.label)}"`);
    if (v.labelSubscribed !== DEFAULTS.labelSubscribed) attrs.push(`data-label-subscribed="${attr(v.labelSubscribed)}"`);
    if (v.bg !== DEFAULTS.bg) attrs.push(`data-bg="${v.bg}"`);
    if (v.color !== DEFAULTS.color) attrs.push(`data-color="${v.color}"`);
    if (v.bgSubscribed !== DEFAULTS.bgSubscribed) attrs.push(`data-bg-subscribed="${v.bgSubscribed}"`);
    if (v.radius !== DEFAULTS.radius) attrs.push(`data-radius="${v.radius}"`);
    code.textContent = `<script ${attrs.join('\n        ')} async><\/script>`;
  }

  let debounce;
  function checkChannel() {
    const channel = inputs.channel.value.trim().toLowerCase();
    status.className = '';
    status.textContent = '';
    if (!channel) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const res = await fetch('/api/config?channel=' + encodeURIComponent(channel));
        if (res.ok) {
          const cfg = await res.json();
          status.className = 'ok';
          status.innerHTML = '';
          if (cfg.channel.profileImageUrl) {
            const img = document.createElement('img');
            img.src = cfg.channel.profileImageUrl;
            img.alt = '';
            status.appendChild(img);
          }
          status.appendChild(document.createTextNode(cfg.channel.displayName + ' — found on Twitch'));
        } else {
          const { error } = await res.json();
          status.className = 'bad';
          status.textContent = error === 'channel_not_allowed'
            ? 'This server is not set up to watch that channel.'
            : 'That channel was not found on Twitch.';
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

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code.textContent);
    copyBtn.textContent = 'Copied ✓';
    copyBtn.classList.add('done');
    setTimeout(() => { copyBtn.textContent = 'Copy snippet'; copyBtn.classList.remove('done'); }, 2000);
  });

  update();
})();

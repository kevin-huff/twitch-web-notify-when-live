(() => {
  const el = (id) => document.getElementById(id);
  const tokenInput = el('token');
  const errorEl = el('error');

  tokenInput.value = sessionStorage.getItem('twn:admin-token') || '';

  async function load() {
    errorEl.textContent = '';
    const token = tokenInput.value.trim();
    if (!token) {
      errorEl.textContent = 'Enter the ADMIN_TOKEN this instance was started with.';
      return;
    }
    let res;
    try {
      res = await fetch('/api/admin/stats', { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      errorEl.textContent = 'Could not reach the server.';
      return;
    }
    if (res.status === 401) { errorEl.textContent = 'Wrong token.'; return; }
    if (res.status === 404) { errorEl.textContent = 'This instance has no ADMIN_TOKEN set, so the admin API is disabled.'; return; }
    if (!res.ok) { errorEl.textContent = 'Unexpected error (' + res.status + ').'; return; }

    sessionStorage.setItem('twn:admin-token', token);
    const data = await res.json();

    el('t-channels').textContent = data.totals.channels;
    el('t-subs').textContent = data.totals.subscriptions;
    const webhookText = (label, s) => label + ' ' + (s?.enabled ? s.active + ' active' : 'off');
    el('t-eventsub').textContent = data.kickEvents
      ? webhookText('twitch', data.eventsub) + ' · ' + webhookText('kick', data.kickEvents)
      : (data.eventsub.enabled ? data.eventsub.active + ' active' : 'off');
    el('t-poll').textContent = data.pollIntervalSeconds + 's';

    const rows = el('rows');
    rows.replaceChildren();
    for (const c of data.channels) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      const dot = document.createElement('span');
      dot.className = 'dot' + (c.isLive ? ' live' : '');
      name.appendChild(dot);
      name.appendChild(document.createTextNode(c.displayName));
      if (c.platform && c.platform !== 'twitch') {
        const tag = document.createElement('span');
        tag.className = 'muted';
        tag.textContent = ' · ' + c.platform;
        name.appendChild(tag);
      }
      tr.appendChild(name);

      const subs = document.createElement('td');
      subs.className = 'num';
      subs.textContent = c.subscribers;
      tr.appendChild(subs);

      const notified = document.createElement('td');
      notified.className = 'muted';
      notified.textContent = c.lastNotifiedAt ? new Date(c.lastNotifiedAt * 1000).toLocaleString() : '—';
      tr.appendChild(notified);

      const stream = document.createElement('td');
      stream.className = 'num muted';
      stream.textContent = c.lastStreamId || '—';
      tr.appendChild(stream);

      rows.appendChild(tr);
    }
    el('stats').classList.remove('hidden');
  }

  el('load').addEventListener('click', load);
  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  if (tokenInput.value) load();
})();

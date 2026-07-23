self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Stream is live!' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Stream is live!', {
      body: data.body || '',
      icon: data.icon || undefined,
      image: data.image || undefined,
      tag: data.tag || undefined,
      data: { url: data.url || 'https://twitch.tv' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || 'https://twitch.tv'));
});

/* Admin-only service worker for Web Push.
 * Scope: /admin/
 * Note: no caching/offline. The fetch handler below is a minimal pass-through
 * required for PWA installability on Chrome/Android (Chrome 93+ withholds the
 * install prompt unless the service worker has a fetch handler).
 */

self.addEventListener('fetch', event => {
  // Only intercept navigations; everything else hits the network normally.
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title><p>You are offline.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
    )
  )
})

self.addEventListener('push', event => {
  let payload = null

  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      payload = { title: 'ViTransfer', body: event.data.text() }
    }
  }

  const title = payload && payload.title ? String(payload.title) : 'ViTransfer'
  const body = payload && payload.body ? String(payload.body) : 'You have a new notification.'
  const url = payload && payload.url ? String(payload.url) : '/admin'

  event.waitUntil(
    self.registration
      .showNotification(title, {
        body,
        data: { url },
        badge: '/admin/icons/badge-96.png',
        icon: '/admin/icons/icon-192.png',
      })
      .catch(() => {})
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification?.data?.url || '/admin'

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url)
          if (clientUrl.pathname.startsWith('/admin')) {
            await client.focus()
            client.navigate(url)
            return
          }
        } catch {
          // ignore
        }
      }
      await self.clients.openWindow(url)
    })()
  )
})

/* Admin-only service worker for Web Push.
 * Scope: /admin/
 * Note: intentionally no fetch handler (purely online; no caching/offline).
 */

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

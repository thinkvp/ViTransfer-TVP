'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { apiJson, apiPost } from '@/lib/api-client'
import { getRememberDeviceEnabled, setRememberDeviceEnabled } from '@/lib/token-store'
import { ChevronDown, ChevronUp, Wrench, X } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

type ServerSubscription = {
  id: string
  endpoint: string
  endpointOrigin: string
  deviceName: string | null
  createdAt: string
}

interface AdminBrowserPushSectionProps {
  show: boolean
  setShow: (value: boolean) => void
}

export function AdminBrowserPushSection({ show, setShow }: AdminBrowserPushSectionProps) {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [allowed, setAllowed] = useState<boolean | null>(null)

  const [showTroubleshooting, setShowTroubleshooting] = useState(false)

  const [swScriptUrl, setSwScriptUrl] = useState<string | null>(null)
  const [swScope, setSwScope] = useState<string | null>(null)
  const [pageControlled, setPageControlled] = useState<boolean | null>(null)

  const [rememberDevice, setRememberDevice] = useState<boolean>(false)

  const [deviceName, setDeviceName] = useState('')
  const [serverSubs, setServerSubs] = useState<ServerSubscription[]>([])

  const [browserEndpoint, setBrowserEndpoint] = useState<string | null>(null)
  const [isSubscribed, setIsSubscribed] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>('')
  const [status, setStatus] = useState<string>('')

  const permission =
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'

  function getEndpointOrigin(endpoint: string): string {
    try {
      return new URL(endpoint).origin
    } catch {
      return endpoint
    }
  }

  async function ensureAdminRegistration() {
    if (!('serviceWorker' in navigator)) return null

    try {
      await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' })
    } catch {
      // ignore; we may still have an existing registration
    }

    return (await navigator.serviceWorker.getRegistration('/admin/')) || null
  }

  async function getAdminRegistration() {
    if (!('serviceWorker' in navigator)) return null
    // Ensure we use the /admin scoped service worker.
    return (await navigator.serviceWorker.getRegistration('/admin/')) || (await navigator.serviceWorker.ready)
  }

  async function refreshState() {
    setError('')
    setStatus('')

    const isSupported =
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window

    setSupported(isSupported)
    setRememberDevice(getRememberDeviceEnabled())

    if (!isSupported) return

    setPageControlled(!!navigator.serviceWorker.controller)

    // Check access by calling a system-admin-only endpoint.
    try {
      await apiJson('/api/web-push/vapid-public-key')
      setAllowed(true)
    } catch (e: any) {
      // apiFetch throws on non-2xx; treat as not allowed.
      setAllowed(false)
      return
    }

    try {
      const reg = await getAdminRegistration()
      setSwScriptUrl(reg?.active?.scriptURL ?? reg?.installing?.scriptURL ?? reg?.waiting?.scriptURL ?? null)
      setSwScope((reg as any)?.scope ?? null)

      const sub = await reg?.pushManager.getSubscription()
      const endpoint = sub?.endpoint ?? null
      setBrowserEndpoint(endpoint)
      setIsSubscribed(!!sub)
    } catch {
      setSwScriptUrl(null)
      setSwScope(null)
      setBrowserEndpoint(null)
      setIsSubscribed(false)
    }

    try {
      const data = await apiJson('/api/web-push/subscriptions')
      const subs = Array.isArray(data?.subscriptions) ? data.subscriptions : []
      setServerSubs(subs)

      // Prefill a name if the server has one for this endpoint.
      const currentEndpoint = (await (await getAdminRegistration())?.pushManager.getSubscription())?.endpoint
      if (currentEndpoint) {
        const match = subs.find((s: ServerSubscription) => s?.endpoint === currentEndpoint)
        if (match?.deviceName) setDeviceName(match.deviceName)
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function subscribeDevice() {
    setBusy(true)
    setError('')
    setStatus('')

    try {
      const reg = (await ensureAdminRegistration()) || (await getAdminRegistration())
      if (!reg) throw new Error('Service worker not ready')

      const { publicKey } = await apiJson('/api/web-push/vapid-public-key')
      if (!publicKey || typeof publicKey !== 'string') throw new Error('Missing VAPID public key')

      const perm = await Notification.requestPermission()
      if (perm !== 'granted') throw new Error('Notification permission was not granted')

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      await apiPost('/api/web-push/subscribe', {
        subscription: subscription.toJSON(),
        deviceName: deviceName.trim() || null,
      })

      setStatus('Browser push enabled on this device.')
      await refreshState()
    } catch (e: any) {
      setError(e?.message || 'Failed to subscribe')
    } finally {
      setBusy(false)
    }
  }

  async function saveLabel() {
    setBusy(true)
    setError('')
    setStatus('')

    try {
      const reg = await getAdminRegistration()
      const subscription = await reg?.pushManager.getSubscription()
      if (!subscription) throw new Error('This device is not subscribed')

      await apiPost('/api/web-push/subscribe', {
        subscription: subscription.toJSON(),
        deviceName: deviceName.trim() || null,
      })

      setStatus('Device label saved.')
      await refreshState()
    } catch (e: any) {
      setError(e?.message || 'Failed to save device label')
    } finally {
      setBusy(false)
    }
  }

  async function unsubscribeDevice() {
    setBusy(true)
    setError('')
    setStatus('')

    try {
      const reg = await getAdminRegistration()
      const subscription = await reg?.pushManager.getSubscription()
      if (subscription) {
        await subscription.unsubscribe()
        await apiPost('/api/web-push/unsubscribe', { endpoint: subscription.endpoint })
      }

      setStatus('Browser push disabled on this device.')
      await refreshState()
    } catch (e: any) {
      setError(e?.message || 'Failed to unsubscribe')
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    setBusy(true)
    setError('')
    setStatus('')

    try {
      const endpoint = browserEndpoint
      if (!endpoint) throw new Error('This device is not subscribed')
      await apiPost('/api/web-push/test', { endpoint })
      setStatus('Test notification sent.')
    } catch (e: any) {
      setError(e?.message || 'Failed to send test')
    } finally {
      setBusy(false)
    }
  }

  async function removeServerSubscription(sub: ServerSubscription) {
    setBusy(true)
    setError('')
    setStatus('')

    try {
      if (browserEndpoint && sub.endpoint === browserEndpoint) {
        await unsubscribeDevice()
        return
      }

      await apiPost('/api/web-push/unsubscribe', { id: sub.id })
      setStatus('Device removed.')
      await refreshState()
    } catch (e: any) {
      setError(e?.message || 'Failed to remove device')
    } finally {
      setBusy(false)
    }
  }

  const visible = supported !== false && allowed !== false
  if (supported === null || allowed === null) {
    // Avoid flicker on initial load.
    return null
  }

  if (!visible) {
    return null
  }

  const statusSummary = isSubscribed ? 'Enabled on this device' : 'Not enabled on this device'
  const registeredSummary = serverSubs.length > 0 ? `${serverSubs.length} device${serverSubs.length === 1 ? '' : 's'}` : 'No devices'

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Browser Push (Admin)</CardTitle>
            <CardDescription>
              {statusSummary} · {registeredSummary}
            </CardDescription>
          </div>
          {show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>

      {show && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="text-sm text-muted-foreground">
            Browser push notifications work inside the admin area. All admin users can subscribe their devices and will receive notifications relevant to their access level.
          </div>

          <div className="space-y-2 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Remember this device</Label>
                <p className="text-xs text-muted-foreground">
                  Keeps you signed in on this browser (stores the refresh token in localStorage). Not required for notifications.
                </p>
              </div>
              <Switch
                checked={rememberDevice}
                onCheckedChange={(v) => {
                  setRememberDevice(v)
                  setRememberDeviceEnabled(v)
                }}
              />
            </div>
          </div>

          <div className="space-y-2 border p-4 rounded-lg bg-muted/30">
            <div className="grid gap-2">
              <Label htmlFor="webPushDeviceName">Device label (optional)</Label>
              <Input
                id="webPushDeviceName"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g., Office PC"
                maxLength={60}
              />
              <p className="text-xs text-muted-foreground">
                Helps you recognise this browser in the device list below.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              {isSubscribed ? (
                <Button variant="secondary" disabled={busy} onClick={unsubscribeDevice}>
                  Disable on this device
                </Button>
              ) : (
                <Button disabled={busy} onClick={subscribeDevice}>
                  Enable on this device
                </Button>
              )}

              <Button variant="outline" disabled={busy || !isSubscribed} onClick={sendTest}>
                Send test
              </Button>

              <Button variant="outline" disabled={busy || !isSubscribed} onClick={saveLabel}>
                Save label
              </Button>

              <Button variant="ghost" disabled={busy} onClick={refreshState}>
                Refresh
              </Button>
            </div>

            {permission !== 'granted' ? (
              <p className="text-xs text-muted-foreground pt-2">
                Browser permission: {permission} (allow notifications for this site)
              </p>
            ) : null}

            {error ? <p className="text-sm text-red-500 pt-2">{error}</p> : null}
            {status ? <p className="text-sm text-green-600 pt-2">{status}</p> : null}
          </div>

          {serverSubs.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm font-medium">Your devices</div>
              <div className="space-y-2">
                {serverSubs.map((s) => {
                  const isThisDevice = !!browserEndpoint && s.endpoint === browserEndpoint
                  const label = s.deviceName?.trim() || s.endpointOrigin
                  return (
                    <div key={s.id} className="flex items-start justify-between gap-3 border p-3 rounded-lg bg-muted/20">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{label}</div>
                        <div className="text-xs text-muted-foreground">
                          {isThisDevice ? 'This device · ' : ''}
                          Added {formatDateTime(s.createdAt)}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => removeServerSubscription(s)}
                        className="text-muted-foreground"
                        title="Remove"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No devices registered yet.</div>
          )}

          <div className="pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowTroubleshooting((v) => !v)}
              className="text-muted-foreground"
            >
              <Wrench className="w-4 h-4 mr-2" />
              {showTroubleshooting ? 'Hide troubleshooting details' : 'Show troubleshooting details'}
            </Button>

            {showTroubleshooting ? (
              <div className="mt-2 text-xs text-muted-foreground space-y-1 border rounded-lg p-3 bg-muted/10">
                <div>Permission: {permission}</div>
                {pageControlled !== null ? (
                  <div>Service worker controlling this tab: {pageControlled ? 'yes' : 'no (reload /admin once)'}</div>
                ) : null}
                {swScope ? <div>Service worker scope: {swScope}</div> : null}
                {swScriptUrl ? <div>Service worker script: {swScriptUrl}</div> : null}
                {browserEndpoint ? <div>Push endpoint provider: {getEndpointOrigin(browserEndpoint)}</div> : null}
              </div>
            ) : null}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

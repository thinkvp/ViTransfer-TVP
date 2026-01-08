'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, apiPatch } from '@/lib/api-client'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'
import { ClientFileUpload } from '@/components/ClientFileUpload'
import { ClientFileList } from '@/components/ClientFileList'

type ClientResponse = {
  id: string
  name: string
  address: string | null
  phone: string | null
  website: string | null
  notes: string | null
  recipients: Array<{
    id: string
    name: string | null
    email: string | null
    displayColor: string | null
    isPrimary: boolean
    receiveNotifications: boolean
  }>
}

export default function ClientDetailPage() {
  const params = useParams()
  const router = useRouter()
  const clientId = params?.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [client, setClient] = useState<ClientResponse | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    website: '',
    notes: '',
  })

  const [recipients, setRecipients] = useState<EditableRecipient[]>([])
  const [fileRefresh, setFileRefresh] = useState(0)

  const loadClient = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/api/clients/${clientId}`)
      if (!res.ok) {
        if (res.status === 404) {
          router.push('/admin/clients')
          return
        }
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch client')
      }

      const data = await res.json()
      const nextClient = data?.client as ClientResponse
      setClient(nextClient)
      setFormData({
        name: nextClient?.name || '',
        address: nextClient?.address || '',
        phone: nextClient?.phone || '',
        website: nextClient?.website || '',
        notes: nextClient?.notes || '',
      })
      setRecipients(
        (nextClient?.recipients || []).map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: r.receiveNotifications !== false,
        }))
      )
    } catch (err: any) {
      setError(err?.message || 'Failed to load client')
    } finally {
      setLoading(false)
    }
  }, [clientId, router])

  useEffect(() => {
    void loadClient()
  }, [loadClient])

  const canRender = useMemo(() => !loading && !!client, [loading, client])

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!client) return

    setError('')
    if (!formData.name.trim()) {
      setError('Client name is required')
      return
    }

    setSaving(true)
    try {
      await apiPatch(`/api/clients/${clientId}`, {
        name: formData.name.trim(),
        address: formData.address.trim() ? formData.address.trim() : null,
        phone: formData.phone.trim() ? formData.phone.trim() : null,
        website: formData.website.trim() ? formData.website.trim() : null,
        notes: formData.notes.trim() ? formData.notes.trim() : null,
        recipients: recipients.map((r) => ({
          id: r.id,
          name: r.name?.trim() ? r.name.trim() : null,
          email: r.email?.trim() ? r.email.trim() : null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: Boolean(r.receiveNotifications),
        })),
      })

      await loadClient()
    } catch (err: any) {
      setError(err?.message || 'Failed to save client')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!client) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Client not found</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/clients">
            <Button variant="ghost" size="default" className="justify-start px-3">
              <ArrowLeft className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Back to Clients</span>
              <span className="sm:hidden">Back</span>
            </Button>
          </Link>
        </div>

        <div className="max-w-3xl mx-auto space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Client Details</CardTitle>
              <CardDescription>Update client contact information</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-6">
                {error && (
                  <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">Client Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    required
                    maxLength={200}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="address">Address</Label>
                  <Textarea
                    id="address"
                    value={formData.address}
                    onChange={(e) => setFormData((p) => ({ ...p, address: e.target.value }))}
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      value={formData.phone}
                      onChange={(e) => setFormData((p) => ({ ...p, phone: e.target.value }))}
                      maxLength={50}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="website">Website</Label>
                    <Input
                      id="website"
                      value={formData.website}
                      onChange={(e) => setFormData((p) => ({ ...p, website: e.target.value }))}
                      maxLength={200}
                      placeholder="https://"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
                    rows={4}
                  />
                </div>

                <div className="border rounded-lg p-4 bg-card">
                  <RecipientsEditor
                    label="Client Recipients"
                    description="Recipients can be pulled into projects during project creation"
                    value={recipients}
                    onChange={setRecipients}
                    addButtonLabel="Add Recipient"
                  />
                </div>

                <div className="flex items-center justify-end">
                  <Button type="submit" disabled={saving}>
                    <Save className="w-4 h-4 mr-2" />
                    Save Changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
              <CardDescription>Upload and manage files for this client</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ClientFileUpload
                clientId={clientId}
                onUploadComplete={() => setFileRefresh((v) => v + 1)}
              />
              <ClientFileList clientId={clientId} refreshTrigger={fileRefresh} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiPost } from '@/lib/api-client'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'

export default function NewClientPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    website: '',
    notes: '',
  })

  const [recipients, setRecipients] = useState<EditableRecipient[]>([])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')

    if (!formData.name.trim()) {
      setError('Client name is required')
      return
    }

    setLoading(true)
    try {
      const res = await apiPost('/api/clients', {
        name: formData.name.trim(),
        address: formData.address.trim() ? formData.address.trim() : null,
        phone: formData.phone.trim() ? formData.phone.trim() : null,
        website: formData.website.trim() ? formData.website.trim() : null,
        notes: formData.notes.trim() ? formData.notes.trim() : null,
        recipients: recipients.map((r) => ({
          name: r.name?.trim() ? r.name.trim() : null,
          email: r.email?.trim() ? r.email.trim() : null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: Boolean(r.receiveNotifications),
        })),
      })

      const clientId = res?.client?.id
      if (!clientId) {
        throw new Error('Client created but no id returned')
      }

      router.push(`/admin/clients/${clientId}`)
    } catch (err: any) {
      setError(err?.message || 'Failed to create client')
    } finally {
      setLoading(false)
    }
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

        <div className="max-w-2xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>Add New Client</CardTitle>
              <CardDescription>Create a client record and default recipients</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
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
                    description="These recipients can be added to projects when creating a new project"
                    value={recipients}
                    onChange={setRecipients}
                    addButtonLabel="Add Recipient"
                  />
                </div>

                <div className="flex items-center justify-end gap-2">
                  <Link href="/admin/clients">
                    <Button type="button" variant="outline">Cancel</Button>
                  </Link>
                  <Button type="submit" disabled={loading}>
                    <Save className="w-4 h-4 mr-2" />
                    Create Client
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

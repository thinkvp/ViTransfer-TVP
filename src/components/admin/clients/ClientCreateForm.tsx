'use client'

import { useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiPost } from '@/lib/api-client'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'

export type CreatedClient = {
  id: string
  name: string
}

type Props = {
  onCreated: (client: CreatedClient) => void
  onCancel: () => void
  idPrefix?: string
}

export function ClientCreateForm({ onCreated, onCancel, idPrefix = 'client' }: Props) {
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
    e.stopPropagation()
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
          displayColor: r.displayColor ?? null,
          isPrimary: Boolean(r.isPrimary),
          receiveNotifications: Boolean(r.receiveNotifications),
          receiveSalesReminders: (r as any)?.receiveSalesReminders !== false,
        })),
      })

      const client = res?.client
      if (!client?.id) {
        throw new Error('Client created but no id returned')
      }

      onCreated({ id: client.id, name: client.name ?? formData.name.trim() })
    } catch (err: any) {
      setError(err?.message || 'Failed to create client')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Client Name *</Label>
        <Input
          id={`${idPrefix}-name`}
          value={formData.name}
          onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
          required
          maxLength={200}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-address`}>Address</Label>
        <Textarea
          id={`${idPrefix}-address`}
          value={formData.address}
          onChange={(e) => setFormData((p) => ({ ...p, address: e.target.value }))}
          rows={3}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
          <Input
            id={`${idPrefix}-phone`}
            value={formData.phone}
            onChange={(e) => setFormData((p) => ({ ...p, phone: e.target.value }))}
            maxLength={50}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-website`}>Website</Label>
          <Input
            id={`${idPrefix}-website`}
            value={formData.website}
            onChange={(e) => setFormData((p) => ({ ...p, website: e.target.value }))}
            maxLength={200}
            placeholder="https://"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={formData.notes}
          onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
          rows={4}
        />
      </div>

      <RecipientsEditor
        label="Client Contacts"
        description="These recipients can be added to projects when creating a new project"
        value={recipients}
        onChange={setRecipients}
        addButtonLabel="Add Contact"
        addButtonVariant="outline"
        addButtonSize="default"
        addButtonHideLabelOnMobile={true}
        addButtonFixedWidth={false}
        showNotificationsToggle={false}
        showSalesRemindersToggle
      />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading}>
          <Save className="w-4 h-4 mr-2" />
          Create Client
        </Button>
      </div>
    </form>
  )
}

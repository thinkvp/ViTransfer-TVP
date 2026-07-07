'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Trash2 } from 'lucide-react'
import type { ClientMatch, RecipientProposal } from '@/lib/ai/proposal-schemas'
import type { ClientOption } from './helpers'

export type ClientChoice =
  | { mode: 'existing'; clientId: string }
  | { mode: 'new'; name: string; address: string; phone: string; website: string; recipients: RecipientProposal[] }

export function initialClientChoice(match: ClientMatch, clients: ClientOption[]): ClientChoice {
  if (match.matchedClientId && clients.some((c) => c.id === match.matchedClientId)) {
    return { mode: 'existing', clientId: match.matchedClientId }
  }
  if (match.proposedNewClient) {
    // The proposed "new" client may already exist under the same name
    const existing = clients.find(
      (c) => c.name.trim().toLowerCase() === match.proposedNewClient!.name.trim().toLowerCase()
    )
    if (existing) return { mode: 'existing', clientId: existing.id }
    return {
      mode: 'new',
      name: match.proposedNewClient.name,
      address: match.proposedNewClient.address ?? '',
      phone: match.proposedNewClient.phone ?? '',
      website: match.proposedNewClient.website ?? '',
      recipients: match.proposedNewClient.recipients ?? [],
    }
  }
  return { mode: 'existing', clientId: clients[0]?.id ?? '' }
}

interface ClientPickerProps {
  idPrefix: string
  choice: ClientChoice
  setChoice: (choice: ClientChoice) => void
  clients: ClientOption[]
  matchConfidence: ClientMatch['matchConfidence']
  disabled?: boolean
}

export function ClientPicker({ idPrefix, choice, setChoice, clients, matchConfidence, disabled }: ClientPickerProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Label htmlFor={`${idPrefix}-client-mode`}>Client</Label>
        {matchConfidence !== 'none' && choice.mode === 'existing' && (
          <span className="text-xs text-muted-foreground">
            AI match confidence: {matchConfidence}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select
          value={choice.mode === 'existing' ? choice.clientId : '__new__'}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === '__new__') {
              if (choice.mode !== 'new') {
                setChoice({ mode: 'new', name: '', address: '', phone: '', website: '', recipients: [] })
              }
            } else {
              setChoice({ mode: 'existing', clientId: value })
            }
          }}
        >
          <SelectTrigger id={`${idPrefix}-client-mode`}>
            <SelectValue placeholder="Select a client" />
          </SelectTrigger>
          <SelectContent>
            {clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
            <SelectItem value="__new__">+ Create new client…</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {choice.mode === 'new' && (
        <div className="space-y-3 border p-3 rounded-lg bg-muted/30">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-new-client-name`}>New client name</Label>
              <Input
                id={`${idPrefix}-new-client-name`}
                value={choice.name}
                disabled={disabled}
                onChange={(e) => setChoice({ ...choice, name: e.target.value })}
                placeholder="Client / company name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-new-client-phone`}>Phone (optional)</Label>
              <Input
                id={`${idPrefix}-new-client-phone`}
                value={choice.phone}
                disabled={disabled}
                onChange={(e) => setChoice({ ...choice, phone: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-new-client-address`}>Address (optional)</Label>
              <Input
                id={`${idPrefix}-new-client-address`}
                value={choice.address}
                disabled={disabled}
                onChange={(e) => setChoice({ ...choice, address: e.target.value })}
              />
            </div>
          </div>

          {choice.recipients.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Contacts to save on the new client
              </Label>
              {choice.recipients.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={r.name}
                    placeholder="Name"
                    disabled={disabled}
                    onChange={(e) =>
                      setChoice({
                        ...choice,
                        recipients: choice.recipients.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      })
                    }
                  />
                  <Input
                    value={r.email}
                    placeholder="Email"
                    disabled={disabled}
                    onChange={(e) =>
                      setChoice({
                        ...choice,
                        recipients: choice.recipients.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={() => setChoice({ ...choice, recipients: choice.recipients.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ClientCreateForm, type CreatedClient } from '@/components/admin/clients/ClientCreateForm'

type Props = {
  open: boolean
  onClose: () => void
  onCreated: (client: CreatedClient) => void
}

export function ClientCreateModal({ open, onClose, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Client</DialogTitle>
          <DialogDescription>Create a client record and default recipients</DialogDescription>
        </DialogHeader>
        {/* Remount the form whenever the modal opens so stale input doesn't linger */}
        {open && (
          <ClientCreateForm
            idPrefix="client-modal"
            onCreated={onCreated}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

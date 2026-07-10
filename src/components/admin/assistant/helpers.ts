import * as tus from 'tus-js-client'
import { apiDelete, apiPost } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { attachmentMimeType, type AiAttachmentKind } from '@/lib/ai/attachments'
import type { AssistantResult, SalesProposal } from '@/lib/ai/proposal-schemas'
import type { SalesQuoteWithVersion, SalesInvoiceWithVersion } from '@/lib/sales/db-mappers'

/** An existing quote/invoice being revised by the assistant */
export interface UpdateTarget {
  type: 'quote' | 'invoice'
  id: string
  version: number
  number: string // e.g. EST-0004 / INV-0012
}

/** Map an existing quote/invoice to the SalesProposal shape the assistant/cards use */
export function salesDocToProposal(
  doc: SalesQuoteWithVersion | SalesInvoiceWithVersion,
  type: 'quote' | 'invoice'
): SalesProposal {
  return {
    docType: type === 'quote' ? 'QUOTE' : 'INVOICE',
    client: { sourceName: null, matchedClientId: doc.clientId, matchConfidence: 'exact', proposedNewClient: null },
    issueDate: doc.issueDate,
    validUntil: type === 'quote' ? (doc as SalesQuoteWithVersion).validUntil : null,
    dueDate: type === 'invoice' ? (doc as SalesInvoiceWithVersion).dueDate : null,
    notes: doc.notes || null,
    terms: doc.terms || null,
    items: doc.items.map((it) => ({
      libraryItemId: null,
      description: it.description,
      details: it.details ?? null,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
      taxRatePercent: it.taxRatePercent,
      // label/tax snapshot rides along via ResolvedSalesLineItem
      taxRateName: it.taxRateName ?? null,
      labelId: it.labelId ?? null,
      labelName: it.labelName ?? null,
      labelColor: it.labelColor ?? null,
    })) as SalesProposal['items'],
  }
}

/** Wrap a sales-only proposal as an AssistantResult for the refine (revise) request */
export function proposalToRefineBase(sales: SalesProposal): AssistantResult {
  return { project: null, sales, reply: null, assumptions: [] }
}

export interface ClientOption {
  id: string
  name: string
}

/** An attachment held in the browser: sent to the assistant AND attached to the created project */
export interface AssistantAttachment {
  fileName: string
  kind: AiAttachmentKind
  size: number
  base64: string
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Rebuild a File from a browser-held attachment (e.g. to upload a receipt to a created expense) */
export function base64ToFile(att: AssistantAttachment): File {
  const bytes = base64ToBytes(att.base64)
  return new File([bytes as BlobPart], att.fileName, { type: attachmentMimeType(att.fileName) })
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function tusUpload(file: File, metadata: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: '/api/uploads',
      retryDelays: [0, 1000, 3000, 5000],
      metadata: { filename: file.name, filetype: file.type || 'application/octet-stream', ...metadata },
      chunkSize: 32 * 1024 * 1024,
      storeFingerprintForResuming: false,
      onSuccess: () => resolve(),
      onError: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      onBeforeRequest: (req) => {
        const xhr = req.getUnderlyingObject()
        xhr.withCredentials = true
        const token = getAccessToken()
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      },
    })
    upload.start()
  })
}

/**
 * Attach an assistant attachment to a created project through the EXISTING
 * upload flows: .eml → External Communication (ProjectEmail + parse job),
 * everything else → Project Files. Same create-record-then-TUS pattern as
 * ProjectEmailUpload / ProjectFileUpload; the DB record is removed on upload
 * failure like those components do.
 */
export async function uploadAttachmentToProject(projectId: string, att: AssistantAttachment): Promise<void> {
  const bytes = base64ToBytes(att.base64)
  const mimeType = attachmentMimeType(att.fileName)
  const file = new File([bytes as BlobPart], att.fileName, { type: mimeType })

  if (att.kind === 'email') {
    const sha256 = await sha256Hex(bytes)
    const res = await apiPost<{ projectEmailId: string }>(`/api/projects/${projectId}/emails`, {
      fileName: att.fileName,
      fileSize: file.size,
      mimeType,
      sha256,
    })
    if (!res.projectEmailId) throw new Error('Failed to create email record')
    try {
      await tusUpload(file, { projectEmailId: res.projectEmailId })
    } catch (err) {
      await apiDelete(`/api/projects/${projectId}/emails/${res.projectEmailId}`).catch(() => {})
      throw err
    }
    return
  }

  const res = await apiPost<{ projectFileId: string }>(`/api/projects/${projectId}/files`, {
    fileName: att.fileName,
    fileSize: file.size,
    mimeType,
  })
  if (!res.projectFileId) throw new Error('Failed to create file record')
  try {
    await tusUpload(file, { projectFileId: res.projectFileId })
  } catch (err) {
    await apiDelete(`/api/projects/${projectId}/files/${res.projectFileId}`).catch(() => {})
    throw err
  }
}

export interface NewClientDraft {
  name: string
  address: string | null
  phone: string | null
  website: string | null
  /** Contact people stored on the client record (Client Recipients) */
  recipients?: Array<{ name: string; email: string; isPrimary: boolean }>
}

/** Create a client through the existing endpoint; returns the new client option. */
export async function createClientViaApi(draft: NewClientDraft): Promise<ClientOption> {
  const res = await apiPost<{ client: { id: string; name: string } }>('/api/clients', {
    name: draft.name,
    address: draft.address,
    phone: draft.phone,
    website: draft.website,
    recipients: (draft.recipients ?? []).map((r, i) => ({
      name: r.name || null,
      email: r.email || null,
      isPrimary: r.isPrimary || (i === 0 && !draft.recipients!.some((x) => x.isPrimary)),
      receiveNotifications: true,
    })),
  })
  return { id: res.client.id, name: res.client.name }
}

// Client-safe password generation using Web Crypto API (same scheme as the new-project page)
export function generateSecurePassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const numbers = '23456789'
  const special = '!@#$%'
  const all = letters + numbers + special

  const getRandomInt = (max: number) => {
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    return array[0] % max
  }

  let password = ''
  password += letters.charAt(getRandomInt(letters.length))
  password += numbers.charAt(getRandomInt(numbers.length))
  for (let i = 2; i < 12; i++) {
    password += all.charAt(getRandomInt(all.length))
  }
  return password
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface CreateStep {
  label: string
  state: StepState
  detail?: string
}

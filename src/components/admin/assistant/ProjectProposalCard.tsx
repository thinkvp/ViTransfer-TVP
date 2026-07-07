'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, FolderKanban, Trash2, CheckCircle2, XCircle, Plus } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiPost } from '@/lib/api-client'
import type { ProjectProposal } from '@/lib/ai/proposal-schemas'
import { ClientPicker, initialClientChoice, type ClientChoice } from './ClientPicker'
import {
  createClientViaApi,
  generateSecurePassword,
  uploadAttachmentToProject,
  type AssistantAttachment,
  type ClientOption,
  type CreateStep,
} from './helpers'

const KEY_DATE_TYPES = ['PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER'] as const

interface ProjectProposalCardProps {
  proposal: ProjectProposal
  clients: ClientOption[]
  /** Original files from the assistant form — attached to the project after creation */
  attachments: AssistantAttachment[]
  onClientCreated: (client: ClientOption) => void
  onProjectCreated: (project: { id: string; clientId: string }) => void
}

export function ProjectProposalCard({ proposal, clients, attachments, onClientCreated, onProjectCreated }: ProjectProposalCardProps) {
  const [title, setTitle] = useState(proposal.title)
  const [description, setDescription] = useState(proposal.description ?? '')
  const [startDate, setStartDate] = useState(proposal.startDate ?? '')
  const [clientChoice, setClientChoice] = useState<ClientChoice>(() => initialClientChoice(proposal.client, clients))
  const [recipients, setRecipients] = useState(proposal.recipients)
  const [keyDates, setKeyDates] = useState(proposal.keyDates)
  const [includeSchedule, setIncludeSchedule] = useState(proposal.schedule != null)
  const [anchorDate, setAnchorDate] = useState(proposal.schedule?.anchorDate ?? '')

  const [creating, setCreating] = useState(false)
  const [steps, setSteps] = useState<CreateStep[]>([])
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function handleCreate() {
    // Local mutable step list — state updater closures can't return indices reliably
    const localSteps: CreateStep[] = []
    const pushStep = (label: string): number => {
      localSteps.push({ label, state: 'running' })
      setSteps([...localSteps])
      return localSteps.length - 1
    }
    const settleStep = (index: number, state: CreateStep['state'], detail?: string) => {
      localSteps[index] = { ...localSteps[index], state, detail }
      setSteps([...localSteps])
    }

    setError('')
    setSteps([])
    setCreating(true)
    try {
      // 1. Resolve client
      let clientId: string
      if (clientChoice.mode === 'new') {
        if (!clientChoice.name.trim()) throw new Error('New client name is required')
        const step = pushStep(`Create client "${clientChoice.name.trim()}"`)
        try {
          const client = await createClientViaApi({
            name: clientChoice.name.trim(),
            address: clientChoice.address.trim() || null,
            phone: clientChoice.phone.trim() || null,
            website: clientChoice.website.trim() || null,
            recipients: clientChoice.recipients,
          })
          onClientCreated(client)
          setClientChoice({ mode: 'existing', clientId: client.id })
          clientId = client.id
          settleStep(step, 'done')
        } catch (e) {
          settleStep(step, 'failed', e instanceof Error ? e.message : 'Failed')
          throw e
        }
      } else {
        clientId = clientChoice.clientId
        if (!clientId) throw new Error('Select a client first')
      }

      // 2. Create the project (secure-by-default: auto-generated share password)
      const projectStep = pushStep(`Create project "${title.trim()}"`)
      let projectId: string
      try {
        const project = await apiPost<{ id: string }>('/api/projects', {
          title: title.trim(),
          description: description.trim() || undefined,
          clientId,
          recipients: recipients.map((r, i) => ({
            name: r.name || null,
            email: r.email || null,
            isPrimary: r.isPrimary || (i === 0 && !recipients.some((x) => x.isPrimary)),
            receiveNotifications: true,
            // Also store on the Client profile (server dedupes by email)
            alsoAddToClient: true,
          })),
          sharePassword: generateSecurePassword(),
          authMode: 'PASSWORD',
          startDate: startDate || null,
        })
        projectId = project.id
        setCreatedProjectId(project.id)
        onProjectCreated({ id: project.id, clientId })
        settleStep(projectStep, 'done')
      } catch (e) {
        settleStep(projectStep, 'failed', e instanceof Error ? e.message : 'Failed')
        throw e
      }

      // 3. Key dates (best effort per row)
      for (const kd of keyDates) {
        const step = pushStep(`Add key date ${kd.type} ${kd.date}`)
        try {
          await apiPost(`/api/projects/${projectId}/key-dates`, {
            date: kd.date,
            allDay: true,
            type: kd.type,
            notes: kd.notes || null,
          })
          settleStep(step, 'done')
        } catch (e) {
          settleStep(step, 'failed', e instanceof Error ? e.message : 'Failed')
        }
      }

      // 4. Gantt schedule from the standard template + any extra tasks
      if (includeSchedule && anchorDate) {
        const step = pushStep(`Create schedule (anchor ${anchorDate})`)
        try {
          const res = await apiPost<{ schedule: { phases: Array<{ id: string; name: string }> } }>(
            `/api/admin/projects/${projectId}/schedule`,
            {
              anchorDate,
              includeWeekends: proposal.schedule?.includeWeekends ?? false,
              fromTemplate: true,
            }
          )
          settleStep(step, 'done')

          const phases = res.schedule?.phases ?? []
          for (const task of proposal.schedule?.extraTasks ?? []) {
            const taskStep = pushStep(`Add schedule task "${task.name}"`)
            try {
              const phase =
                phases.find((p) => p.name.trim().toLowerCase() === task.phaseName.trim().toLowerCase()) ?? phases[0]
              if (!phase) throw new Error('No schedule phase available')
              await apiPost(`/api/admin/projects/${projectId}/schedule/tasks`, {
                phaseId: phase.id,
                name: task.name,
                kind: task.kind,
                owner: task.owner,
                startDate: task.startDate,
                endDate: task.endDate,
              })
              settleStep(taskStep, 'done')
            } catch (e) {
              settleStep(taskStep, 'failed', e instanceof Error ? e.message : 'Failed')
            }
          }
        } catch (e) {
          settleStep(step, 'failed', e instanceof Error ? e.message : 'Failed')
        }
      }

      // 5. Attach the source files: emails → External Communication, docs → Project Files
      for (const att of attachments) {
        const destination = att.kind === 'email' ? 'External Communication' : 'Project Files'
        const step = pushStep(`Attach "${att.fileName}" to ${destination}`)
        try {
          await uploadAttachmentToProject(projectId, att)
          settleStep(step, 'done')
        } catch (e) {
          settleStep(step, 'failed', e instanceof Error ? e.message : 'Failed')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Project creation failed')
    } finally {
      setCreating(false)
    }
  }

  const disabled = creating || createdProjectId != null

  return (
    <Card className="border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <FolderKanban className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <CardTitle>Project proposal</CardTitle>
            <CardDescription>Review and edit before creating — nothing is saved until you click Create.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ai-project-title">Title</Label>
            <Input id="ai-project-title" value={title} disabled={disabled} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ai-project-description">Description</Label>
            <Textarea
              id="ai-project-description"
              value={description}
              disabled={disabled}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-project-start">Start date</Label>
            <Input
              id="ai-project-start"
              type="date"
              value={startDate}
              disabled={disabled}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
        </div>

        <ClientPicker
          idPrefix="ai-project"
          choice={clientChoice}
          setChoice={setClientChoice}
          clients={clients}
          matchConfidence={proposal.client.matchConfidence}
          disabled={disabled}
        />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Recipients (client share access — also saved as client contacts)</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setRecipients([...recipients, { name: '', email: '', isPrimary: recipients.length === 0 }])}
            >
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
          {recipients.length === 0 && (
            <p className="text-xs text-muted-foreground">No recipient emails found in the brief.</p>
          )}
          {recipients.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r.name}
                placeholder="Name"
                disabled={disabled}
                onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                value={r.email}
                placeholder="Email"
                disabled={disabled}
                onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label>Key dates</Label>
          {keyDates.length === 0 && <p className="text-xs text-muted-foreground">No key dates proposed.</p>}
          {keyDates.map((kd, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={kd.type}
                disabled={disabled}
                onValueChange={(value) =>
                  setKeyDates(keyDates.map((x, j) => (j === i ? { ...x, type: value as typeof kd.type } : x)))
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_DATE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace('_', '-')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={kd.date}
                disabled={disabled}
                onChange={(e) => setKeyDates(keyDates.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                onClick={() => setKeyDates(keyDates.filter((_, j) => j !== i))}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSchedule}
              disabled={disabled}
              onChange={(e) => setIncludeSchedule(e.target.checked)}
              className="h-4 w-4"
            />
            Create Gantt schedule from the standard template
          </label>
          {includeSchedule && (
            <div className="flex items-center gap-2 pl-6">
              <Label htmlFor="ai-project-anchor" className="text-xs text-muted-foreground">
                Anchor date (usually the shoot)
              </Label>
              <Input
                id="ai-project-anchor"
                type="date"
                className="w-44"
                value={anchorDate}
                disabled={disabled}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </div>
          )}
        </div>

        {steps.length > 0 && (
          <div className="space-y-1 border rounded-lg p-3 bg-muted/30">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                {step.state === 'running' && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                {step.state === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                {step.state === 'failed' && <XCircle className="w-4 h-4 text-destructive" />}
                <span>{step.label}</span>
                {step.detail && <span className="text-xs text-destructive">{step.detail}</span>}
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          {createdProjectId ? (
            <Button asChild variant="outline">
              <Link href={`/admin/projects/${createdProjectId}`}>Open project</Link>
            </Button>
          ) : (
            <Button type="button" onClick={handleCreate} disabled={creating || !title.trim()}>
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create project'
              )}
            </Button>
          )}
          {createdProjectId && (
            <p className="text-xs text-muted-foreground">
              Share password was auto-generated — view or change it in project settings.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

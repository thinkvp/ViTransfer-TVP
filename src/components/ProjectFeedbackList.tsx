'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownRight,
  Download,
  Eye,
  EyeOff,
  FolderKanban,
  Loader2,
  MessageSquare,
  Play,
  Video as VideoIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'
import { formatTimecodeDisplay } from '@/lib/timecode'
import { cn } from '@/lib/utils'

type FeedbackComment = {
  id: string
  content: string
  authorName: string
  isInternal: boolean
  timecode: string
  timecodeEnd: string | null
  parentId: string | null
  createdAt: string
  resolvedAt: string | null
  videoId: string
}

type VersionGroup = {
  videoId: string
  version: number
  versionLabel: string | null
  unresolvedCount: number
  resolvedCount: number
  comments: FeedbackComment[]
}

type VideoGroup = {
  name: string
  videoIds: string[]
  unresolvedCount: number
  versions: VersionGroup[]
}

type ProjectGroup = {
  id: string
  title: string
  companyName: string | null
  status: string
  unresolvedCount: number
  videos: VideoGroup[]
}

type ResolveScope =
  | { commentId: string }
  | { videoIds: string[] }
  | Record<string, never> // whole project

// Persist the expanded/collapsed tree (and the per-version "show done" toggle) across
// reloads so the list opens the way the user last left it. Bump the version suffix if the
// stored shape ever changes.
const COLLAPSE_STORAGE_KEY = 'vt-feedback-collapse-v1'

type PersistedCollapse = {
  projects: string[]
  videos: string[]
  versions: string[]
  showDone: string[]
}

function readPersistedCollapse(): PersistedCollapse | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedCollapse> | null
    if (!parsed || typeof parsed !== 'object') return null
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return {
      projects: arr(parsed.projects),
      videos: arr(parsed.videos),
      versions: arr(parsed.versions),
      showDone: arr(parsed.showDone),
    }
  } catch {
    return null
  }
}

// Hover-revealed "mark everything in this group done" icon button.
// Kept keyboard-accessible: focus also reveals it.
function MarkDoneButton({ title, disabled, onClick }: { title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-success-solid focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
    >
      <CheckCheck className="h-4 w-4" />
    </button>
  )
}

// Compact status indicators — an amber number means "open", a green check means "done".
// The word lives in the tooltip so the same badge can repeat down the tree without
// the "N open / N done" text stacking up and becoming hard to read.
function OpenBadge({ count }: { count: number }) {
  return (
    <span
      title={`${count} open`}
      className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary-foreground"
    >
      {count}
    </span>
  )
}

function DoneBadge() {
  return (
    <span title="All done" className="shrink-0 text-success-solid">
      <CheckCircle2 className="h-4 w-4" />
    </span>
  )
}

export default function ProjectFeedbackList() {
  const { user } = useAuth()
  const canResolve = useMemo(
    () => canDoAction(normalizeRolePermissions(user?.permissions), 'manageSharePageComments'),
    [user?.permissions]
  )

  const [projects, setProjects] = useState<ProjectGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Collapse state — expanded by default; projects that are fully done start collapsed.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const [collapsedVideos, setCollapsedVideos] = useState<Set<string>>(new Set())
  const [collapsedVersions, setCollapsedVersions] = useState<Set<string>>(new Set())
  const [showDoneVersions, setShowDoneVersions] = useState<Set<string>>(new Set())
  const initialisedCollapse = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/feedback', { cache: 'no-store' })
      if (!res.ok) {
        setProjects([])
        return
      }
      const data = await res.json()
      const loaded = (data.projects || []) as ProjectGroup[]
      setProjects(loaded)

      // On first load, restore the last expanded/collapsed state from localStorage. With no
      // saved state, fall back to collapsing anything with nothing open so the list leads with
      // work: fully-done projects, and individual videos whose feedback is all done.
      if (!initialisedCollapse.current) {
        initialisedCollapse.current = true
        const persisted = readPersistedCollapse()
        if (persisted) {
          setCollapsedProjects(new Set(persisted.projects))
          setCollapsedVideos(new Set(persisted.videos))
          setCollapsedVersions(new Set(persisted.versions))
          setShowDoneVersions(new Set(persisted.showDone))
        } else {
          setCollapsedProjects(new Set(loaded.filter((p) => p.unresolvedCount === 0).map((p) => p.id)))
          setCollapsedVideos(
            new Set(
              loaded.flatMap((p) =>
                p.videos.filter((v) => v.unresolvedCount === 0).map((v) => `${p.id}::${v.name}`)
              )
            )
          )
          setCollapsedVersions(
            new Set(
              loaded.flatMap((p) =>
                p.videos.flatMap((v) =>
                  v.versions.filter((ver) => ver.unresolvedCount === 0).map((ver) => ver.videoId)
                )
              )
            )
          )
        }
      }
    } catch {
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Persist collapse/expand + show-done state whenever it changes, but only after the first
  // load has seeded it — otherwise the initial empty sets would clobber the saved state.
  useEffect(() => {
    if (!initialisedCollapse.current || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        COLLAPSE_STORAGE_KEY,
        JSON.stringify({
          projects: [...collapsedProjects],
          videos: [...collapsedVideos],
          versions: [...collapsedVersions],
          showDone: [...showDoneVersions],
        } satisfies PersistedCollapse)
      )
    } catch {
      // Ignore quota/availability errors — persistence is best-effort.
    }
  }, [collapsedProjects, collapsedVideos, collapsedVersions, showDoneVersions])

  const resolve = useCallback(
    async (projectId: string, scope: ResolveScope, resolved: boolean) => {
      if (!canResolve || busy) return
      setBusy(true)
      try {
        const res = await apiFetch('/api/admin/feedback/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved, projectId, ...scope }),
        })
        if (res.ok) {
          await load()
        }
      } finally {
        setBusy(false)
      }
    },
    [canResolve, busy, load]
  )

  // Export a video's comments as SRT — same endpoint as the share page's Export Comments.
  const exportComments = useCallback(async (projectId: string, videoId: string) => {
    try {
      const res = await apiFetch(
        `/api/comments/export-srt?projectId=${encodeURIComponent(projectId)}&videoId=${encodeURIComponent(videoId)}`
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to export comments')
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const disposition = res.headers.get('content-disposition') || ''
      const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
      const filename = match?.[1] ? decodeURIComponent(match[1]) : 'comments.srt'
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to export comments')
    }
  }, [])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  if (loading) return null
  if (projects.length === 0) return null

  const totalOpen = projects.reduce((sum, p) => sum + p.unresolvedCount, 0)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-lg">
          <MessageSquare className="h-5 w-5" />
          Feedback
          {totalOpen > 0 ? (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
              {totalOpen}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-solid/15 px-2 py-0.5 text-xs font-medium text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All done
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {projects.map((proj) => {
          const projCollapsed = collapsedProjects.has(proj.id)
          const projDone = proj.unresolvedCount === 0
          return (
            <div key={proj.id} className="overflow-hidden rounded-lg border border-border">
              {/* Project header */}
              <div
                className={cn(
                  'group flex items-center gap-2 border-border bg-muted/40 px-3 py-2',
                  !projCollapsed && 'border-b'
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(collapsedProjects, setCollapsedProjects, proj.id)}
                  className="flex flex-1 items-center gap-2.5 text-left min-w-0"
                >
                  {projCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      projDone ? 'bg-success-solid/15 text-success' : 'bg-primary/10 text-primary'
                    )}
                  >
                    {projDone ? <CheckCircle2 className="h-4 w-4" /> : <FolderKanban className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <Link
                        href={`/admin/projects/${proj.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate font-semibold hover:underline"
                      >
                        {proj.title}
                      </Link>
                      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', projectStatusBadgeClass(proj.status))}>
                        {projectStatusLabel(proj.status)}
                      </span>
                    </span>
                    {proj.companyName && (
                      <span className="block truncate text-xs text-muted-foreground">{proj.companyName}</span>
                    )}
                  </span>
                </button>
                {canResolve && proj.unresolvedCount > 0 && (
                  <MarkDoneButton
                    title="Mark all feedback in this project done"
                    disabled={busy}
                    onClick={() => resolve(proj.id, {}, true)}
                  />
                )}
                {projDone ? <DoneBadge /> : <OpenBadge count={proj.unresolvedCount} />}
              </div>

              {!projCollapsed && (
                <div className="space-y-3 px-3 py-3">
                  {proj.videos.map((vid) => {
                    const videoKey = `${proj.id}::${vid.name}`
                    const vidCollapsed = collapsedVideos.has(videoKey)
                    const vidDone = vid.unresolvedCount === 0
                    return (
                      <div
                        key={videoKey}
                        className={cn('border-l-2 pl-3', vidDone ? 'border-success-solid/50' : 'border-primary/30')}
                      >
                        {/* Video header */}
                        <div className="group flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggle(collapsedVideos, setCollapsedVideos, videoKey)}
                            className="flex flex-1 items-center gap-2 text-left min-w-0"
                          >
                            {vidCollapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <VideoIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className={cn('truncate text-sm font-medium', vidDone && 'text-muted-foreground')}>{vid.name}</span>
                            {vid.unresolvedCount > 0 ? <OpenBadge count={vid.unresolvedCount} /> : <DoneBadge />}
                          </button>
                          {canResolve && vid.unresolvedCount > 0 && (
                            <MarkDoneButton
                              title="Mark every version of this video done"
                              disabled={busy}
                              onClick={() => resolve(proj.id, { videoIds: vid.videoIds }, true)}
                            />
                          )}
                        </div>

                        {!vidCollapsed && (
                          <div className="mt-1.5 space-y-1.5">
                            {vid.versions.map((ver) => {
                              const verCollapsed = collapsedVersions.has(ver.videoId)
                              const showDone = showDoneVersions.has(ver.videoId)
                              const openComments = ver.comments.filter((c) => !c.resolvedAt)
                              const doneComments = ver.comments.filter((c) => c.resolvedAt)
                              return (
                                <div key={ver.videoId} className="rounded-md bg-muted/30">
                                  {/* Version header */}
                                  <div className="flex items-center gap-2 px-2 py-1.5">
                                    <button
                                      type="button"
                                      onClick={() => toggle(collapsedVersions, setCollapsedVersions, ver.videoId)}
                                      className="flex flex-1 items-center gap-2 text-left min-w-0"
                                    >
                                      {verCollapsed ? (
                                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                      ) : (
                                        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                      )}
                                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-foreground">
                                        {ver.versionLabel || `v${ver.version}`}
                                      </span>
                                      {/* Per-version count only when a video has multiple versions —
                                          otherwise it just duplicates the video badge above. */}
                                      {vid.versions.length > 1 &&
                                        (ver.unresolvedCount > 0 ? (
                                          <OpenBadge count={ver.unresolvedCount} />
                                        ) : (
                                          <DoneBadge />
                                        ))}
                                    </button>
                                    {ver.resolvedCount > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => toggle(showDoneVersions, setShowDoneVersions, ver.videoId)}
                                        title={showDone ? 'Hide done comments' : `Show ${ver.resolvedCount} done`}
                                        className={cn(
                                          'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
                                          showDone ? 'text-success' : 'text-muted-foreground hover:text-foreground'
                                        )}
                                      >
                                        {showDone ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                        {!showDone && ver.resolvedCount}
                                      </button>
                                    )}
                                    <Link
                                      href={`/admin/projects/${proj.id}/share?video=${encodeURIComponent(vid.name)}&version=${ver.version}`}
                                      title="Open this version on the share page"
                                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                                    >
                                      <Play className="h-3.5 w-3.5" />
                                    </Link>
                                    <button
                                      type="button"
                                      onClick={() => exportComments(proj.id, ver.videoId)}
                                      title="Export this version's comments (SRT)"
                                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                    </button>
                                  </div>

                                  {!verCollapsed && (
                                    <div className="space-y-0.5 px-2 pb-2">
                                      {openComments.map((c) => (
                                        <FeedbackRow
                                          key={c.id}
                                          comment={c}
                                          canResolve={canResolve}
                                          busy={busy}
                                          onToggle={(resolved) => resolve(proj.id, { commentId: c.id }, resolved)}
                                        />
                                      ))}
                                      {showDone &&
                                        doneComments.map((c) => (
                                          <FeedbackRow
                                            key={c.id}
                                            comment={c}
                                            canResolve={canResolve}
                                            busy={busy}
                                            onToggle={(resolved) => resolve(proj.id, { commentId: c.id }, resolved)}
                                          />
                                        ))}
                                      {openComments.length === 0 && !showDone && (
                                        <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
                                          <Check className="h-3.5 w-3.5 text-success-solid" />
                                          All feedback on this version is done
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function FeedbackRow({
  comment,
  canResolve,
  busy,
  onToggle,
}: {
  comment: FeedbackComment
  canResolve: boolean
  busy: boolean
  onToggle: (resolved: boolean) => void
}) {
  const isResolved = !!comment.resolvedAt
  const isReply = !!comment.parentId
  return (
    <div className={cn('flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/40', isReply && 'ml-5')}>
      {canResolve ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(!isResolved)}
          title={isResolved ? 'Marked done — click to reopen' : 'Mark as done'}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50',
            isResolved
              ? 'border-success-solid bg-success-solid text-success-foreground'
              : 'border-muted-foreground/40 text-transparent hover:border-success-solid hover:text-success-solid/60'
          )}
        >
          {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
        </button>
      ) : (
        isResolved && <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-solid" />
      )}
      <div className={cn('min-w-0 flex-1 text-sm', isResolved && 'text-muted-foreground line-through')}>
        <span className="mr-1.5 inline-flex items-center gap-1.5 align-baseline text-xs text-muted-foreground">
          {isReply && <CornerDownRight className="h-3 w-3" />}
          <span className="font-medium text-foreground/80">{comment.authorName}</span>
          {/* Timecode pill — same styling as the share-page comment timecode */}
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-400/50 bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-400">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">
              {formatTimecodeDisplay(comment.timecode, { showFrames: false })}
              {comment.timecodeEnd
                ? ` – ${formatTimecodeDisplay(comment.timecodeEnd, { showFrames: false })}`
                : ''}
            </span>
          </span>
        </span>
        <span className="wrap-break-word">{comment.content}</span>
      </div>
    </div>
  )
}

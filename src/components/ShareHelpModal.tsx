'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircleCheck, CirclePlay, Compass, FolderDown, MessageSquare } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  FeedbackIllustration,
  FilesIllustration,
  LayoutIllustration,
  PlayerIllustration,
  VersionsIllustration,
} from '@/components/ShareHelpIllustrations'

/**
 * The client-facing "how does this page work" guide.
 *
 * Written for someone who has never seen a review platform before, so it names
 * on-screen controls rather than describing concepts. Sections and individual
 * points are gated on what this particular share actually offers — a project
 * with feedback switched off should never be told to leave a comment.
 */

export type ShareHelpCapabilities = {
  /** Feedback panel is visible (project is not in video-only mode). */
  canComment?: boolean
  /** Client can sign a video off from the share page. */
  canApprove?: boolean
  /** More than one version exists for the selected video. */
  hasVersions?: boolean
  /** Photo albums are shared on this project. */
  hasAlbums?: boolean
  /** There is at least one downloadable file or folder. */
  hasFiles?: boolean
  /** Client may upload files back (also gates comment attachments). */
  canUpload?: boolean
  /** The viewer has more than one project on this link. */
  canSwitchProjects?: boolean
}

type ShareHelpModalProps = ShareHelpCapabilities & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Render target, so the guide survives being opened from fullscreen video. */
  portalContainer?: HTMLElement | null
}

type Topic = {
  id: string
  label: string
  icon: typeof Compass
  illustration: React.ReactNode
  points: React.ReactNode[]
  footnote?: React.ReactNode
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-muted text-muted-foreground text-[11px] font-mono border border-border">
      {children}
    </kbd>
  )
}

function Strong({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>
}

export function ShareHelpModal({
  open,
  onOpenChange,
  canComment = true,
  canApprove = false,
  hasVersions = false,
  hasAlbums = false,
  hasFiles = false,
  canUpload = false,
  canSwitchProjects = false,
  portalContainer,
}: ShareHelpModalProps) {
  const topics = useMemo<Topic[]>(() => {
    const list: Topic[] = []

    list.push({
      id: 'layout',
      label: 'Getting around',
      icon: Compass,
      illustration: <LayoutIllustration />,
      points: [
        <>
          The bar along the top is your <Strong>breadcrumb</Strong>
          {canSwitchProjects ? <> — project, then video, then version</> : <> — video, then version</>}. Anything with a
          caret is a dropdown; use it to jump between{canSwitchProjects ? <> projects,</> : null} videos and versions.
        </>,
        <>
          <Strong>Help</Strong> sits at the top right. It is always there, so you can reopen this guide at any point.
        </>,
        <>
          The panel on the left lists everything shared with you: videos <Strong>For Review</Strong>, anything already
          <Strong> Approved</Strong>
          {hasAlbums ? <>, photo albums</> : null}
          {hasFiles ? <>, and files to download</> : null}. On a phone this panel sits above the video.
        </>,
        <>
          The video plays in the middle. The amber dots on the scrub bar are comments that have already been left.
        </>,
        canComment ? (
          <>
            Feedback runs down the right-hand side — the conversation above, the box you type into below. On a phone it
            sits underneath the video.
          </>
        ) : null,
      ].filter(Boolean) as React.ReactNode[],
    })

    list.push({
      id: 'player',
      label: 'Watching',
      icon: CirclePlay,
      illustration: <PlayerIllustration />,
      points: [
        <>
          Each <Strong>amber dot</Strong> on the scrub bar is a comment pinned to that moment. Click one to jump
          straight to it.
        </>,
        <>
          A comment can cover a stretch of the video rather than a single frame — that shows as an{' '}
          <Strong>amber bar</Strong> instead of a dot.
        </>,
        <>
          Playback quality, speed and fullscreen live on the control row under the video. The quality options you see
          depend on what was uploaded.
        </>,
        <>
          Keyboard: <Kbd>Space</Kbd> play or pause, <Kbd>&larr;</Kbd> <Kbd>&rarr;</Kbd> skip ten seconds,{' '}
          <Kbd>Ctrl</Kbd>+<Kbd>J</Kbd> and <Kbd>Ctrl</Kbd>+<Kbd>L</Kbd> step a single frame,{' '}
          <Kbd>Ctrl</Kbd>+<Kbd>,</Kbd> and <Kbd>Ctrl</Kbd>+<Kbd>.</Kbd> change speed.
        </>,
      ],
      footnote: <>Frame stepping pauses the video automatically. Speed runs from 0.25x to 2.0x.</>,
    })

    if (canComment) {
      list.push({
        id: 'feedback',
        label: 'Leaving feedback',
        icon: MessageSquare,
        illustration: <FeedbackIllustration />,
        points: [
          <>
            Choose how the note is attached: <Strong>Timecoded</Strong> pins it to the exact moment on screen —
            the usual choice for &ldquo;this shot is too long&rdquo; — while <Strong>General</Strong> is about the
            video as a whole.
          </>,
          <>
            The amber time pill shows where a timecoded note will land. It follows the playhead, and clicking it lets
            you type an exact time or add an <Strong>out</Strong> time so the note covers a range.
          </>,
          canUpload ? (
            <>
              Use the paperclip to attach a reference file, or the microphone to record a voice note of up to two
              minutes — often quicker than typing a tricky note.
            </>
          ) : (
            <>Use the microphone to record a voice note of up to two minutes — often quicker than typing a tricky note.</>
          ),
          <>
            <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> starts a new line. The first time you comment we
            ask for your name so we know who said what.
          </>,
          <>
            On a note that is already there you can <Strong>reply</Strong> to keep the thread together, or react to it.
            The clock icon above the list switches between sorting by timecode and newest first.
          </>,
        ],
      })
    }

    if (hasVersions || canApprove) {
      list.push({
        id: 'versions',
        label: 'Versions & sign-off',
        icon: CircleCheck,
        illustration: <VersionsIllustration />,
        points: [
          <>
            Every re-cut is a new <Strong>version</Strong> under the same video. Pick one from the version dropdown to
            look back at it; if you are not on the newest we flag{' '}
            <span className="text-warning">(Newer version available)</span> beside it.
          </>,
          <>
            Once you have left every note on a version, click <Strong>Request Next Version</Strong>. That is the signal
            we act on — it tells us your feedback is complete and we can start the re-cut.
          </>,
          canApprove ? (
            <>
              When a cut is right, <Strong>Approve Video</Strong> signs it off and, where we have made them available,
              unlocks the final files for download.
            </>
          ) : null,
          <>
            Approving closes comments on that video and leaves only the approved version on the page, so do it once you
            are genuinely happy.
          </>,
        ].filter(Boolean) as React.ReactNode[],
      })
    }

    if (hasFiles || hasAlbums || canUpload) {
      list.push({
        id: 'files',
        label: hasAlbums && !hasFiles ? 'Photos' : 'Photos & files',
        icon: FolderDown,
        illustration: <FilesIllustration />,
        points: [
          hasFiles ? (
            <>
              <Strong>Files</Strong> in the left panel opens the file browser. Folders are on the left, their contents
              on the right.
            </>
          ) : null,
          hasFiles ? (
            <>
              Tick the files you want and use <Strong>Download</Strong>. Picking several bundles them into a single ZIP
              rather than a pile of separate downloads.
            </>
          ) : null,
          hasAlbums ? (
            <>
              <Strong>Photo albums</Strong> open as a grid — click any photo to see it full size, and download from
              there.
            </>
          ) : null,
          canUpload ? (
            <>
              You can send files back to us too: drag them onto the file browser, or use the upload button. They land in
              a folder we can see straight away.
            </>
          ) : null,
        ].filter(Boolean) as React.ReactNode[],
        footnote: hasFiles ? (
          <>Large downloads keep going in the background — the progress panel in the left column tracks them.</>
        ) : undefined,
      })
    }

    return list
  }, [canApprove, canComment, canSwitchProjects, canUpload, hasAlbums, hasFiles, hasVersions])

  const [activeId, setActiveId] = useState(topics[0]?.id ?? 'layout')

  // Reopening the guide should start at the beginning rather than wherever the
  // reader happened to stop last time.
  useEffect(() => {
    if (open) setActiveId(topics[0]?.id ?? 'layout')
  }, [open, topics])

  const active = topics.find((t) => t.id === activeId) ?? topics[0]
  if (!active) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        portalContainer={portalContainer}
        className="max-w-[min(56rem,95vw)] w-full h-[min(88dvh,52rem)] p-0 gap-0 flex flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 px-5 pt-5 pb-4 border-b border-border text-left">
          <DialogTitle>Using this page</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A short tour of how to watch, comment and sign off.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
          {/* Topic rail — a column on desktop, a scrolling strip of pills on mobile */}
          <nav
            aria-label="Help topics"
            className="shrink-0 sm:w-48 border-b sm:border-b-0 sm:border-r border-border bg-muted/30 flex sm:flex-col gap-1 p-2 overflow-x-auto sm:overflow-y-auto"
          >
            {topics.map((topic) => {
              const Icon = topic.icon
              const isActive = topic.id === active.id
              return (
                <button
                  key={topic.id}
                  type="button"
                  onClick={() => setActiveId(topic.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-left whitespace-nowrap transition-colors shrink-0 sm:w-full',
                    isActive
                      ? 'bg-primary/15 text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : '')} />
                  {topic.label}
                </button>
              )
            })}
          </nav>

          {/* Topic body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
            <div className="mb-4">{active.illustration}</div>
            <ol className="space-y-3">
              {active.points.map((point, index) => (
                <li key={index} className="flex gap-3 text-sm text-muted-foreground leading-relaxed">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 h-5 w-5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold flex items-center justify-center"
                  >
                    {index + 1}
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ol>
            {active.footnote ? (
              <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">{active.footnote}</p>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-border">
          <p className="text-xs text-muted-foreground">
            Still stuck? Reply to the email that brought you here and we will walk you through it.
          </p>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ShareHelpModal

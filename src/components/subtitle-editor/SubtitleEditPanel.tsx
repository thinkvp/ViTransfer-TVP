'use client'

/**
 * Subtitle edit panel — swapped into the feedback grid's right column (in
 * place of the comments section) while subtitle edit mode is active. Shares
 * one useSubtitleEditor instance with the timeline strip.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Loader2, Search, X, Download, FileText, RefreshCw, Undo2,
  Scissors, ArrowDownToLine, Trash2, Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAX_CUE_TEXT_LENGTH } from '@/lib/subtitles'
import { formatCueTimestamp } from '@/lib/subtitles'
import { parseFlexibleTimestampMs, type EditorCue } from '@/lib/subtitle-edit'
import type { SubtitleEditorApi } from '@/hooks/useSubtitleEditor'

// Beyond this many cues, only render matches/first page to keep the DOM light.
const RENDER_WINDOW = 1500
// Suppress active-cue autoscroll for a moment after the user scrolls the list.
const MANUAL_SCROLL_SUPPRESS_MS = 3000

function TimestampInput({
  valueMs,
  onCommit,
  ariaLabel,
}: {
  valueMs: number
  onCommit: (ms: number) => void
  ariaLabel: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? formatCueTimestamp(valueMs)

  function commit() {
    if (draft === null) return
    const parsed = parseFlexibleTimestampMs(draft)
    setDraft(null)
    if (parsed !== null && parsed !== valueMs) onCommit(parsed)
  }

  return (
    <input
      type="text"
      aria-label={ariaLabel}
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur() }
      }}
      className="w-[92px] text-[11px] tabular-nums text-foreground bg-background border border-input rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
    />
  )
}

/** Textarea that grows to fit its wrapped content (no inner scrollbar). */
function AutoGrowTextarea({
  value,
  onFocus,
  onChange,
  className,
}: {
  value: string
  onFocus: () => void
  onChange: (v: string) => void
  className: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(() => { resize() }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      maxLength={MAX_CUE_TEXT_LENGTH}
      onFocus={onFocus}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      className={className}
    />
  )
}

export function SubtitleEditPanel({ editor }: { editor: SubtitleEditorApi }) {
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const lastManualScrollRef = useRef(0)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const searching = search.trim() !== ''
  const filteredCues = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = q ? editor.cues.filter((c) => c.text.toLowerCase().includes(q)) : editor.cues
    return matches.slice(0, RENDER_WINDOW)
  }, [editor.cues, search])

  const hiddenCount = useMemo(() => {
    const q = search.trim().toLowerCase()
    const total = q ? editor.cues.filter((c) => c.text.toLowerCase().includes(q)).length : editor.cues.length
    return Math.max(0, total - RENDER_WINDOW)
  }, [editor.cues, search])

  // Auto-scroll the active (playing) cue into view — suppressed briefly after
  // a manual scroll, and entirely while a search filter is applied.
  useEffect(() => {
    if (!editor.activeCueId || searching) return
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_SUPPRESS_MS) return
    const el = rowRefs.current.get(editor.activeCueId)
    el?.scrollIntoView({ block: 'nearest' })
  }, [editor.activeCueId, searching])

  function cueRow(cue: EditorCue, ordinal: number) {
    const isSelected = editor.selectedCueId === cue.id
    const isActive = editor.activeCueId === cue.id
    return (
      <div
        key={cue.id}
        ref={(el) => { if (el) rowRefs.current.set(cue.id, el); else rowRefs.current.delete(cue.id) }}
        onClick={() => editor.selectCue(cue.id, { seek: true })}
        className={cn(
          'border rounded-md p-2 cursor-pointer transition-colors',
          isSelected ? 'border-primary ring-1 ring-primary/40' : 'border-border',
          isActive ? 'bg-primary/10' : 'bg-muted/20 hover:bg-muted/40',
        )}
      >
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">#{ordinal}</span>
          <TimestampInput
            valueMs={cue.startMs}
            ariaLabel="Cue start time"
            onCommit={(ms) => editor.retimeCue(cue.id, { startMs: ms, endMs: cue.endMs }, 'resize-start')}
          />
          <span className="text-[11px] text-muted-foreground">→</span>
          <TimestampInput
            valueMs={cue.endMs}
            ariaLabel="Cue end time"
            onCommit={(ms) => editor.retimeCue(cue.id, { startMs: cue.startMs, endMs: ms }, 'resize-end')}
          />
          <div className="flex-1" />
          <button
            type="button"
            title="Split (at playhead if inside this cue, else midpoint)"
            aria-label="Split cue"
            onClick={(e) => { e.stopPropagation(); editor.splitAt(cue.id) }}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <Scissors className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Merge with next cue"
            aria-label="Merge with next cue"
            onClick={(e) => { e.stopPropagation(); editor.mergeNext(cue.id) }}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Delete cue"
            aria-label="Delete cue"
            onClick={(e) => { e.stopPropagation(); editor.remove(cue.id) }}
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <AutoGrowTextarea
          value={cue.text}
          onFocus={editor.beginTextEdit}
          onChange={(v) => editor.updateCueText(cue.id, v)}
          className="w-full resize-none overflow-hidden text-sm text-foreground bg-background border border-input rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">Edit subtitles</p>
          <p className="text-xs text-muted-foreground truncate">
            English (auto-generated) — {editor.videoName} {editor.versionLabel}
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          aria-label="Close subtitle editor"
          title="Close subtitle editor"
          onClick={editor.confirmAndExit}
          className="h-8 w-8 shrink-0"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Search */}
      <div className="relative px-3 py-2 shrink-0">
        <Search className="absolute left-5.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search subtitles…"
          className="pl-8 h-8"
        />
      </div>

      {/* Cue list */}
      <div
        ref={listRef}
        onScroll={() => { lastManualScrollRef.current = Date.now() }}
        className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 space-y-2"
      >
        {editor.loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading subtitles…
          </div>
        ) : filteredCues.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {searching ? 'No subtitles match your search.' : 'No subtitles found.'}
          </p>
        ) : (
          <>
            {filteredCues.map((cue) => cueRow(cue, editor.cues.indexOf(cue) + 1))}
            {hiddenCount > 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {hiddenCount} more cue{hiddenCount === 1 ? '' : 's'} not shown — refine your search to find them.
              </p>
            )}
          </>
        )}
      </div>

      {/* Status */}
      {(editor.error || editor.notice) && (
        <p className={cn('px-3 pb-1 text-xs shrink-0', editor.error ? 'text-destructive' : 'text-green-600 dark:text-green-500')}>
          {editor.error || editor.notice}
        </p>
      )}
      {!editor.canSave && !editor.loading && (
        <p className="px-3 pb-1 text-xs text-muted-foreground shrink-0">
          Subtitles must keep at least one cue — deleting all of them cannot be saved.
        </p>
      )}

      {/* Footer actions */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-border shrink-0">
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={editor.insertAtPlayhead} title="Insert a cue at the playhead">
          <Plus className="w-3.5 h-3.5 mr-1" /> Insert
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!editor.canUndo} onClick={editor.undo}>
          <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={editor.loading || editor.cues.length === 0} onClick={editor.exportTranscript}>
          <FileText className="w-3.5 h-3.5 mr-1" /> .txt
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={editor.loading || editor.cues.length === 0} onClick={editor.exportSrt}>
          <Download className="w-3.5 h-3.5 mr-1" /> SRT
        </Button>
        {editor.isAdmin && (
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void editor.regenerate()} title="Regenerate from audio (overwrites edits)">
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regen
          </Button>
        )}
        <div className="flex-1" />
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!editor.dirty || editor.saving} onClick={editor.discard}>
          Discard
        </Button>
        <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={!editor.dirty || editor.saving || editor.loading || !editor.canSave} onClick={() => void editor.save()}>
          {editor.saving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { SmilePlus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { REACTION_EMOJIS, formatReactionTooltip, type CommentReactionSummary } from '@/lib/comment-reactions'

interface CommentReactionBarProps {
  reactions?: CommentReactionSummary[]
  /** Omit (or pass canReact={false}) to render read-only counts with no picker. */
  onToggle?: (emoji: string, nextActive: boolean) => void
  canReact?: boolean
  /** Replies use the compact scale so threads stay calm. */
  size?: 'default' | 'sm'
}

/**
 * Emoji reaction pills for a comment or reply.
 *
 * Renders nothing at all when there are no reactions and the viewer can't add one — an
 * empty affordance on every comment in a long thread is noise.
 */
export function CommentReactionBar({
  reactions,
  onToggle,
  canReact = false,
  size = 'default',
}: CommentReactionBarProps) {
  // The picker is controlled purely so it can close itself. Its emoji are plain buttons
  // rather than DropdownMenuItems — the menu-item styling fights the emoji grid — so Radix
  // never sees a select event and would otherwise leave the popup open after a choice.
  const [pickerOpen, setPickerOpen] = useState(false)

  const items = (reactions || []).filter((reaction) => reaction.count > 0)
  const interactive = canReact && !!onToggle

  if (items.length === 0 && !interactive) return null

  const isSmall = size === 'sm'
  const pillClass = isSmall ? 'h-5 px-1.5 text-[11px] gap-1' : 'h-6 px-2 text-xs gap-1.5'
  const addClass = isSmall ? 'h-5 w-5' : 'h-6 w-6'
  const iconClass = isSmall ? 'h-2.5 w-2.5' : 'h-3 w-3'

  return (
    <div className={`flex flex-wrap items-center ${isSmall ? 'gap-1' : 'gap-1.5'}`}>
      {items.map((reaction) => {
        // Who reacted, e.g. "You and Sarah Mitchell reacted". Falls back to the plain
        // action hint only for viewers the DTO withholds names from.
        const who = formatReactionTooltip(reaction)

        return (
          <button
            key={reaction.emoji}
            type="button"
            disabled={!interactive}
            onClick={interactive ? () => onToggle!(reaction.emoji, !reaction.viewerReacted) : undefined}
            title={who || (interactive ? (reaction.viewerReacted ? 'Remove your reaction' : 'Add your reaction') : undefined)}
            className={`inline-flex items-center rounded-full border font-medium leading-none transition-colors ${pillClass} ${
              reaction.viewerReacted
                ? 'border-primary/50 bg-primary/15 text-primary'
                : 'border-border text-muted-foreground'
            } ${interactive ? 'hover:border-muted-foreground/50 hover:text-foreground cursor-pointer' : 'cursor-default'}`}
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span className="tabular-nums">{reaction.count}</span>
            <span className="sr-only">
              {reaction.emoji} — {reaction.count} {reaction.count === 1 ? 'reaction' : 'reactions'}
              {reaction.viewerReacted ? ', including yours' : ''}
            </span>
          </button>
        )
      })}

      {interactive && (
        <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add reaction"
              title="Add reaction"
              className={`inline-flex items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-solid hover:text-foreground ${addClass} ${
                // Dimmed until hover on replies only — a full-strength button on every reply
                // in a long thread reads as clutter.
                isSmall ? 'opacity-50 hover:opacity-100 focus-visible:opacity-100' : ''
              }`}
            >
              <SmilePlus className={iconClass} />
            </button>
          </DropdownMenuTrigger>
          {/* data-reaction-picker opts this menu out of the exit animation — see globals.css.
              Without it Radix leaves the closed menu mounted and visible. */}
          <DropdownMenuContent data-reaction-picker align="start" className="flex w-auto min-w-0 gap-0.5 p-1">
            {REACTION_EMOJIS.map((emoji) => {
              const active = items.some((item) => item.emoji === emoji && item.viewerReacted)
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    // Closes on both adding and removing — one click, one decision.
                    onToggle!(emoji, !active)
                    setPickerOpen(false)
                  }}
                  aria-label={active ? `Remove ${emoji} reaction` : `React with ${emoji}`}
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-base leading-none transition-colors hover:bg-accent ${
                    active ? 'bg-primary/15' : ''
                  }`}
                >
                  {emoji}
                </button>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export default CommentReactionBar

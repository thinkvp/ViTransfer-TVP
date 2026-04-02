"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoResize?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize, onChange, ...props }, ref) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null)

    const resize = React.useCallback(() => {
      const el = innerRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }, [])

    React.useEffect(() => {
      if (autoResize) resize()
    }, [autoResize, props.value, resize])

    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          autoResize && "resize-none overflow-hidden",
          className
        )}
        ref={(el) => {
          innerRef.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        onChange={(e) => {
          onChange?.(e)
          if (autoResize) resize()
        }}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }

"use client"

import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

export type CheckboxProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked = false, disabled, onCheckedChange, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled ? true : undefined}
      disabled={disabled}
      onClick={(e) => {
        props.onClick?.(e)
        if (disabled) return
        onCheckedChange?.(!checked)
      }}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded-sm border border-input bg-background ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        checked && "bg-primary text-primary-foreground border-primary",
        className
      )}
      {...props}
    >
      {checked ? <Check className="h-3.5 w-3.5 pointer-events-none" /> : null}
    </button>
  )
)
Checkbox.displayName = "Checkbox"

export { Checkbox }

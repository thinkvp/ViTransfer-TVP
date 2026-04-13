'use client'

import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type AccountingTableActionButtonProps = Omit<ComponentProps<typeof Button>, 'variant' | 'size'> & {
  destructive?: boolean
}

export function AccountingTableActionButton({ className, destructive = false, children, ...props }: AccountingTableActionButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn(
        'h-9 w-9 rounded-full p-0',
        destructive && 'border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive',
        className,
      )}
      {...props}
    >
      {children}
    </Button>
  )
}
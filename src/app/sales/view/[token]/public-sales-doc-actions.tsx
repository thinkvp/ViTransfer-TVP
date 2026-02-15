'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Download, CheckCircle2, CreditCard } from 'lucide-react'
import { downloadInvoicePdf, downloadQuotePdf } from '@/lib/sales/pdf'
import { getCurrencySymbol } from '@/lib/sales/currency'

type DocType = 'QUOTE' | 'INVOICE'

type Props = {
  token: string
  type: DocType
  doc: any
  settings: any
  clientName: string
  clientAddress?: string
  projectTitle?: string | null
  canAcceptQuote?: boolean
  canPayInvoice?: boolean
  payLabel?: string | null
  processingFeeCents?: number | null
  processingFeeCurrency?: string | null
  currencyCode?: string | null
}

export default function PublicSalesDocActions(props: Props) {
  const router = useRouter()
  const [downloading, setDownloading] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptedLocal, setAcceptedLocal] = useState(false)
  const [paying, setPaying] = useState(false)

  const info = useMemo(
    () => ({
      clientName: props.clientName || undefined,
      clientAddress: props.clientAddress || undefined,
      projectTitle: props.projectTitle || undefined,
      stripeProcessingFeeCents: typeof props.processingFeeCents === 'number' ? props.processingFeeCents : undefined,
      stripeProcessingFeeCurrency: typeof props.processingFeeCurrency === 'string' ? props.processingFeeCurrency : undefined,
      publicQuoteUrl: props.type === 'QUOTE'
        ? `${typeof window !== 'undefined' ? window.location.origin : ''}/sales/view/${props.token}`
        : undefined,
      publicInvoiceUrl: props.type === 'INVOICE'
        ? `${typeof window !== 'undefined' ? window.location.origin : ''}/sales/view/${props.token}`
        : undefined,
    }),
    [props.clientAddress, props.clientName, props.processingFeeCents, props.processingFeeCurrency, props.projectTitle, props.token, props.type]
  )

  const onDownload = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      if (props.type === 'QUOTE') {
        await downloadQuotePdf(props.doc, props.settings, info)
      } else {
        await downloadInvoicePdf(props.doc, props.settings, info)
      }
    } finally {
      setDownloading(false)
    }
  }, [downloading, info, props.doc, props.settings, props.type])

  const onAccept = useCallback(async () => {
    if (!props.canAcceptQuote || acceptedLocal || accepting) return
    setAccepting(true)
    try {
      const res = await fetch(`/api/sales/view/${encodeURIComponent(props.token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        const message = typeof data?.error === 'string' ? data.error : 'Unable to accept quote'
        alert(message)
        return
      }

      setAcceptedLocal(true)
      router.refresh()
    } finally {
      setAccepting(false)
    }
  }, [accepting, acceptedLocal, props.canAcceptQuote, props.token, router])

  const onPay = useCallback(async () => {
    if (!props.canPayInvoice || paying) return
    setPaying(true)
    try {
      const res = await fetch(`/api/sales/view/${encodeURIComponent(props.token)}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = typeof data?.error === 'string' ? data.error : 'Unable to start payment'
        alert(message)
        return
      }

      const url = typeof data?.url === 'string' ? data.url : ''
      if (!url) {
        alert('Unable to start payment')
        return
      }

      window.location.href = url
    } finally {
      setPaying(false)
    }
  }, [paying, props.canPayInvoice, props.token])

  const payLabel = typeof props.payLabel === 'string' && props.payLabel.trim() ? props.payLabel.trim() : null
  const feeCents = typeof props.processingFeeCents === 'number' && Number.isFinite(props.processingFeeCents) ? Math.max(0, Math.trunc(props.processingFeeCents)) : 0
  const feeCurrency = typeof props.processingFeeCurrency === 'string' && props.processingFeeCurrency.trim() ? props.processingFeeCurrency.trim().toUpperCase() : ''
  const currencyCode = typeof props.currencyCode === 'string' && props.currencyCode.trim() ? props.currencyCode.trim() : 'AUD'
  const feeCurrencySymbol = getCurrencySymbol(currencyCode)
  const feeText = feeCents > 0
    ? `Attracts ${feeCurrencySymbol}${(feeCents / 100).toFixed(2)} in card processing fees`
    : null

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.type === 'INVOICE' && props.canPayInvoice && (
          <Button
            type="button"
            onClick={() => void onPay()}
            disabled={paying}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <CreditCard className="h-4 w-4 mr-2" />
            {paying ? 'Redirecting…' : 'Pay Invoice'}
          </Button>
        )}

        {props.type === 'QUOTE' && props.canAcceptQuote && (
          acceptedLocal ? (
            <div className="inline-flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Accepted
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => void onAccept()}
              disabled={accepting}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {accepting ? 'Accepting…' : 'Accept Quote'}
            </Button>
          )
        )}

        <Button
          type="button"
          variant="outline"
          onClick={() => void onDownload()}
          disabled={downloading}
        >
          <Download className="h-4 w-4 mr-2" />
          {downloading ? 'Preparing…' : 'Download PDF'}
        </Button>
      </div>

      {props.type === 'INVOICE' && props.canPayInvoice && payLabel && (
        <div className="text-xs text-muted-foreground max-w-[340px] text-right">{payLabel}</div>
      )}

      {props.type === 'INVOICE' && props.canPayInvoice && feeText && (
        <div className="text-xs text-muted-foreground max-w-[340px] text-right">{feeText}</div>
      )}
    </div>
  )
}

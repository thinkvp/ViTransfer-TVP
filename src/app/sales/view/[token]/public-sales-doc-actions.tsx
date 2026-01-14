'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Download, CheckCircle2 } from 'lucide-react'
import { downloadInvoicePdf, downloadQuotePdf } from '@/lib/sales/pdf'

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
}

export default function PublicSalesDocActions(props: Props) {
  const router = useRouter()
  const [downloading, setDownloading] = useState(false)
  const [accepting, setAccepting] = useState(false)

  const info = useMemo(
    () => ({
      clientName: props.clientName || undefined,
      clientAddress: props.clientAddress || undefined,
      projectTitle: props.projectTitle || undefined,
      publicQuoteUrl: props.type === 'QUOTE'
        ? `${typeof window !== 'undefined' ? window.location.origin : ''}/sales/view/${props.token}`
        : undefined,
    }),
    [props.clientAddress, props.clientName, props.projectTitle, props.token, props.type]
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
    if (!props.canAcceptQuote || accepting) return
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

      router.refresh()
    } finally {
      setAccepting(false)
    }
  }, [accepting, props.canAcceptQuote, props.token, router])

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {props.type === 'QUOTE' && props.canAcceptQuote && (
        <Button
          type="button"
          onClick={() => void onAccept()}
          disabled={accepting}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          {accepting ? 'Accepting…' : 'Accept Quote'}
        </Button>
      )}
      <Button
        type="button"
        onClick={() => void onDownload()}
        disabled={downloading}
        className="bg-blue-600 hover:bg-blue-700 text-white"
      >
        <Download className="h-4 w-4 mr-2" />
        {downloading ? 'Preparing…' : 'Download PDF'}
      </Button>
    </div>
  )
}

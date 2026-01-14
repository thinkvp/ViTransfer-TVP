'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiJson } from '@/lib/api-client'

type QboInvoiceImport = {
  id: string
  qboId: string
  docNumber: string | null
  txnDate: string | null
  dueDate: string | null
  totalAmt: string | number | null
  balance: string | number | null
  customerQboId: string | null
  customerName: string | null
  privateNote: string | null
  lastUpdatedTime: string | null
  raw: any
  createdAt: string
  updatedAt: string
}

export default function InvoiceImportDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id

  const [item, setItem] = useState<QboInvoiceImport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const run = async () => {
      if (!id) return
      setLoading(true)
      setError(null)
      try {
        const data = await apiJson<{ item: QboInvoiceImport }>(`/api/sales/quickbooks/imports/invoices/${encodeURIComponent(id)}`, {
          cache: 'no-store',
        })
        setItem(data.item)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load import')
      } finally {
        setLoading(false)
      }
    }
    void run()
  }, [id])

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">QuickBooks Invoice Import</h2>
          <p className="text-sm text-muted-foreground">Raw pull stored in the test DB.</p>
        </div>
        <Link href="/admin/sales/invoices">
          <Button variant="outline">Back to invoices</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="py-10 text-center text-destructive">{error}</div>
          ) : !item ? (
            <div className="py-10 text-center text-muted-foreground">Not found.</div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-muted-foreground">Doc number</div>
                  <div className="font-medium">{item.docNumber ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">QBO Id</div>
                  <div className="font-medium">{item.qboId}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Txn date</div>
                  <div className="font-medium">{item.txnDate ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Due date</div>
                  <div className="font-medium">{item.dueDate ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Total</div>
                  <div className="font-medium">{item.totalAmt ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Balance</div>
                  <div className="font-medium">{item.balance ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Customer</div>
                  <div className="font-medium">{item.customerName ?? item.customerQboId ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last updated</div>
                  <div className="font-medium">{item.lastUpdatedTime ?? '—'}</div>
                </div>
              </div>

              {item.privateNote ? (
                <div className="text-sm">
                  <div className="text-muted-foreground">Private note</div>
                  <div className="whitespace-pre-wrap">{item.privateNote}</div>
                </div>
              ) : null}

              <div>
                <div className="text-sm text-muted-foreground mb-2">Raw payload</div>
                <pre className="text-xs overflow-auto rounded-md border border-border bg-muted/20 p-3">
                  {JSON.stringify(item.raw, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

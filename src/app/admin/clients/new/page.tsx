'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ClientCreateForm } from '@/components/admin/clients/ClientCreateForm'

export default function NewClientPage() {
  const router = useRouter()

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-(--breakpoint-2xl) mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/clients">
            <Button variant="ghost" size="default" className="justify-start px-3">
              <ArrowLeft className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Back to Clients</span>
              <span className="sm:hidden">Back</span>
            </Button>
          </Link>
        </div>

        <div className="max-w-2xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>Add New Client</CardTitle>
              <CardDescription>Create a client record and default recipients</CardDescription>
            </CardHeader>
            <CardContent>
              <ClientCreateForm
                onCreated={(client) => router.push(`/admin/clients/${client.id}`)}
                onCancel={() => router.push('/admin/clients')}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

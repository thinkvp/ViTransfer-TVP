'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'

export default function ExpenseFormPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  useEffect(() => {
    if (params?.id) {
      router.replace(`/admin/accounting/expenses?edit=${params.id}`)
    }
  }, [params?.id, router])
  return null
}

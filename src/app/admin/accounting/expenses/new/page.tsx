'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function NewExpensePage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/admin/accounting/expenses?new=1')
  }, [router])
  return null
}


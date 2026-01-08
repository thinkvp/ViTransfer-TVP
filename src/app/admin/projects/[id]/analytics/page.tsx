'use client'

import { useParams } from 'next/navigation'
import ProjectAnalyticsClient from '@/components/admin/ProjectAnalyticsClient'

export default function ProjectAnalyticsPage() {
  const params = useParams()

  if (!params?.id) {
    return null
  }

  const id = params.id as string

  return <ProjectAnalyticsClient id={id} />
}

'use client'

import { useParams } from 'next/navigation'
import ProjectGanttClient from '@/components/admin/gantt/ProjectGanttClient'

export default function ProjectGanttPage() {
  const params = useParams()

  if (!params?.id) {
    return null
  }

  const id = params.id as string

  return <ProjectGanttClient id={id} />
}

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'

export interface ShareUploadProjectContext {
  id: string
  sharePassword: string | null
  authMode: string
  allowClientUploadFiles: boolean
  maxClientUploadAllocationMB: number
  title: string | null
  companyName: string | null
  clientName: string | null
}

export interface ShareUploadAccessContext {
  project: ShareUploadProjectContext
  canRead: boolean
  canUpload: boolean
  canDelete: boolean
  isAdmin: boolean
  isGuest: boolean
  shareTokenSessionId?: string
}

export function resolveProjectStoragePath(project: ShareUploadProjectContext): string {
  return buildProjectStorageRoot(project.clientName || project.companyName || 'Client', project.title || 'Untitled')
}

export async function resolveShareUploadAccess(
  request: NextRequest,
  shareSlug: string,
): Promise<ShareUploadAccessContext | Response> {
  const project = await prisma.project.findUnique({
    where: { slug: shareSlug },
    select: {
      id: true,
      sharePassword: true,
      authMode: true,
      allowClientUploadFiles: true,
      maxClientUploadAllocationMB: true, title: true,
      companyName: true,
      client: { select: { name: true } },
    },
  })

  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const access = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)
  if (!access.authorized) {
    return access.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isGuest = access.isGuest === true
  const canRead = !isGuest
  const canUpload = access.isAdmin || (!isGuest && project.allowClientUploadFiles)
  const canDelete = access.isAdmin

  return {
    project: {
      id: project.id,
      sharePassword: project.sharePassword,
      authMode: project.authMode,
      allowClientUploadFiles: project.allowClientUploadFiles,
      maxClientUploadAllocationMB: project.maxClientUploadAllocationMB,
      title: project.title,
      companyName: project.companyName,
      clientName: project.client?.name || null,
    },
    canRead,
    canUpload,
    canDelete,
    isAdmin: access.isAdmin,
    isGuest,
    shareTokenSessionId: access.shareTokenSessionId,
  }
}

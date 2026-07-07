import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { resolveProjectStoragePath } from '@/lib/share-uploads'

export interface UploadFolderProjectContext {
  id: string
  status: string
  title: string | null
  companyName: string | null
  enableUploads: boolean
  clientName: string | null
}

type ApiUser = Exclude<Awaited<ReturnType<typeof requireApiUser>>, Response>

type AuthorizeResult =
  | { response: Response; auth?: undefined; project?: undefined }
  | { response?: undefined; auth: ApiUser; project: UploadFolderProjectContext }

/**
 * Shared gate for the admin upload-folder routes. Mirrors the albums routes:
 * requires `requireApiUser` + menu `projects` + action `projectsPhotoVideoUploads`,
 * plus the project assignment / status-visibility check for non-system-admins.
 * Returns either a short-circuit `response` or the resolved `{ auth, project }`.
 */
export async function authorizeUploadFolders(
  request: NextRequest,
  projectId: string,
): Promise<AuthorizeResult> {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return { response: auth }

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return { response: forbiddenMenu }

  const forbiddenAction = requireActionAccess(auth, 'projectsPhotoVideoUploads')
  if (forbiddenAction) return { response: forbiddenAction }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      status: true,
      title: true,
      companyName: true,
      enableUploads: true,
      client: { select: { name: true } },
      assignedUsers: { select: { userId: true } },
    },
  })
  if (!project) return { response: NextResponse.json({ error: 'Project not found' }, { status: 404 }) }

  if (auth.appRoleIsSystemAdmin !== true) {
    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    }
  }

  return {
    auth,
    project: {
      id: project.id,
      status: project.status,
      title: project.title,
      companyName: project.companyName,
      enableUploads: project.enableUploads,
      clientName: project.client?.name || null,
    },
  }
}

/** Build the project storage root from the upload-folder project context. */
export function resolveUploadFolderProjectStoragePath(project: UploadFolderProjectContext): string {
  return resolveProjectStoragePath({
    id: project.id,
    sharePassword: null,
    authMode: '',
    allowClientUploadFiles: false,
    maxClientUploadAllocationMB: 0,
    title: project.title,
    companyName: project.companyName,
    clientName: project.clientName,
  })
}

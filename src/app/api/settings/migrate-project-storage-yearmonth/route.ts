import * as fs from 'fs'
import * as path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getRawStoragePath, PROJECT_REDIRECT_FILENAME, setProjectRedirect } from '@/lib/storage'

export const runtime = 'nodejs'

type Result = {
  ok: true
  dryRun: boolean
  projectsChecked: number
  alreadyInYearMonthFolder: number
  movedFromLegacyRoot: number
  movedFromClosedFolder: number
  stubsCreatedOrUpdated: number
  closedFoldersPruned?: number
  sample?: {
    movedProjectIds: string[]
    missingProjectIds: string[]
    movedProjects?: Array<{ id: string; title: string }>
    missingProjects?: Array<{ id: string; title: string }>
  }
  errors?: Array<{ projectId?: string; path?: string; error: string }>
}

function toYearMonthUTC(dateLike: Date) {
  const yyyy = dateLike.getUTCFullYear()
  const mm = String(dateLike.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

function isValidYearMonth(v: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
}

async function removePureRedirectStubFolder(opts: {
  projectId: string
  dryRun: boolean
  errors: Array<{ projectId?: string; path?: string; error: string }>
}) {
  const { projectId, dryRun, errors } = opts
  const stubAbs = getRawStoragePath(`projects/${projectId}`)

  try {
    if (!fs.existsSync(stubAbs)) return
    const st = fs.statSync(stubAbs)
    if (!st.isDirectory()) return

    const children = await fs.promises.readdir(stubAbs).catch(() => [])
    const isPureStub = children.length === 1 && children[0] === PROJECT_REDIRECT_FILENAME
    if (!isPureStub) return

    if (!dryRun) {
      await fs.promises.rm(stubAbs, { recursive: true, force: true })
    }
  } catch (e: any) {
    errors.push({ projectId, path: stubAbs, error: String(e?.message || e) })
  }
}

async function pruneEmptyClosedFolders(dryRun: boolean, errors: Result['errors']) {
  let pruned = 0
  try {
    const closedRootAbs = getRawStoragePath('projects/closed')
    if (!fs.existsSync(closedRootAbs)) return 0

    const monthDirs = await fs.promises.readdir(closedRootAbs, { withFileTypes: true })
    for (const md of monthDirs) {
      if (!md.isDirectory()) continue
      if (!isValidYearMonth(md.name)) continue

      const monthAbs = path.join(closedRootAbs, md.name)
      const children = await fs.promises.readdir(monthAbs).catch(() => [])
      if (children.length === 0) {
        pruned++
        if (!dryRun) {
          await fs.promises.rm(monthAbs, { recursive: true, force: true })
        }
      }
    }

    // If closed root becomes empty, remove it too.
    const remaining = await fs.promises.readdir(closedRootAbs).catch(() => [])
    if (remaining.length === 0) {
      pruned++
      if (!dryRun) {
        await fs.promises.rm(closedRootAbs, { recursive: true, force: true })
      }
    }
  } catch (e: any) {
    errors?.push({ path: 'projects/closed', error: String(e?.message || e) })
  }

  return pruned
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  // Keep allow-listed under an existing "dangerous" settings action.
  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'migrate-project-storage-yearmonth'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
  } catch {
    // ignore
  }

  const errors: NonNullable<Result['errors']> = []

  // Scan projects/closed/* once (supports legacy installs that previously used a CLOSED archive folder).
  const closedMap = new Map<string, { ym: string; abs: string }>()
  try {
    const closedRootAbs = getRawStoragePath('projects/closed')
    if (fs.existsSync(closedRootAbs)) {
      const monthDirs = await fs.promises.readdir(closedRootAbs, { withFileTypes: true })
      for (const md of monthDirs) {
        if (!md.isDirectory()) continue
        if (!isValidYearMonth(md.name)) continue

        const monthAbs = path.join(closedRootAbs, md.name)
        const projectDirs = await fs.promises.readdir(monthAbs, { withFileTypes: true })
        for (const pd of projectDirs) {
          if (!pd.isDirectory()) continue
          const projectId = pd.name
          if (!/^c[a-z0-9]{24}$/.test(projectId)) continue
          // If duplicates exist across months, keep the latest month.
          const prev = closedMap.get(projectId)
          if (!prev || prev.ym < md.name) {
            closedMap.set(projectId, { ym: md.name, abs: path.join(monthAbs, projectId) })
          }
        }
      }
    }
  } catch (e: any) {
    errors.push({ path: 'projects/closed', error: String(e?.message || e) })
  }

  const projects = await prisma.project.findMany({
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  let alreadyInYearMonthFolder = 0
  let movedFromLegacyRoot = 0
  let movedFromClosedFolder = 0
  let stubsCreatedOrUpdated = 0

  const movedProjectIds: string[] = []
  const missingProjectIds: string[] = []

  const movedProjects: Array<{ id: string; title: string }> = []
  const missingProjects: Array<{ id: string; title: string }> = []

  for (const p of projects) {
    const ym = toYearMonthUTC(p.createdAt)
    const targetRel = `projects/${ym}/${p.id}`
    const targetAbs = getRawStoragePath(targetRel)

    const legacyAbs = getRawStoragePath(`projects/${p.id}`)

    try {
      const targetExists = fs.existsSync(targetAbs) && fs.statSync(targetAbs).isDirectory()
      if (targetExists) {
        alreadyInYearMonthFolder++

        // If an old per-project stub folder still exists, remove it (only if it's pure).
        await removePureRedirectStubFolder({ projectId: p.id, dryRun, errors })
      } else {
        // If legacy root has a real folder (not just a redirect stub), move it.
        const legacyExists = fs.existsSync(legacyAbs) && fs.statSync(legacyAbs).isDirectory()
        if (legacyExists) {
          const children = await fs.promises.readdir(legacyAbs).catch(() => [])
          const isPureStub = children.length === 1 && children[0] === PROJECT_REDIRECT_FILENAME

          if (!isPureStub) {
            movedProjectIds.push(p.id)
            movedProjects.push({ id: p.id, title: p.title })
            movedFromLegacyRoot++
            if (!dryRun) {
              await fs.promises.mkdir(path.dirname(targetAbs), { recursive: true })
              await fs.promises.rename(legacyAbs, targetAbs)
            }
          } else {
            // Legacy root exists but is only a stub; we can remove it later.
          }
        } else {
          // If the project exists under the old CLOSED archive folder, move it.
          const closed = closedMap.get(p.id)
          if (closed) {
            movedProjectIds.push(p.id)
            movedProjects.push({ id: p.id, title: p.title })
            movedFromClosedFolder++
            if (!dryRun) {
              await fs.promises.mkdir(path.dirname(targetAbs), { recursive: true })
              await fs.promises.rename(closed.abs, targetAbs)
            }
          } else {
            missingProjectIds.push(p.id)
            missingProjects.push({ id: p.id, title: p.title })
          }
        }
      }

      // Always ensure (or update) the central redirect index so stored paths like
      // projects/{projectId}/... still resolve to the YYYY-MM location.
      try {
        const didUpdate = await setProjectRedirect(p.id, targetRel, { dryRun })
        if (didUpdate) stubsCreatedOrUpdated++
      } catch (e: any) {
        errors.push({ projectId: p.id, error: String(e?.message || e) })
      }

      // After the index entry is in place, delete any old per-project stub folder (safe-only).
      await removePureRedirectStubFolder({ projectId: p.id, dryRun, errors })
    } catch (e: any) {
      errors.push({ projectId: p.id, error: String(e?.message || e) })
    }
  }

  const closedFoldersPruned = await pruneEmptyClosedFolders(dryRun, errors)

  const result: Result = {
    ok: true,
    dryRun,
    projectsChecked: projects.length,
    alreadyInYearMonthFolder,
    movedFromLegacyRoot,
    movedFromClosedFolder,
    stubsCreatedOrUpdated,
    closedFoldersPruned: dryRun ? undefined : closedFoldersPruned,
    sample: {
      movedProjectIds: movedProjectIds.slice(0, 10),
      missingProjectIds: missingProjectIds.slice(0, 10),
      movedProjects: movedProjects.slice(0, 10),
      missingProjects: missingProjects.slice(0, 10),
    },
    errors: errors.length ? errors.slice(0, 50) : undefined,
  }

  return NextResponse.json(result)
}

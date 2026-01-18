import { NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'

function readVersion(): string {
  // Prefer the repository VERSION file (used by releases), then fall back to package.json.
  try {
    const versionPath = path.join(process.cwd(), 'VERSION')
    const v = fs.readFileSync(versionPath, 'utf8').trim()
    if (v) return v
  } catch {
    // ignore
  }

  try {
    const pkgPath = path.join(process.cwd(), 'package.json')
    const pkgRaw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(pkgRaw) as { version?: string }
    if (pkg?.version) return pkg.version
  } catch {
    // ignore
  }

  return 'unknown'
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const version = readVersion()
  return NextResponse.json(
    { version },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  )
}

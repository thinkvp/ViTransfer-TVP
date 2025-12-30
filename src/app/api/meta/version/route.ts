import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'

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

export async function GET() {
  const version = readVersion()
  return NextResponse.json({ version })
}

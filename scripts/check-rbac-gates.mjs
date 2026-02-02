import fs from 'fs/promises'
import path from 'path'

const workspaceRoot = process.cwd()
const apiRoot = path.join(workspaceRoot, 'src', 'app', 'api')

const ALLOWLIST = new Set([
  // Add explicit exceptions here if needed.
  // Example: 'src/app/api/some/internal/route.ts',
])

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.isFile() && entry.name === 'route.ts') {
      files.push(full)
    }
  }
  return files
}

function toWorkspaceRel(absPath) {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/')
}

function isAdminRoute(relPath) {
  return relPath.startsWith('src/app/api/admin/')
}

function hasAuthGate(source) {
  return (
    source.includes('requireApiUser(') ||
    source.includes('requireApiAdmin(') ||
    source.includes('requireApiMenu(') ||
    source.includes('requireApiAction(') ||
    source.includes('requireApiAnyAction(') ||
    source.includes('requireApiSystemAdmin(')
  )
}

function hasRbacGate(source) {
  return (
    source.includes('requireApiMenu(') ||
    source.includes('requireApiAction(') ||
    source.includes('requireApiAnyAction(') ||
    source.includes('requireApiSystemAdmin(') ||
    source.includes('requireMenuAccess(') ||
    source.includes('requireActionAccess(') ||
    source.includes('requireAnyActionAccess(')
  )
}

const missing = []
const checked = []

for (const absPath of await walk(apiRoot)) {
  const rel = toWorkspaceRel(absPath)
  if (ALLOWLIST.has(rel)) continue

  if (!isAdminRoute(rel)) continue

  const source = await fs.readFile(absPath, 'utf8')

  checked.push(rel)

  if (!hasAuthGate(source)) {
    missing.push(rel)
    continue
  }

  if (!hasRbacGate(source)) {
    missing.push(rel)
  }
}

if (missing.length > 0) {
  console.error('\nRBAC gate check failed. These admin API routes are missing a required auth and/or RBAC gate:\n')
  for (const p of missing.sort()) console.error(`- ${p}`)
  console.error('\nFix: add requireApiUser (or requireApiMenu/Action/SystemAdmin) plus an RBAC gate (menu/action/system-admin), or add to ALLOWLIST if intentional.\n')
  process.exit(1)
}

console.log(`RBAC gate check passed (${checked.length} admin routes checked).`)

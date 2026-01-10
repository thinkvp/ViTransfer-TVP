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

function hasAdminAuthGate(source) {
  return source.includes('requireApiAdmin(')
}

function hasRbacGate(source) {
  return (
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

  const source = await fs.readFile(absPath, 'utf8')
  if (!hasAdminAuthGate(source)) continue

  checked.push(rel)
  if (!hasRbacGate(source)) {
    missing.push(rel)
  }
}

if (missing.length > 0) {
  console.error('\nRBAC gate check failed. These admin API routes use requireApiAdmin but have no RBAC menu/action gate:\n')
  for (const p of missing.sort()) console.error(`- ${p}`)
  console.error('\nFix: add requireMenuAccess + requireActionAccess (or add to ALLOWLIST if intentional).\n')
  process.exit(1)
}

console.log(`RBAC gate check passed (${checked.length} admin routes checked).`)

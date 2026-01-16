import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')

const generatedClientDir = path.join(projectRoot, 'node_modules', '.prisma', 'client')
const prismaClientShimDir = path.join(projectRoot, 'node_modules', '@prisma', 'client', '.prisma', 'client')

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function readTextIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// Prisma typically creates a symlink at node_modules/@prisma/client/.prisma -> node_modules/.prisma.
// On some Windows setups this symlink isn't created, which breaks runtime requires from @prisma/client.
const expectedEntry = path.join(prismaClientShimDir, 'default.js')
if (exists(expectedEntry)) {
  // If the shim exists but is stale (schema changed), refresh it.
  const generatedSchema = readTextIfExists(path.join(generatedClientDir, 'schema.prisma'))
  const shimSchema = readTextIfExists(path.join(prismaClientShimDir, 'schema.prisma'))
  if (generatedSchema && shimSchema && generatedSchema === shimSchema) {
    process.exit(0)
  }
}

if (!exists(generatedClientDir)) {
  console.warn('[ensure-prisma-client] Generated Prisma client not found at', generatedClientDir)
  process.exit(0)
}

try {
  copyDirRecursive(generatedClientDir, prismaClientShimDir)
  console.log('[ensure-prisma-client] Copied generated client into @prisma/client/.prisma/client')
} catch (e) {
  console.warn('[ensure-prisma-client] Failed to copy Prisma client:', e?.message || e)
}

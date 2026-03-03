import fs from 'fs'
import path from 'path'

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')
const TEMP_DIR = path.join(STORAGE_ROOT, '.worker-tmp')
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/**
 * Cleanup old temp files to prevent disk space issues
 * Deletes files older than 2 hours (likely from failed jobs)
 */
export async function cleanupOldTempFiles() {
  try {
    const entries = await fs.promises.readdir(TEMP_DIR)
    const now = Date.now()

    for (const entry of entries) {
      const entryPath = path.join(TEMP_DIR, entry)
      try {
        const stats = await fs.promises.stat(entryPath)
        const age = now - stats.mtimeMs

        if (age > TWO_HOURS_MS) {
          if (stats.isDirectory()) {
            await fs.promises.rm(entryPath, { recursive: true, force: true })
            console.log(`Cleaned up old temp directory: ${entry} (${(age / 1000 / 60).toFixed(0)} minutes old)`)
          } else {
            await fs.promises.unlink(entryPath)
            console.log(`Cleaned up old temp file: ${entry} (${(age / 1000 / 60).toFixed(0)} minutes old)`)
          }
        }
      } catch (err) {
        // Entry might have been deleted already, skip
      }
    }
  } catch (error) {
    console.error('Failed to cleanup old temp files:', error)
  }
}

/**
 * Ensure temp directory exists on startup
 */
export function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
}

export { TEMP_DIR }

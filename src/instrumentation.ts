import { ensureDefaultAdmin } from './lib/seed'
import { initializeSecuritySettings } from './lib/settings'

// Ensure the instrumentation hook only builds/runs in the Node.js runtime.
export const runtime = 'nodejs'

/**
 * Next.js Instrumentation Hook
 *
 * This file runs automatically when the Next.js server starts.
 * Used for server-side initialization tasks like seeding the database.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on Node.js runtime (not Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[INIT] Running server initialization...')

    try {
      await ensureDefaultAdmin()

      // Initialize security settings from environment variables
      await initializeSecuritySettings()

      // Publish this process's storage config and warn if the worker disagrees
      // (split app/worker topology — env drift is otherwise silent).
      const { publishAndCheckStorageConfig } = await import('./lib/storage-config-guard')
      await publishAndCheckStorageConfig('app')

      console.log('[INIT] Server initialization complete')
    } catch (error) {
      console.error('[INIT] Initialization error:', error)
      // Don't throw - allow app to start even if initialization fails
      // The admin can be created manually via database if needed
    }
  }
}

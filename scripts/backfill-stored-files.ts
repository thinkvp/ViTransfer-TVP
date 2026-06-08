/**
 * One-shot script to backfill the StoredFile registry from legacy path columns.
 *
 * Usage:
 *   docker compose run --rm --no-deps app npx tsx scripts/backfill-stored-files.ts
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING.
 * Run this AFTER the migration `20260608000002_add_stored_file_registry` has been applied.
 */

import { backfillStoredFiles } from '../src/lib/stored-file'

async function main() {
  console.log('[backfill-stored-files] Starting backfill from legacy path columns...')
  const start = Date.now()

  const result = await backfillStoredFiles()

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`[backfill-stored-files] Done: ${result.inserted} rows inserted in ${elapsed}s`)

  // Verify
  const { prisma } = await import('../src/lib/db')
  const count = await prisma.storedFile.count()
  console.log(`[backfill-stored-files] StoredFile table now has ${count} total rows`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('[backfill-stored-files] Fatal:', e)
  process.exit(1)
})

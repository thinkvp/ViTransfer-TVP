/**
 * One-shot script to backfill the StoredFile registry from legacy path columns.
 *
 * **DEPRECATED.** The migration `20260608000002_add_stored_file_registry` already
 * ran the backfill SQL, and migration `20260609000000_drop_legacy_path_and_size_columns`
 * has dropped all legacy path/size columns.  This script is now a no-op.
 *
 * Usage (historical):
 *   docker compose run --rm --no-deps app npx tsx scripts/backfill-stored-files.ts
 */

import { backfillStoredFiles } from '../src/lib/stored-file'

async function main() {
  console.log('[backfill-stored-files] Legacy columns have been dropped — nothing to backfill.')

  const result = await backfillStoredFiles()

  console.log(`[backfill-stored-files] Done: ${result.inserted} rows inserted`)

  // Verify
  const { prisma } = await import('../src/lib/db')
  const count = await prisma.storedFile.count()
  console.log(`[backfill-stored-files] StoredFile table has ${count} total rows`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('[backfill-stored-files] Fatal:', e)
  process.exit(1)
})

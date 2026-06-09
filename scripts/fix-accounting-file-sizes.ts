/**
 * Fix accounting attachment fileSize in StoredFile.
 *
 * The migration backfill populated fileSize=0 for all accounting attachments
 * because the legacy AccountingAttachment.fileSize column was 0.
 *
 * This script resolves each file's actual size from disk (or S3) and updates
 * the StoredFile row.
 *
 * Usage:
 *   npx tsx scripts/fix-accounting-file-sizes.ts
 */

import 'dotenv/config'
import { prisma } from '@/lib/db'
import { resolveAccountingFilePath, ACCOUNTING_STORAGE_ROOT } from '@/lib/accounting/file-storage'
import { isS3Mode, s3GetFileSize } from '@/lib/s3-storage'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  console.log('[fix-accounting-file-sizes] Starting...')
  console.log(`  ACCOUNTING_STORAGE_ROOT: ${ACCOUNTING_STORAGE_ROOT}`)
  console.log(`  S3 mode: ${isS3Mode()}`)

  const rows = await prisma.storedFile.findMany({
    where: { entityType: 'ACCOUNTING_ATTACHMENT' },
    select: { id: true, entityId: true, storagePath: true, fileSize: true },
    orderBy: { id: 'asc' },
  })

  console.log(`  Found ${rows.length} ACCOUNTING_ATTACHMENT rows`)

  const zeroSize = rows.filter(r => r.fileSize === null || r.fileSize === BigInt(0))
  console.log(`  ${zeroSize.length} rows have fileSize = 0 or null`)

  if (zeroSize.length === 0) {
    console.log('[fix-accounting-file-sizes] Nothing to fix.')
    await prisma.$disconnect()
    return
  }

  let updated = 0
  let skipped = 0
  let errors = 0

  const s3Active = isS3Mode()

  for (const row of zeroSize) {
    const relPath = row.storagePath?.trim()
    if (!relPath) {
      skipped++
      continue
    }

    let size: number | null = null

    try {
      if (s3Active) {
        // S3 mode: head-object to get size
        size = await s3GetFileSize(relPath)
      } else {
        // Local mode: stat the file using resolveAccountingFilePath
        const absPath = resolveAccountingFilePath(relPath)
        const stat = await fs.promises.stat(absPath)
        if (stat.isFile()) {
          size = stat.size
        }
      }
    } catch {
      // File not found or other error — leave as-is
      errors++
      if (errors <= 5) {
        console.warn(`  Could not resolve size for: ${relPath}`)
      }
      continue
    }

    if (size !== null && size > 0) {
      await prisma.storedFile.update({
        where: { id: row.id },
        data: { fileSize: BigInt(size) },
      })
      updated++
    } else {
      skipped++
    }
  }

  console.log(`[fix-accounting-file-sizes] Done. Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[fix-accounting-file-sizes] Fatal error:', err)
  process.exit(1)
})

/**
 * Accounting File Storage
 *
 * Manages file storage for accounting documents (receipts, transaction attachments)
 * on a dedicated volume separate from the main uploads volume.
 *
 * Local folder structure:
 *   <ACCOUNTING_STORAGE_ROOT>/FYyyyy-yyyy/<AccountName>/filename.ext
 *   <ACCOUNTING_STORAGE_ROOT>/FYyyyy-yyyy/<ParentAccount>/<ChildAccount>/filename.ext
 *
 * S3 key structure (when STORAGE_PROVIDER=s3):
 *   accounting/FYyyyy-yyyy/<AccountName>/filename.ext
 *
 * The fiscal year is determined from the record's date, not the upload date.
 */
import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '@/lib/db'
import { isS3Mode, s3UploadFile, s3DownloadFile, s3DeleteFile, getS3Client, getS3Bucket, s3GetDirectorySizeInfo } from '@/lib/s3-storage'
import { GetObjectCommand, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'stream'

/** S3 key prefix for all accounting files */
export const ACCOUNTING_S3_PREFIX = 'accounting'

export const ACCOUNTING_STORAGE_ROOT =
  process.env.ACCOUNTING_STORAGE_ROOT || path.join(process.cwd(), 'accounting')

/* ------------------------------------------------------------------ */
/*  Fiscal-year helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Given a record date and the FY start month (1-12), return the FY label
 * e.g. "FY2025-2026" for a July-start FY and a date in March 2026.
 */
export function getFiscalYearLabel(recordDate: Date | string, fyStartMonth: number): string {
  const d = typeof recordDate === 'string' ? new Date(recordDate + 'T00:00:00') : recordDate
  const month = d.getMonth() + 1 // 1-12
  const year = d.getFullYear()

  // If fyStartMonth is 1 (Jan), the FY is simply the calendar year
  const fyStartYear = month >= fyStartMonth ? year : year - 1
  const fyEndYear = fyStartYear + 1

  return `FY${fyStartYear}-${fyEndYear}`
}

/**
 * Load the configured FY start month from SalesSettings (cached per-request via Prisma).
 */
export async function getFyStartMonth(): Promise<number> {
  const settings = await prisma.salesSettings.findUnique({
    where: { id: 'default' },
    select: { fiscalYearStartMonth: true },
  })
  return settings?.fiscalYearStartMonth ?? 7
}

import { sanitizeFilePathSegment } from '@/lib/storage-sanitize'

/* ------------------------------------------------------------------ */
/*  Account path helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Sanitise a single folder segment for accounting paths.
 * Wraps the shared sanitizeFilePathSegment with accounting-specific
 * adjustments: 100-char limit and 'Uncategorised' fallback.
 */
function sanitiseFolderName(name: string): string {
  const segment = sanitizeFilePathSegment(name)
  return segment.slice(0, 100) || 'Uncategorised'
}

/**
 * Build the folder segments for an account, including parent if present.
 * Returns e.g. ["Motor Vehicle", "Fuel"] for a child account.
 */
export async function getAccountFolderSegments(accountId: string): Promise<string[]> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      name: true,
      parent: { select: { name: true } },
    },
  })
  if (!account) return ['Uncategorised']

  const segments: string[] = []
  if (account.parent) {
    segments.push(sanitiseFolderName(account.parent.name))
  }
  segments.push(sanitiseFolderName(account.name))
  return segments
}

/* ------------------------------------------------------------------ */
/*  Path validation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Validate that a resolved absolute path stays within the accounting root.
 * Prevents path-traversal attacks.
 */
function validateAccountingPath(fullPath: string): void {
  const realPath = path.resolve(fullPath)
  const realRoot = path.resolve(ACCOUNTING_STORAGE_ROOT)
  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error('Invalid accounting file path — outside storage root')
  }
}

/* ------------------------------------------------------------------ */
/*  Filename deduplication                                             */
/* ------------------------------------------------------------------ */

/**
 * Given a directory (local) or S3 key prefix, return a filename that doesn't
 * clash with existing files.  Adds " (2)", " (3)", … before the extension.
 */
async function deduplicateFilename(dirOrPrefix: string, filename: string, isS3: boolean): Promise<string> {
  const ext = path.posix.extname(filename)
  const base = path.posix.basename(filename, ext)
  let candidate = filename
  let n = 1

  while (true) {
    if (isS3) {
      const key = `${dirOrPrefix}/${candidate}`
      try {
        await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }))
        // exists
      } catch (e: any) {
        const code = Number(e?.$metadata?.httpStatusCode || 0)
        if (code === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return candidate
        throw e
      }
    } else {
      const fullPath = path.join(dirOrPrefix, candidate)
      const exists = await fs.promises.access(fullPath).then(() => true).catch(() => false)
      if (!exists) return candidate
    }
    n++
    candidate = `${base} (${n})${ext}`
  }
}

/**
 * Sanitise a user-provided filename — keep it readable but safe.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200)

  return cleaned || 'file'
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface AccountingStoragePath {
  /** Relative path from ACCOUNTING_STORAGE_ROOT (stored in DB) */
  relativePath: string
  /** Absolute path on disk */
  absolutePath: string
}

export type AccountingAttachmentPathNormalizationSample = {
  id: string
  from: string
  to: string | null
  originalName: string
  error: string | null
}

export type NormalizeAccountingAttachmentStoragePathsResult = {
  ok: true, dryRun: boolean
  legacyRows: number
  normalizedRows: number
  invalidRows: number
  sample: AccountingAttachmentPathNormalizationSample[]
  sampleTruncated: boolean
}

/**
 * Build the storage path for an accounting file.
 *
 * @param recordDate   The date on the expense / transaction (determines FY folder)
 * @param accountId    The chart-of-accounts entry (determines account folder)
 * @param originalName The original filename from the user
 * @returns Paths ready for writing
 */
export async function buildAccountingFilePath(
  recordDate: Date | string,
  accountId: string | null,
  originalName: string,
): Promise<AccountingStoragePath> {
  if (isS3Mode()) {
    const s3KeyPrefix = await getAccountingS3KeyPrefix(recordDate, accountId)
    const safeName = sanitiseFilename(originalName)
    const finalName = await deduplicateFilename(s3KeyPrefix, safeName, true)
    const relativePath = `${s3KeyPrefix}/${finalName}`.replace(/^accounting\//, '')
    return { relativePath, absolutePath: '' }
  }

  const dir = await getAccountingDirectoryPath(recordDate, accountId)
  await fs.promises.mkdir(dir, { recursive: true })

  const safeName = sanitiseFilename(originalName)
  const finalName = await deduplicateFilename(dir, safeName, false)

  const absolutePath = path.join(dir, finalName)
  validateAccountingPath(absolutePath)

  // Relative path stored in DB — always use forward slashes
  const relativePath = path.relative(ACCOUNTING_STORAGE_ROOT, absolutePath).split(path.sep).join('/')

  return { relativePath, absolutePath }
}

export function normalizeAccountingStoragePath(relativePath: string): string {
  if (!relativePath) throw new Error('Empty accounting file path')

  if (relativePath.includes('\0')) throw new Error('Invalid path')

  const stripped = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

  const withoutPrefix = stripped.startsWith(`${ACCOUNTING_S3_PREFIX}/`)
    ? stripped.slice(ACCOUNTING_S3_PREFIX.length + 1)
    : stripped

  const normalised = path.posix.normalize(withoutPrefix)
  if (!normalised || normalised === '.' || normalised.startsWith('..') || normalised.includes('/../') || normalised.startsWith('/')) {
    throw new Error('Invalid accounting file path')
  }

  return normalised
}

/**
 * Resolve a stored relative path back to an absolute path.
 * Accepts both canonical `FY...` DB paths and legacy `accounting/FY...` values.
 */
export function resolveAccountingFilePath(relativePath: string): string {
  const normalised = normalizeAccountingStoragePath(relativePath)
  const fullPath = path.join(ACCOUNTING_STORAGE_ROOT, normalised)
  validateAccountingPath(fullPath)
  return fullPath
}

/**
 * Build the storage path for a BAS period attachment.
 * Files are stored under: <ACCOUNTING_STORAGE_ROOT>/<FY label>/BAS/<filename>
 */
export async function buildBasPeriodFilePath(
  periodStartDate: string,
  originalName: string,
): Promise<AccountingStoragePath> {
  const fyStartMonth = await getFyStartMonth()
  const fyLabel = getFiscalYearLabel(periodStartDate, fyStartMonth)

  if (isS3Mode()) {
    const s3KeyPrefix = `${ACCOUNTING_S3_PREFIX}/${fyLabel}/BAS`
    const safeName = sanitiseFilename(originalName)
    const finalName = await deduplicateFilename(s3KeyPrefix, safeName, true)
    const relativePath = `${fyLabel}/BAS/${finalName}`
    return { relativePath, absolutePath: '' }
  }

  const dir = path.join(ACCOUNTING_STORAGE_ROOT, fyLabel, 'BAS')
  await fs.promises.mkdir(dir, { recursive: true })

  const safeName = sanitiseFilename(originalName)
  const finalName = await deduplicateFilename(dir, safeName, false)

  const absolutePath = path.join(dir, finalName)
  validateAccountingPath(absolutePath)

  const relativePath = path.relative(ACCOUNTING_STORAGE_ROOT, absolutePath).split(path.sep).join('/')
  return { relativePath, absolutePath }
}

/**
 * Write a buffer to the accounting volume (local) or S3 (when in S3 mode).
 */
export async function writeAccountingFile(
  storagePath: AccountingStoragePath,
  buffer: Buffer,
): Promise<void> {
  if (isS3Mode()) {
    const key = toAccountingS3Key(storagePath.relativePath)
    await s3UploadFile(key, buffer, 'application/octet-stream', buffer.length)
    return
  }
  validateAccountingPath(storagePath.absolutePath)
  await fs.promises.writeFile(storagePath.absolutePath, buffer)
}

/**
 * Read a file from the accounting volume (local) or S3 (when in S3 mode).
 */
export async function readAccountingFile(relativePath: string): Promise<Buffer> {
  if (isS3Mode()) {
    const key = toAccountingS3Key(relativePath)
    const { stream } = await s3DownloadFile(key)
    return streamToBuffer(stream)
  }
  const fullPath = resolveAccountingFilePath(relativePath)
  return fs.promises.readFile(fullPath)
}

/**
 * Delete a single file from the accounting volume.
 * Silently succeeds if the file doesn't exist.
 * After deletion (local), removes empty parent directories up to the FY folder.
 */
export async function deleteAccountingFile(relativePath: string): Promise<void> {
  if (!relativePath) return

  if (isS3Mode()) {
    const key = toAccountingS3Key(relativePath)
    await s3DeleteFile(key).catch(() => {})
    return
  }

  const fullPath = resolveAccountingFilePath(relativePath)

  const exists = await fs.promises.access(fullPath).then(() => true).catch(() => false)
  if (!exists) return

  await fs.promises.unlink(fullPath)

  await removeEmptyAccountingDirectories(path.dirname(fullPath))
}

export async function moveAccountingFile(
  relativePath: string,
  recordDate: Date | string,
  accountId: string | null,
  originalName?: string | null,
): Promise<string> {
  if (!relativePath) return relativePath

  if (isS3Mode()) {
    const currentKey = toAccountingS3Key(relativePath)
    const targetS3Prefix = await getAccountingS3KeyPrefix(recordDate, accountId)
    const currentFileName = relativePath.split('/').pop() || relativePath
    const desiredFileName = sanitiseFilename(originalName?.trim() || currentFileName)
    const finalName = await deduplicateFilename(targetS3Prefix, desiredFileName, true)
    const targetKey = `${targetS3Prefix}/${finalName}`

    if (currentKey === targetKey) return relativePath

    const client = getS3Client()
    const bucket = getS3Bucket()
    // CopySource must be URL-encoded (segments separated by unencoded '/')
    const encodedCopySource = currentKey.split('/').map(encodeURIComponent).join('/')
    await client.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      CopySource: `${bucket}/${encodedCopySource}`,
    }))
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: currentKey }))

    return targetKey.replace(`${ACCOUNTING_S3_PREFIX}/`, '')
  }

  const currentAbsolutePath = resolveAccountingFilePath(relativePath)
  const exists = await fs.promises.access(currentAbsolutePath).then(() => true).catch(() => false)
  if (!exists) return relativePath

  const targetDir = await getAccountingDirectoryPath(recordDate, accountId)
  await fs.promises.mkdir(targetDir, { recursive: true })

  const currentFileName = path.basename(currentAbsolutePath)
  const desiredFileName = sanitiseFilename(originalName?.trim() || currentFileName)

  if (path.dirname(currentAbsolutePath) === targetDir && currentFileName === desiredFileName) {
    return relativePath
  }

  const targetFileName = await deduplicateFilename(targetDir, desiredFileName, false)
  const targetAbsolutePath = path.join(targetDir, targetFileName)
  validateAccountingPath(targetAbsolutePath)

  if (currentAbsolutePath === targetAbsolutePath) {
    return relativePath
  }

  try {
    await fs.promises.rename(currentAbsolutePath, targetAbsolutePath)
  } catch (error: any) {
    if (error?.code !== 'EXDEV') {
      throw error
    }

    await fs.promises.copyFile(currentAbsolutePath, targetAbsolutePath)
    await fs.promises.unlink(currentAbsolutePath)
  }

  await removeEmptyAccountingDirectories(path.dirname(currentAbsolutePath))

  return path.relative(ACCOUNTING_STORAGE_ROOT, targetAbsolutePath).split(path.sep).join('/')
}

async function getAccountingDirectoryPath(recordDate: Date | string, accountId: string | null): Promise<string> {
  const fyStartMonth = await getFyStartMonth()
  const fyLabel = getFiscalYearLabel(recordDate, fyStartMonth)

  const accountSegments = accountId
    ? await getAccountFolderSegments(accountId)
    : ['Uncategorised']

  return path.join(ACCOUNTING_STORAGE_ROOT, fyLabel, ...accountSegments)
}

async function removeEmptyAccountingDirectories(startDir: string): Promise<void> {
  let dir = startDir

  // Clean up empty parent dirs up to the accounting root
  const root = path.resolve(ACCOUNTING_STORAGE_ROOT)
  while (dir !== root && dir.startsWith(root + path.sep)) {
    const entries = await fs.promises.readdir(dir).catch(() => null)
    if (!entries || entries.length > 0) break
    await fs.promises.rmdir(dir).catch(() => {})
    dir = path.dirname(dir)
  }
}

/**
 * Check whether a file exists in the accounting volume.
 */
export async function accountingFileExists(relativePath: string): Promise<boolean> {
  if (isS3Mode()) {
    const key = toAccountingS3Key(relativePath)
    try {
      await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }))
      return true
    } catch (e: any) {
      const code = Number(e?.$metadata?.httpStatusCode || 0)
      if (code === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return false
      throw e
    }
  }
  try {
    const fullPath = resolveAccountingFilePath(relativePath)
    await fs.promises.access(fullPath)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  S3 helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Convert a relative accounting storage path (as stored in the DB) to an S3 key.
 * e.g. "FY2025-2026/Expenses/receipt.pdf" → "accounting/FY2025-2026/Expenses/receipt.pdf"
 */
export function toAccountingS3Key(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.startsWith(`${ACCOUNTING_S3_PREFIX}/`)) return normalized
  return `${ACCOUNTING_S3_PREFIX}/${normalized}`
}

/**
 * Build the S3 key prefix for a given record date and account (without trailing slash).
 */
async function getAccountingS3KeyPrefix(recordDate: Date | string, accountId: string | null): Promise<string> {
  const fyStartMonth = await getFyStartMonth()
  const fyLabel = getFiscalYearLabel(recordDate, fyStartMonth)
  const accountSegments = accountId
    ? await getAccountFolderSegments(accountId)
    : ['Uncategorised']
  return `${ACCOUNTING_S3_PREFIX}/${fyLabel}/${accountSegments.join('/')}`
}

/**
 * Get total size in bytes of all accounting files stored in S3.
 */
export async function getAccountingS3TotalBytes(): Promise<number> {
  const { totalBytes } = await s3GetDirectorySizeInfo(`${ACCOUNTING_S3_PREFIX}/`)
  return Number(totalBytes)
}

/**
 * Get total size in bytes of all accounting files stored on local disk.
 */
export async function getAccountingLocalTotalBytes(): Promise<number> {
  return walkDirBytes(ACCOUNTING_STORAGE_ROOT)
}

/**
 * Compute the current accounting files byte total and persist it to Settings.
 * Called by the daily reconcile-project-total-bytes worker job.
 */
export async function reconcileAccountingFilesBytes(): Promise<bigint> {
  const bytes = isS3Mode()
    ? await getAccountingS3TotalBytes()
    : await getAccountingLocalTotalBytes()
  const bigIntBytes = BigInt(Math.round(bytes))
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', accountingFilesBytes: bigIntBytes },
    update: { accountingFilesBytes: bigIntBytes },
  })
  return bigIntBytes
}

/**
 * Adjust the cached accounting files total by a delta (positive = upload, negative = delete).
 * Uses a raw UPDATE so it is safe even if the Settings row doesn't exist yet (0 rows updated).
 * Uses GREATEST(0, …) on decrements to prevent the cached value from going negative.
 */
export async function adjustAccountingFilesBytes(deltaBytes: number): Promise<void> {
  if (deltaBytes === 0) return
  try {
    if (deltaBytes > 0) {
      const bigDelta = BigInt(Math.round(deltaBytes))
      await prisma.$executeRaw`UPDATE "Settings" SET "accountingFilesBytes" = "accountingFilesBytes" + ${bigDelta} WHERE id = 'default'`
    } else {
      const bigDelta = BigInt(Math.round(-deltaBytes))
      await prisma.$executeRaw`UPDATE "Settings" SET "accountingFilesBytes" = GREATEST(0, "accountingFilesBytes" - ${bigDelta}) WHERE id = 'default'`
    }
  } catch {
    // Ignore — the daily reconcile will correct the value next run
  }
}

export async function normalizeAccountingAttachmentStoragePaths(
  dryRun: boolean,
): Promise<NormalizeAccountingAttachmentStoragePathsResult> {
  // Paths now in StoredFile registry
  const rows = await prisma.storedFile.findMany({
    where: {
      entityType: 'ACCOUNTING_ATTACHMENT' as any,
      OR: [
        { storagePath: { startsWith: `${ACCOUNTING_S3_PREFIX}/` } },
        { storagePath: { startsWith: `${ACCOUNTING_S3_PREFIX}\\` } },
      ],
    },
    select: {
      entityId: true,
      storagePath: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const sampleLimit = 50
  const sample: AccountingAttachmentPathNormalizationSample[] = []
  const updates: Array<{ id: string; storagePath: string }> = []
  let invalidRows = 0

  for (const row of rows) {
    try {
      const normalized = normalizeAccountingStoragePath(row.storagePath)
      updates.push({ id: row.entityId, storagePath: normalized })

      if (sample.length < sampleLimit) {
        sample.push({
          id: row.entityId,
          from: row.storagePath,
          to: normalized,
          originalName: '',
          error: null,
        })
      }
    } catch (error: any) {
      invalidRows++
      if (sample.length < sampleLimit) {
        sample.push({
          id: row.entityId,
          from: row.storagePath,
          to: null,
          originalName: '',
          error: error?.message || 'Invalid accounting file path',
        })
      }
    }
  }

  if (!dryRun && updates.length > 0) {
    const batchSize = 100
    for (let index = 0; index < updates.length; index += batchSize) {
      const batch = updates.slice(index, index + batchSize)
      await prisma.$transaction(
        batch.map((row) => prisma.storedFile.update({
          where: { entityType_entityId_fileRole: { entityType: 'ACCOUNTING_ATTACHMENT' as any, entityId: row.id, fileRole: 'ORIGINAL' as any } },
          data: { storagePath: row.storagePath },
        })),
      )
    }
  }

  return {
    ok: true,
    dryRun,
    legacyRows: rows.length,
    normalizedRows: updates.length,
    invalidRows,
    sample,
    sampleTruncated: rows.length > sample.length,
  }
}

async function walkDirBytes(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await walkDirBytes(entryPath)
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(entryPath).catch(() => null)
      if (stat) total += stat.size
    }
  }
  return total
}

/** List all accounting file S3 keys (for orphan scan). */
export async function listAccountingS3Keys(): Promise<Array<{ key: string; bytes: number }>> {
  const client = getS3Client()
  const bucket = getS3Bucket()
  const prefix = `${ACCOUNTING_S3_PREFIX}/`
  const results: Array<{ key: string; bytes: number }> = []
  let continuationToken: string | undefined

  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }))
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) results.push({ key: obj.Key, bytes: obj.Size ?? 0 })
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (continuationToken)

  return results
}

/** Walk the local accounting directory and return all file paths relative to ACCOUNTING_STORAGE_ROOT. */
export async function listAccountingLocalFiles(): Promise<Array<{ relPath: string; bytes: number }>> {
  const results: Array<{ relPath: string; bytes: number }> = []
  await walkAccountingDir(ACCOUNTING_STORAGE_ROOT, ACCOUNTING_STORAGE_ROOT, results)
  return results
}

async function walkAccountingDir(
  dir: string,
  root: string,
  out: Array<{ relPath: string; bytes: number }>,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkAccountingDir(entryPath, root, out)
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(entryPath).catch(() => null)
      if (stat) {
        out.push({
          relPath: path.relative(root, entryPath).replace(/\\/g, '/'),
          bytes: stat.size,
        })
      }
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Migrate all AccountingAttachment files for a given account into the folder
 * path derived from the account's current name.  Call this after renaming an
 * account so that existing receipts move from the old folder name to the new one.
 *
 * Also handles the case where the account is a parent: pass each child's ID
 * separately to migrate their files into the updated parent folder segment.
 */
export async function migrateAccountFolderFiles(accountId: string): Promise<void> {
  // Expense attachments — storagePath lives under the expense's account folder
  const expenseAttachments = await prisma.accountingAttachment.findMany({
    where: { expense: { accountId } },
    select: {
      id: true, originalName: true,
      expense: { select: { date: true } },
    },
  })

  // Bank-transaction attachments — storagePath lives under the transaction's account folder.
  // EXPENSE-matched transactions intentionally have bankTransaction.accountId = null (the
  // Expense record owns the account assignment).  We therefore also include transactions
  // whose *linked expense* belongs to this account so those attachments are migrated too.
  const txnAttachments = await prisma.accountingAttachment.findMany({
    where: {
      bankTransaction: {
        OR: [
          { accountId },
          { expense: { accountId } },
        ],
      },
    },
    select: {
      id: true, originalName: true,
      bankTransaction: { select: { date: true } },
    },
  })

  // Get paths from StoredFile
  const attachmentIds = [
    ...expenseAttachments.map(a => a.id),
    ...txnAttachments.map(a => a.id),
  ]
  const storedMap = new Map<string, string>()
  if (attachmentIds.length > 0) {
    const stored = await prisma.storedFile.findMany({
      where: { entityType: 'ACCOUNTING_ATTACHMENT' as any, entityId: { in: attachmentIds } },
      select: { entityId: true, storagePath: true },
    })
    for (const s of stored) storedMap.set(s.entityId, s.storagePath)
  }

  const all: Array<{ id: string; storagePath: string; originalName: string; date: string }> = [
    ...expenseAttachments
      .filter((a) => a.expense)
      .map((a) => ({ id: a.id, storagePath: storedMap.get(a.id) || '', originalName: a.originalName, date: a.expense!.date })),
    ...txnAttachments
      .filter((a) => a.bankTransaction)
      .map((a) => ({ id: a.id, storagePath: storedMap.get(a.id) || '', originalName: a.originalName, date: a.bankTransaction!.date })),
  ]

  for (const attachment of all) {
    const newPath = await moveAccountingFile(
      attachment.storagePath,
      attachment.date,
      accountId,
      attachment.originalName,
    )
    if (newPath !== attachment.storagePath) {
      await prisma.storedFile.update({
        where: { entityType_entityId_fileRole: { entityType: 'ACCOUNTING_ATTACHMENT' as any, entityId: attachment.id, fileRole: 'ORIGINAL' as any } },
        data: { storagePath: newPath },
      })
    }
  }
}

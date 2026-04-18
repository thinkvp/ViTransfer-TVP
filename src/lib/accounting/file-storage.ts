/**
 * Accounting File Storage
 *
 * Manages file storage for accounting documents (receipts, transaction attachments)
 * on a dedicated volume separate from the main uploads volume.
 *
 * Folder structure:
 *   <ACCOUNTING_STORAGE_ROOT>/FYyyyy-yyyy/<AccountName>/filename.ext
 *   <ACCOUNTING_STORAGE_ROOT>/FYyyyy-yyyy/<ParentAccount>/<ChildAccount>/filename.ext
 *
 * The fiscal year is determined from the record's date, not the upload date.
 */
import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '@/lib/db'

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

/* ------------------------------------------------------------------ */
/*  Account path helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Sanitise a single folder segment — keep it filesystem-safe while preserving
 * readability (spaces, ampersands, etc. are fine).
 */
function sanitiseFolderName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // illegal chars on Windows/POSIX
    .replace(/\.+$/, '')                      // trailing dots (Windows)
    .replace(/\s+/g, ' ')                     // collapse whitespace
    .slice(0, 100)                            // reasonable limit
    || 'Uncategorised'
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
 * Given a directory and a desired filename, return a filename that doesn't
 * clash with existing files.  Adds " (2)", " (3)", … before the extension.
 */
async function deduplicateFilename(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let candidate = filename
  let n = 1

  while (true) {
    const fullPath = path.join(dir, candidate)
    const exists = await fs.promises.access(fullPath).then(() => true).catch(() => false)
    if (!exists) return candidate
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
  const dir = await getAccountingDirectoryPath(recordDate, accountId)
  await fs.promises.mkdir(dir, { recursive: true })

  const safeName = sanitiseFilename(originalName)
  const finalName = await deduplicateFilename(dir, safeName)

  const absolutePath = path.join(dir, finalName)
  validateAccountingPath(absolutePath)

  // Relative path stored in DB — always use forward slashes
  const relativePath = path.relative(ACCOUNTING_STORAGE_ROOT, absolutePath).split(path.sep).join('/')

  return { relativePath, absolutePath }
}

/**
 * Resolve a stored relative path back to an absolute path.
 * Returns null if the file doesn't exist.
 */
export function resolveAccountingFilePath(relativePath: string): string {
  if (!relativePath) throw new Error('Empty accounting file path')

  // Reject traversal
  if (relativePath.includes('\0')) throw new Error('Invalid path')
  const normalised = path.posix.normalize(relativePath)
  if (normalised.startsWith('..') || normalised.includes('/../') || normalised.startsWith('/')) {
    throw new Error('Invalid accounting file path')
  }

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
  const dir = path.join(ACCOUNTING_STORAGE_ROOT, fyLabel, 'BAS')
  await fs.promises.mkdir(dir, { recursive: true })

  const safeName = sanitiseFilename(originalName)
  const finalName = await deduplicateFilename(dir, safeName)

  const absolutePath = path.join(dir, finalName)
  validateAccountingPath(absolutePath)

  const relativePath = path.relative(ACCOUNTING_STORAGE_ROOT, absolutePath).split(path.sep).join('/')
  return { relativePath, absolutePath }
}

/**
 * Write a buffer to the accounting volume.
 */
export async function writeAccountingFile(
  storagePath: AccountingStoragePath,
  buffer: Buffer,
): Promise<void> {
  validateAccountingPath(storagePath.absolutePath)
  await fs.promises.writeFile(storagePath.absolutePath, buffer)
}

/**
 * Read a file from the accounting volume.
 */
export async function readAccountingFile(relativePath: string): Promise<Buffer> {
  const fullPath = resolveAccountingFilePath(relativePath)
  return fs.promises.readFile(fullPath)
}

/**
 * Delete a single file from the accounting volume.
 * Silently succeeds if the file doesn't exist.
 * After deletion, removes empty parent directories up to the FY folder.
 */
export async function deleteAccountingFile(relativePath: string): Promise<void> {
  if (!relativePath) return

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

  const targetFileName = await deduplicateFilename(targetDir, desiredFileName)
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
  try {
    const fullPath = resolveAccountingFilePath(relativePath)
    await fs.promises.access(fullPath)
    return true
  } catch {
    return false
  }
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
      id: true,
      storagePath: true,
      originalName: true,
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
      id: true,
      storagePath: true,
      originalName: true,
      bankTransaction: { select: { date: true } },
    },
  })

  const all: Array<{ id: string; storagePath: string; originalName: string; date: string }> = [
    ...expenseAttachments
      .filter((a) => a.expense)
      .map((a) => ({ id: a.id, storagePath: a.storagePath, originalName: a.originalName, date: a.expense!.date })),
    ...txnAttachments
      .filter((a) => a.bankTransaction)
      .map((a) => ({ id: a.id, storagePath: a.storagePath, originalName: a.originalName, date: a.bankTransaction!.date })),
  ]

  for (const attachment of all) {
    const newPath = await moveAccountingFile(
      attachment.storagePath,
      attachment.date,
      accountId,
      attachment.originalName,
    )
    if (newPath !== attachment.storagePath) {
      await prisma.accountingAttachment.update({
        where: { id: attachment.id },
        data: { storagePath: newPath },
      })
    }
  }
}

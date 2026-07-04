/**
 * General smoke test — run after making changes: `npm run test:smoke`
 *
 * Covers the basics without needing a database:
 *  1. Money & GST helpers (pure math used by sales + accounting/BAS)
 *  2. Comment sanitization (zero-PII policy + DTO whitelist)
 *  3. HTML/XSS sanitization
 *  4. Storage path-traversal + header-injection defenses
 *  5. CPU allocation sanity (worker concurrency budget)
 *  6. Static source checks for known regression traps (VOID invoice leaks,
 *     share-upload gates)
 *  7. Optional live HTTP checks against a running server (dev :3000 or
 *     Docker :4321) — set SMOKE_BASE_URL to override; skipped if unreachable.
 *
 * RBAC gates are checked separately by `npm run check:rbac`, which the
 * `test:smoke` npm script runs first.
 */
import fs from 'fs/promises'
import path from 'path'
import assert from 'assert'

import {
  dollarsToCents,
  centsToDollars,
  sumLineItemsSubtotal,
  sumLineItemsTax,
  sumLineItemsTotal,
  calcTaxCents,
} from '@/lib/sales/money'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { sanitizeCommentHtml, sanitizeText, containsSuspiciousPatterns } from '@/lib/security/html-sanitization'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { getCpuAllocation } from '@/lib/cpu-config'
import type { SalesLineItem } from '@/lib/sales/types'

const root = process.cwd()

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((error: unknown) => {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${name}: ${message}`)
      console.error(`  ✗ ${name}\n      ${message}`)
    })
}

function section(title: string) {
  console.log(`\n${title}`)
}

async function readSource(relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8')
}

async function main() {
  // ── 1. Money & GST helpers ────────────────────────────────────────────────
  section('Money & GST helpers')

  await check('dollarsToCents parses formatted input', () => {
    assert.equal(dollarsToCents('$1,234.56'), 123456)
    assert.equal(dollarsToCents('-10.50'), -1050)
    assert.equal(dollarsToCents('garbage'), 0)
  })

  await check('centsToDollars formats with sign and separators', () => {
    assert.equal(centsToDollars(123456), '1,234.56')
    assert.equal(centsToDollars(-50), '-0.50')
    assert.equal(centsToDollars(0), '0.00')
  })

  await check('line item subtotal/tax/total round consistently', () => {
    const items: SalesLineItem[] = [
      { description: 'Edit', quantity: 1.5, unitPriceCents: 10000 } as SalesLineItem,
      { description: 'Colour', quantity: 1, unitPriceCents: 3333 } as SalesLineItem,
    ]
    const subtotal = sumLineItemsSubtotal(items)
    const tax = sumLineItemsTax(items, 10)
    assert.equal(subtotal, 18333)
    assert.equal(tax, calcTaxCents(15000, 10) + calcTaxCents(3333, 10)) // per-line rounding
    assert.equal(sumLineItemsTotal(items, 10), subtotal + tax)
  })

  await check('per-line tax rate overrides the default rate', () => {
    const items: SalesLineItem[] = [
      { description: 'GST-free', quantity: 1, unitPriceCents: 10000, taxRatePercent: 0 } as SalesLineItem,
    ]
    assert.equal(sumLineItemsTax(items, 10), 0)
  })

  await check('amountExcludingGst strips GST with sign-aware rounding', () => {
    // $110 inc GST at 10% → $100 ex GST
    assert.equal(amountExcludingGst(11000, 'GST', 10), 10000)
    // Negative amounts (credits/refunds) keep their sign
    assert.equal(amountExcludingGst(-11000, 'GST', 10), -10000)
    // Non-GST codes pass through untouched
    assert.equal(amountExcludingGst(11000, 'GST_FREE', 10), 11000)
    assert.equal(amountExcludingGst(11000, null, 10), 11000)
    assert.equal(amountExcludingGst(0, 'GST', 10), 0)
  })

  // ── 2. Comment sanitization (zero-PII policy) ─────────────────────────────
  section('Comment sanitization')

  const rawComment = {
    id: 'c1',
    projectId: 'p1',
    videoId: 'v1',
    videoVersion: 2,
    timecode: '00:00:36:00',
    content: 'Fix the title',
    isInternal: false,
    authorName: 'Real Name',
    authorEmail: 'real@example.com',
    userId: null,
    recipientId: 'r1',
    recipient: { displayColor: '#ff0000' },
    resolvedAt: '2026-07-01T00:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    parentId: null,
    files: [{ id: 'f1', fileName: 'ref.png', fileSize: BigInt(1024), filePath: 'secret/path.png' }],
    replies: [] as unknown[],
  }

  await check('guests never see real names or emails', () => {
    const dto = sanitizeComment(rawComment, false, false)
    assert.equal(dto.authorName, 'Client')
    assert.equal(dto.authorEmail, undefined)
    assert.equal(dto.userId, undefined)
  })

  await check('admins get full author data', () => {
    const dto = sanitizeComment(rawComment, true, true)
    assert.equal(dto.authorName, 'Real Name')
    assert.equal(dto.authorEmail, 'real@example.com')
  })

  await check('whitelist DTO keeps UI-critical fields (timecode, resolvedAt, displayColor)', () => {
    // New Comment DB fields silently vanish from the client unless added to
    // this whitelist — these are the ones current UI depends on.
    const dto = sanitizeComment(rawComment, false, true, 'Acme')
    assert.equal(dto.timecode, '00:00:36:00')
    assert.equal(dto.resolvedAt, '2026-07-01T00:00:00Z')
    assert.equal(dto.displayColor, '#ff0000')
    assert.equal(dto.authorType, 'RECIPIENT')
    assert.equal(dto.videoVersion, 2)
  })

  await check('attachment metadata excludes storage paths, converts BigInt size', () => {
    const dto = sanitizeComment(rawComment, false, true)
    assert.equal(dto.files.length, 1)
    assert.equal(dto.files[0].fileSize, 1024)
    assert.equal(dto.files[0].filePath, undefined)
  })

  await check('legacy numeric timestamps normalize to a timecode', () => {
    const dto = sanitizeComment({ ...rawComment, timecode: null, timestamp: 36 }, false, false)
    assert.match(dto.timecode, /^\d{2}:\d{2}:\d{2}:\d{2}$/)
  })

  // ── 3. HTML / XSS sanitization ────────────────────────────────────────────
  section('HTML & XSS sanitization')

  await check('sanitizeCommentHtml strips scripts and event handlers', () => {
    const clean = sanitizeCommentHtml('<b>ok</b><script>alert(1)</script><img src=x onerror=alert(1)>')
    assert(!clean.includes('<script'), 'script tag survived')
    assert(!clean.toLowerCase().includes('onerror'), 'event handler survived')
  })

  await check('sanitizeText neutralizes markup', () => {
    const clean = sanitizeText('<script>alert(1)</script>')
    assert(!clean.includes('<script'), 'script tag survived sanitizeText')
  })

  await check('containsSuspiciousPatterns flags obvious payloads', () => {
    assert.equal(containsSuspiciousPatterns('javascript:alert(1)'), true)
    assert.equal(containsSuspiciousPatterns('Please tweak the colour grade at 00:12'), false)
  })

  // ── 4. Storage path validation & header injection ─────────────────────────
  section('Storage path & header safety')

  await check('getFilePath rejects traversal, absolute, encoded and null-byte paths', () => {
    const attacks = [
      '../etc/passwd',
      'projects/../../etc/passwd',
      '/etc/passwd',
      'C:/Windows/system32',
      '%2e%2e%2fetc%2fpasswd',
      'projects/a\0.mp4',
    ]
    for (const attack of attacks) {
      assert.throws(() => getFilePath(attack), `accepted malicious path: ${attack}`)
    }
  })

  await check('getFilePath accepts normal relative POSIX paths', () => {
    const resolved = getFilePath('projects/p1/videos/v1/original.mp4')
    assert(resolved.includes('projects'), 'valid path rejected')
  })

  await check('sanitizeFilenameForHeader blocks CRLF header injection', () => {
    const clean = sanitizeFilenameForHeader('file"\r\nSet-Cookie: pwned=1.mp4')
    assert(!clean.includes('\r') && !clean.includes('\n') && !clean.includes('"'))
    assert.equal(sanitizeFilenameForHeader(''), 'download.mp4')
  })

  // ── 5. CPU allocation sanity ──────────────────────────────────────────────
  section('CPU allocation')

  await check('getCpuAllocation returns a coherent budget', () => {
    const alloc = getCpuAllocation({})
    assert(alloc.videoWorkerConcurrency >= 1, 'concurrency must be at least 1')
    assert(alloc.ffmpegThreadsPerJob >= 1, 'threads per job must be at least 1')
    assert(alloc.effectiveThreads >= 1, 'effective threads must be at least 1')
    assert(
      alloc.maxThreadsUsedEstimate <= alloc.effectiveThreads * 2,
      `estimated usage ${alloc.maxThreadsUsedEstimate} wildly exceeds ${alloc.effectiveThreads} threads`
    )
  })

  // ── 6. Static source checks (known regression traps) ─────────────────────
  section('Static source checks')

  await check('VOID invoices excluded from sales dashboard/calendar/chart/reminders', async () => {
    // These endpoints filter by blacklist (status !== PAID) or no status filter,
    // so VOID must be explicitly excluded in each or cancelled invoices leak
    // into "Awaiting payment" and reminder emails.
    const spots = [
      'src/app/api/admin/sales/calendar/route.ts',
      'src/app/api/admin/sales/rollup/route.ts',
      'src/app/api/admin/sales/projects-chart/route.ts',
    ]
    for (const spot of spots) {
      const src = await readSource(spot)
      assert(src.includes('VOID'), `${spot} no longer references VOID exclusion`)
    }
  })

  await check('BAS accrual invoice query stays a status whitelist (no VOID)', async () => {
    const src = await readSource('src/lib/accounting/gst.ts')
    assert(
      /status:\s*\{\s*in:\s*\[[^\]]*'OPEN'[^\]]*\]/.test(src),
      'accrual BAS invoice query should whitelist statuses'
    )
    const whitelist = src.match(/status:\s*\{\s*in:\s*\[([^\]]*)\]/)?.[1] ?? ''
    assert(!whitelist.includes('VOID'), 'VOID crept into the BAS invoice status whitelist')
  })

  await check('share upload routes keep permission gates', async () => {
    const uploadsRoute = await readSource('src/app/api/share/[token]/uploads/route.ts')
    assert(uploadsRoute.includes('resolveShareUploadAccess'), 'uploads route lost its access resolver')
    assert(uploadsRoute.includes('canUpload'), 'uploads route lost its canUpload gate')
  })

  await check('admin seeding still registered at server startup', async () => {
    const src = await readSource('src/instrumentation.ts')
    assert(src.includes('register'), 'instrumentation register() missing')
  })

  // ── 7. Live HTTP checks (optional — needs a running server) ──────────────
  section('Live HTTP checks')

  const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:3000'
  let serverUp = false
  try {
    const res = await fetch(`${baseUrl}/api/branding/info`, { signal: AbortSignal.timeout(3000) })
    serverUp = res.ok
  } catch {
    serverUp = false
  }

  if (!serverUp) {
    console.log(`  – skipped (no server responding at ${baseUrl}; set SMOKE_BASE_URL to target one)`)
  } else {
    await check(`branding info is public and returns JSON (${baseUrl})`, async () => {
      const res = await fetch(`${baseUrl}/api/branding/info`, { signal: AbortSignal.timeout(5000) })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert(typeof body === 'object' && body !== null)
    })

    await check('admin API rejects unauthenticated requests', async () => {
      const res = await fetch(`${baseUrl}/api/admin/sales/rollup`, { signal: AbortSignal.timeout(5000) })
      assert([401, 403].includes(res.status), `expected 401/403, got ${res.status}`)
    })

    await check('security events API rejects unauthenticated requests', async () => {
      const res = await fetch(`${baseUrl}/api/security/events`, { signal: AbortSignal.timeout(5000) })
      assert([401, 403].includes(res.status), `expected 401/403, got ${res.status}`)
    })

    await check('invalid share token is rejected', async () => {
      const res = await fetch(`${baseUrl}/api/share/not-a-real-token-000`, { signal: AbortSignal.timeout(5000) })
      assert([400, 401, 403, 404, 410].includes(res.status), `expected 4xx, got ${res.status}`)
    })
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed${serverUp ? '' : ' (live HTTP checks skipped)'}`)
  if (failed > 0) {
    console.error('\nFailures:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

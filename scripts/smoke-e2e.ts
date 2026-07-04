/**
 * End-to-end share-page smoke test — run with a live server: `npm run test:e2e`
 *
 * Exercises the real client workflow over HTTP against a running instance
 * (dev server :3000 or Docker :4321):
 *
 *   1. Seeds a throwaway project + recipient + video directly via Prisma
 *      (authMode NONE, client deletes + uploads enabled, approval allowed)
 *   2. Accesses the share page as a client and obtains a share token
 *   3. Lists, creates and replies to comments as the client
 *   4. Uploads a comment attachment (tiny PNG via multipart form)
 *   5. Verifies the zero-PII policy on the client view
 *   6. Verifies unauthenticated requests are rejected
 *   7. Deletes a comment as the client
 *   8. Approves the video and verifies project/video state in the DB
 *   9. Optionally logs in as admin (SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD)
 *      and verifies the admin view + admin comment deletion
 *  10. Cleans up everything it created (comments via API so storage files are
 *      removed, then the project via Prisma cascade)
 *
 * Requirements:
 *   - Server running and reachable (SMOKE_BASE_URL, default tries :3000 then :4321)
 *   - DATABASE_URL pointing at the SAME database the server uses
 *
 * NOTE: run this against a dev/test instance. Comment + approval actions can
 * enqueue admin notifications (bell/push, and emails if SMTP is configured).
 * The seeded recipient has notifications disabled and a .invalid email so no
 * client-facing mail can go anywhere.
 */
import assert from 'assert'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

let passed = 0
let failed = 0
const failures: string[] = []
let aborted = false

async function check(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  if (aborted) {
    console.log(`  – ${name} (skipped after earlier failure)`)
    return false
  }
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
    return true
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.error(`  ✗ ${name}\n      ${message}`)
    return false
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

let BASE = ''

async function api(
  method: string,
  path: string,
  options: { token?: string; json?: unknown; form?: FormData } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {}
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.form ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined),
    signal: AbortSignal.timeout(15000),
  })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    // Non-JSON response body (e.g. empty)
  }
  return { status: res.status, body }
}

async function probeServer(): Promise<string> {
  const candidates = process.env.SMOKE_BASE_URL
    ? [process.env.SMOKE_BASE_URL]
    : ['http://localhost:3000', 'http://localhost:4321']
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/api/branding/info`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return candidate
    } catch {
      // try next
    }
  }
  throw new Error(
    `No server responding at ${candidates.join(' or ')} — start the dev server (npm run dev) or set SMOKE_BASE_URL.`
  )
}

// 1×1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  BASE = await probeServer()
  console.log(`Target server: ${BASE}`)
  console.log('Note: comment/approval steps can enqueue admin notifications on this instance.')

  // ── Seed a throwaway project ───────────────────────────────────────────────
  const runId = `smoke-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  // Project.createdBy is a required relation — attach to any existing user
  const anyUser = await prisma.user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  if (!anyUser) {
    throw new Error('No users exist in this database — start the app once so the default admin is seeded.')
  }

  const project = await prisma.project.create({
    data: {
      title: `Smoke E2E ${runId}`,
      slug: runId,
      createdById: anyUser.id,
      authMode: 'NONE',
      status: 'IN_REVIEW',
      allowClientDeleteComments: true,
      allowClientUploadFiles: true,
      enableVideos: true,
    },
  })
  const recipient = await prisma.projectRecipient.create({
    data: {
      projectId: project.id,
      name: 'Smoke Test Recipient',
      email: `${runId}@smoke.invalid`,
      isPrimary: true,
      receiveNotifications: false,
      displayColor: '#4F46E5',
    },
  })
  const video = await prisma.video.create({
    data: {
      projectId: project.id,
      name: 'Smoke Test Video',
      version: 1,
      versionLabel: 'v1',
      duration: 10,
      width: 1920,
      height: 1080,
      status: 'READY',
      allowApproval: true,
    },
  })
  console.log(`Seeded project ${project.id} (share slug: ${runId})`)

  let shareToken = ''
  let commentId = ''
  let replyId = ''
  const createdCommentIds: string[] = []

  try {
    // ── Client share access ──────────────────────────────────────────────────
    section('Share page access (client)')

    const gotToken = await check('share page loads and issues a share token', async () => {
      const { status, body } = await api('GET', `/api/share/${runId}`)
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
      assert(typeof body?.shareToken === 'string' && body.shareToken.length > 20, 'no shareToken in response')
      shareToken = body.shareToken
    })
    if (!gotToken) {
      aborted = true
      throw new Error(
        'Could not obtain a share token — if the server returned 403/404, the server is likely using a different database than DATABASE_URL.'
      )
    }

    await check('comments list starts empty', async () => {
      const { status, body } = await api('GET', `/api/share/${runId}/comments`, { token: shareToken })
      assert.equal(status, 200)
      assert(Array.isArray(body) && body.length === 0, `expected empty array, got ${JSON.stringify(body)}`)
    })

    // ── Commenting ───────────────────────────────────────────────────────────
    section('Comments (client)')

    await check('client can leave a timestamped comment', async () => {
      const { status, body } = await api('POST', '/api/comments', {
        token: shareToken,
        json: {
          projectId: project.id,
          videoId: video.id,
          videoVersion: 1,
          timecode: '00:00:05:00',
          content: 'Smoke test: please tighten the intro.',
          authorName: 'Smoke Test Recipient',
          recipientId: recipient.id,
        },
      })
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
      assert(Array.isArray(body), 'expected sanitized comment list in response')
      const created = body.find((c: any) => c.content?.includes('tighten the intro'))
      assert(created, 'created comment not found in response')
      commentId = created.id
      createdCommentIds.push(commentId)
      assert.equal(created.timecode, '00:00:05:00')
      assert.equal(created.authorType, 'RECIPIENT')
    })

    await check('client view never exposes emails or user ids (zero-PII)', async () => {
      const { body } = await api('GET', `/api/share/${runId}/comments`, { token: shareToken })
      const comment = body.find((c: any) => c.id === commentId)
      assert(comment, 'comment missing from share view')
      assert.equal(comment.authorEmail, undefined, 'authorEmail leaked to client view')
      assert.equal(comment.userId, undefined, 'userId leaked to client view')
    })

    await check('client can reply to a comment', async () => {
      const { status, body } = await api('POST', '/api/comments', {
        token: shareToken,
        json: {
          projectId: project.id,
          videoId: video.id,
          videoVersion: 1,
          timecode: '00:00:05:00',
          content: 'Smoke test: reply thread works.',
          authorName: 'Smoke Test Recipient',
          recipientId: recipient.id,
          parentId: commentId,
        },
      })
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
      const parent = body.find((c: any) => c.id === commentId)
      const reply = parent?.replies?.find((r: any) => r.content?.includes('reply thread'))
      assert(reply, 'reply not nested under parent comment')
      replyId = reply.id
      createdCommentIds.push(replyId)
    })

    // ── Attachments ──────────────────────────────────────────────────────────
    section('Comment attachments (client)')

    await check('client can upload an attachment to their comment', async () => {
      const form = new FormData()
      form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'smoke-test.png')
      const { status, body } = await api('POST', `/api/comments/${commentId}/files`, {
        token: shareToken,
        form,
      })
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
      assert.equal(body?.success, true)
      assert.equal(body?.file?.fileName, 'smoke-test.png')
    })

    await check('attachment shows in the share view with safe metadata only', async () => {
      const { body } = await api('GET', `/api/share/${runId}/comments`, { token: shareToken })
      const comment = body.find((c: any) => c.id === commentId)
      const file = comment?.files?.[0]
      assert(file, 'attachment missing from share view')
      assert.equal(file.fileName, 'smoke-test.png')
      assert(file.fileSize > 0, 'attachment fileSize not resolved from StoredFile')
      assert.equal(file.storagePath, undefined, 'storagePath leaked to client view')
    })

    // ── Unauthenticated rejection ────────────────────────────────────────────
    section('Unauthenticated requests')

    await check('commenting without a token is rejected', async () => {
      // Same payload as the successful client comment, just without the bearer
      // token — so the rejection comes from the auth gate, not input validation.
      const { status, body } = await api('POST', '/api/comments', {
        json: {
          projectId: project.id,
          videoId: video.id,
          videoVersion: 1,
          timecode: '00:00:01:00',
          content: 'should be rejected',
          authorName: 'Smoke Test Recipient',
          recipientId: recipient.id,
        },
      })
      // The comments route deliberately masks auth failures as a generic 400
      // ("Unable to process request") to avoid leaking why access was denied.
      const rejected =
        [401, 403].includes(status) || (status === 400 && body?.error === 'Unable to process request')
      assert(rejected, `expected auth rejection, got ${status}: ${JSON.stringify(body)}`)
      // Belt and braces: confirm nothing was actually created.
      const count = await prisma.comment.count({
        where: { projectId: project.id, content: { contains: 'should be rejected' } },
      })
      assert.equal(count, 0, 'unauthenticated comment was persisted')
    })

    await check('deleting a comment without a token is rejected', async () => {
      const { status } = await api('DELETE', `/api/comments/${commentId}`)
      assert([401, 403].includes(status), `expected 401/403, got ${status}`)
    })

    // ── Deleting comments ────────────────────────────────────────────────────
    section('Comment deletion (client)')

    await check('client can delete their own comment (project opt-in)', async () => {
      const { status, body } = await api('DELETE', `/api/comments/${replyId}`, { token: shareToken })
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
      const { body: after } = await api('GET', `/api/share/${runId}/comments`, { token: shareToken })
      const parent = after.find((c: any) => c.id === commentId)
      assert(!(parent?.replies ?? []).some((r: any) => r.id === replyId), 'deleted reply still visible')
    })

    // ── Approval ─────────────────────────────────────────────────────────────
    section('Video approval (client)')

    await check('client can approve the video via the share session', async () => {
      const { status, body } = await api('POST', `/api/projects/${project.id}/approve`, {
        token: shareToken,
        json: { selectedVideoId: video.id, authorName: 'Smoke Test Recipient' },
      })
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    })

    await check('approval is persisted (video approved, project status advanced)', async () => {
      const dbVideo = await prisma.video.findUnique({ where: { id: video.id } })
      assert.equal(dbVideo?.approved, true, 'video not marked approved in DB')
      assert(dbVideo?.approvedAt, 'approvedAt not set')
      const dbProject = await prisma.project.findUnique({ where: { id: project.id } })
      assert(
        ['REVIEWED', 'APPROVED'].includes(dbProject?.status ?? ''),
        `project status should be REVIEWED or APPROVED, got ${dbProject?.status}`
      )
    })

    // ── Admin path (optional) ────────────────────────────────────────────────
    section('Admin access')

    const adminEmail = process.env.SMOKE_ADMIN_EMAIL
    const adminPassword = process.env.SMOKE_ADMIN_PASSWORD

    if (!adminEmail || !adminPassword) {
      console.log('  – skipped (set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD to test the admin path)')
    } else {
      let adminToken = ''

      await check('admin login returns access token', async () => {
        const { status, body } = await api('POST', '/api/auth/login', {
          json: { email: adminEmail, password: adminPassword },
        })
        assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
        adminToken = body?.tokens?.accessToken
        assert(adminToken, 'no accessToken in login response')
      })

      await check('admin view of share comments includes author details', async () => {
        const { status, body } = await api('GET', `/api/share/${runId}/comments`, { token: adminToken })
        assert.equal(status, 200)
        const comment = body.find((c: any) => c.id === commentId)
        assert(comment, 'comment missing from admin view')
        assert.equal(comment.authorName, 'Smoke Test Recipient', 'admin should see the real author name')
      })

      await check('admin can delete a client comment (removes attachments)', async () => {
        const { status, body } = await api('DELETE', `/api/comments/${commentId}`, { token: adminToken })
        assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
        const remaining = await prisma.comment.count({ where: { projectId: project.id } })
        assert.equal(remaining, 0, 'comments still present after admin delete')
        commentId = '' // handled — skip client-side cleanup
      })
    }
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    section('Cleanup')

    // Delete remaining comments via the API so attachment files are removed
    // from storage too (the server owns STORAGE_ROOT, this script may not).
    if (commentId && shareToken) {
      try {
        await api('DELETE', `/api/comments/${commentId}`, { token: shareToken })
      } catch {
        // best effort — project delete below removes the DB rows regardless
      }
    }

    try {
      await prisma.project.delete({ where: { id: project.id } })
      console.log(`  ✓ removed seeded project ${project.id}`)
    } catch (error) {
      console.error(`  ✗ failed to remove seeded project ${project.id} — delete it manually (slug: ${runId})`)
      console.error(`      ${error instanceof Error ? error.message : error}`)
    }

    await prisma.$disconnect()
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('\nFailures:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})

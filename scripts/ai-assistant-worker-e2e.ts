/**
 * AI assistant worker end-to-end test — runs the REAL worker processor against
 * the dev database with a stub Ollama server (no GPU, no auth, no dev server).
 *
 *   npx tsx scripts/ai-assistant-worker-e2e.ts
 *
 * Flow: temporarily points Settings at a local stub Ollama → seeds an
 * AiAssistantRequest (with a sample .eml) → invokes processAiAssistantRequest
 * directly → asserts COMPLETED + guards applied → restores settings and cleans
 * up everything it created. Run against a dev/test database only.
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { prisma } from '../src/lib/db'
import { processAiAssistantRequest } from '../src/worker/ai-assistant-processor'
import type { AssistantResult } from '../src/lib/ai/proposal-schemas'

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SAMPLE_EML = [
  'From: Jane Doe <jane@acme.example>',
  'To: studio@example.com',
  'Subject: Brand video for Acme',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi, we would like a 90 second brand video. Shoot on 28 July, deliver mid August.',
  'Budget is around $2,400 + GST.',
].join('\r\n')

async function main() {
  // Real client id so the guard keeps it; a bogus one to prove the guard nulls it
  let tempClient: { id: string; name: string } | null = null
  let realClient = await prisma.client.findFirst({ where: { deletedAt: null }, select: { id: true, name: true } })
  if (!realClient) {
    tempClient = await prisma.client.create({
      data: { name: `AI e2e temp client ${Date.now()}` },
      select: { id: true, name: true },
    })
    realClient = tempClient
  }

  const canned: AssistantResult = {
    project: {
      title: 'Acme Widgets — Brand Video',
      description: 'A 90-second brand video.',
      client: { sourceName: realClient.name, matchedClientId: realClient.id, matchConfidence: 'exact', proposedNewClient: null },
      recipients: [{ name: 'Jane Doe', email: 'jane@acme.example', isPrimary: true }],
      startDate: '2026-07-20',
      keyDates: [{ type: 'SHOOTING', date: '2026-07-28', notes: null }],
      schedule: { useStandardTemplate: true, anchorDate: '2026-07-28', includeWeekends: false, extraTasks: [] },
    },
    sales: {
      docType: 'QUOTE',
      client: { sourceName: null, matchedClientId: 'bogus-client-id', matchConfidence: 'likely', proposedNewClient: null },
      issueDate: '2026-07-05',
      validUntil: '2026-08-05',
      dueDate: null,
      notes: null,
      terms: null,
      items: [
        { libraryItemId: null, description: 'Half-day shoot', details: null, quantity: 1, unitPriceCents: 120000, taxRatePercent: 10 },
      ],
    },
    reply: null,
    assumptions: [],
  }

  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url?.endsWith('/api/chat')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(canned) } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`

  const original = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { aiProvider: true, aiOllamaUrl: true, aiOllamaModel: true },
  })

  let requestId: string | null = null
  try {
    await prisma.settings.upsert({
      where: { id: 'default' },
      create: { id: 'default', aiProvider: 'OLLAMA', aiOllamaUrl: stubUrl, aiOllamaModel: 'stub-model' },
      update: { aiProvider: 'OLLAMA', aiOllamaUrl: stubUrl, aiOllamaModel: 'stub-model' },
    })

    const row = await prisma.aiAssistantRequest.create({
      data: {
        kind: 'combined',
        status: 'QUEUED',
        prompt: 'Brand video for Acme, see attached email.',
        attachmentsJson: [
          {
            fileName: 'client-brief.eml',
            kind: 'email',
            size: SAMPLE_EML.length,
            contentBase64: Buffer.from(SAMPLE_EML).toString('base64'),
          },
        ],
        contextJson: { request: { wantProject: true, wantSales: true, docType: 'QUOTE' } },
      },
      select: { id: true },
    })
    requestId = row.id

    await processAiAssistantRequest({ data: { requestId: row.id } } as never)

    const done = await prisma.aiAssistantRequest.findUnique({ where: { id: row.id } })
    check('request COMPLETED', done?.status === 'COMPLETED', done?.error ?? undefined)
    check('provider recorded', done?.provider === 'OLLAMA:stub-model', done?.provider ?? '(none)')
    const doneAttachments = (done?.attachmentsJson ?? []) as Array<{
      extractedText?: string | null
      contentBase64?: string | null
    }>
    check(
      'email attachment text extracted',
      !!doneAttachments[0]?.extractedText?.includes('Brand video for Acme')
    )
    check('raw base64 cleared after extraction', doneAttachments[0]?.contentBase64 == null)

    const result = done?.resultJson as unknown as AssistantResult | null
    check('project proposal present', result?.project?.title === 'Acme Widgets — Brand Video')
    check('valid client kept by guard', result?.project?.client.matchedClientId === realClient.id)
    check('bogus client nulled by guard', result?.sales?.client.matchedClientId === null)
    check('guard noted the intervention', (result?.assumptions ?? []).some((a) => a.startsWith('[guard]')))

    // Idempotency: reprocessing a COMPLETED request must be a no-op
    await processAiAssistantRequest({ data: { requestId: row.id } } as never)
    const after = await prisma.aiAssistantRequest.findUnique({ where: { id: row.id }, select: { updatedAt: true } })
    check('reprocessing is a no-op', after?.updatedAt.getTime() === done?.updatedAt.getTime())

    // Failure path: unreachable Ollama
    await prisma.settings.update({ where: { id: 'default' }, data: { aiOllamaUrl: 'http://127.0.0.1:1' } })
    const failRow = await prisma.aiAssistantRequest.create({
      data: { kind: 'combined', status: 'QUEUED', prompt: 'x', contextJson: { request: {} } },
      select: { id: true },
    })
    await processAiAssistantRequest({ data: { requestId: failRow.id } } as never)
    const failed = await prisma.aiAssistantRequest.findUnique({ where: { id: failRow.id } })
    check('unreachable Ollama → FAILED with error', failed?.status === 'FAILED' && !!failed.error, failed?.error ?? undefined)
    await prisma.aiAssistantRequest.delete({ where: { id: failRow.id } })
  } finally {
    if (requestId) await prisma.aiAssistantRequest.delete({ where: { id: requestId } }).catch(() => {})
    if (tempClient) await prisma.client.delete({ where: { id: tempClient.id } }).catch(() => {})
    await prisma.settings
      .update({
        where: { id: 'default' },
        data: {
          aiProvider: original?.aiProvider ?? 'NONE',
          aiOllamaUrl: original?.aiOllamaUrl ?? null,
          aiOllamaModel: original?.aiOllamaModel ?? null,
        },
      })
      .catch(() => {})
    await new Promise<void>((resolve) => stub.close(() => resolve()))
    await prisma.$disconnect()
  }

  console.log(failures === 0 ? '\nAll worker e2e checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(async (error) => {
  console.error('Worker e2e crashed:', error)
  await prisma.$disconnect().catch(() => {})
  process.exitCode = 1
})

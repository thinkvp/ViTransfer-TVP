/**
 * AI assistant dry-run — exercises the provider layer without a GPU or DB.
 *
 *   npx tsx scripts/ai-assistant-dry-run.ts
 *
 * Spins up a stub HTTP server that mimics Ollama's /api/chat + /api/tags and runs
 * the real Ollama driver against it: happy path, JSON-repair path, zod validation,
 * and the post-validation guards. Optionally, set AI_DRY_RUN_OLLAMA_URL and
 * AI_DRY_RUN_OLLAMA_MODEL to also run one real generation against a live Ollama.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { ZipArchive } from 'archiver'
import { createOllamaDriver } from '../src/lib/ai/ollama'
import {
  AssistantResultSchema,
  AssistantResultJsonSchema,
  applyProposalGuards,
  type AssistantResult,
} from '../src/lib/ai/proposal-schemas'
import { ASSISTANT_SYSTEM_PROMPT, buildAssistantUserMessage, buildRefineUserMessage } from '../src/lib/ai/prompts'
import { extractAttachmentText } from '../src/lib/ai/extraction'

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const CANNED_RESULT: AssistantResult = {
  project: {
    title: 'Acme Widgets — Brand Video',
    description: 'A 90-second brand video for the widget launch.',
    client: { sourceName: 'Acme Widgets', matchedClientId: 'client-acme', matchConfidence: 'exact', proposedNewClient: null },
    recipients: [
      { name: 'Jane Doe', email: 'jane@acme.example', isPrimary: true },
      { name: 'Simon', email: 'simon@ourstudio.example', isPrimary: false }, // own team → guard drops it
    ],
    startDate: '2026-07-20',
    keyDates: [
      { type: 'SHOOTING', date: '2026-07-28', notes: null },
      { type: 'DUE_DATE', date: 'sometime in august', notes: null }, // invalid on purpose → guard drops it
    ],
    schedule: { useStandardTemplate: true, anchorDate: '2026-07-28', includeWeekends: false, extraTasks: [] },
  },
  sales: {
    docType: 'QUOTE',
    client: {
      sourceName: 'Our Studio',
      matchedClientId: null,
      matchConfidence: 'none',
      // Own company proposed as a client → guard clears it
      proposedNewClient: { name: 'Our Studio Pty Ltd', address: null, phone: null, website: null, recipients: [] },
    },
    issueDate: '2026-07-05',
    validUntil: '2026-08-05',
    dueDate: null,
    notes: null,
    terms: null,
    items: [
      // Library item with a WRONG price copied by the model → guard applies library pricing + label
      { libraryItemId: 'lib-halfday', description: 'Half-day shoot', details: null, quantity: 1, unitPriceCents: 99, taxRatePercent: 0 },
      { libraryItemId: null, description: 'Editing', details: '2 revisions included', quantity: 8, unitPriceCents: 15000.7, taxRatePercent: 10 }, // float → guard truncates
      { libraryItemId: 'lib-UNKNOWN', description: 'Colour grade', details: null, quantity: 1, unitPriceCents: 40000, taxRatePercent: 10 }, // unknown library id → treated as custom
    ],
  },
  reply: {
    body: 'Hi Jane, thanks for reaching out about the launch video — a quote is on its way.',
    // one real portfolio id + one hallucinated id (guard drops the bogus one)
    portfolioItemIds: ['pf-brand', 'pf-DOES-NOT-EXIST'],
  },
  assumptions: ['Shoot date taken from "the last Tuesday of July".'],
}

const GUARD_CTX = {
  validClientIds: new Set(['client-acme']),
  clientNamesById: new Map([['client-acme', 'Acme Widgets Pty Ltd']]),
  today: '2026-07-05',
  ownCompanyNames: ['Our Studio Pty Ltd'],
  teamEmails: new Set(['simon@ourstudio.example']),
  libraryById: new Map([
    [
      'lib-halfday',
      {
        id: 'lib-halfday',
        description: 'Half-day shoot',
        details: 'Crew of two, on location',
        quantity: 1,
        unitPriceCents: 120000,
        taxRatePercent: 10,
        taxRateName: 'GST',
        labelId: 'label-1',
        labelName: 'Production',
        labelColor: '#3B82F6',
      },
    ],
  ]),
  portfolioById: new Map([
    ['pf-brand', { id: 'pf-brand', title: 'Acme Brand Launch', url: 'https://studio.example/work/acme', description: 'brand video' }],
  ]),
  replySignature: 'Cheers,\nThe Studio Team',
}

async function main() {
  // ---- Stub server: first /api/chat call returns broken JSON, second returns the canned result
  let chatCalls = 0
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url?.endsWith('/api/tags')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'stub-model:latest' }] }))
        return
      }
      if (req.url?.endsWith('/api/chat')) {
        chatCalls++
        const content =
          chatCalls === 1
            ? '{"project": <broken json'
            : JSON.stringify(CANNED_RESULT)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: { role: 'assistant', content } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as AddressInfo).port
  const stubUrl = `http://127.0.0.1:${port}`

  try {
    const driver = createOllamaDriver({ url: stubUrl, model: 'stub-model' })

    // 1. testConnection
    const test = await driver.testConnection()
    check('testConnection against stub', test.ok, test.detail)

    // 2. generateStructured with repair path (first response is broken JSON)
    const user = buildAssistantUserMessage({
      clients: [{ id: 'client-acme', name: 'Acme Widgets' }],
      clientsTruncated: false,
      today: '2026-07-05',
      taxRatePercent: 10,
      defaultTerms: null,
      ownCompanyNames: ['Our Studio Pty Ltd'],
      team: [{ name: 'Simon', email: 'simon@ourstudio.example' }],
      libraryItems: [
        { id: 'lib-halfday', description: 'Half-day shoot', quantity: 1, unitPriceCents: 120000, taxRatePercent: 10, labelName: 'Production' },
      ],
      portfolio: [{ id: 'pf-brand', title: 'Acme Brand Launch', description: 'brand video' }],
      studioInstructions: 'Australian English, warm but concise.',
      replyRequested: true,
      wantProject: true,
      wantSales: true,
      docType: 'QUOTE',
      brief: 'Brand video for Acme. Shoot last Tuesday of July. Budget ~$2,400 + GST.',
      attachments: [],
    })
    const raw = await driver.generateStructured({
      system: ASSISTANT_SYSTEM_PROMPT,
      user,
      schema: AssistantResultSchema,
      jsonSchema: AssistantResultJsonSchema,
      timeoutMs: 10_000,
    })
    check('repair path exercised (2 chat calls)', chatCalls === 2, `calls=${chatCalls}`)

    // 3. zod validation
    const parsed = AssistantResultSchema.safeParse(raw)
    check('zod validation of canned result', parsed.success, parsed.success ? undefined : parsed.error.message)
    if (!parsed.success) throw new Error('cannot continue')

    // 4. guards
    const guarded = applyProposalGuards(parsed.data, GUARD_CTX)
    check('guard keeps valid client', guarded.project?.client.matchedClientId === 'client-acme')
    check(
      'guard drops invalid key date',
      guarded.project?.keyDates.length === 1 && guarded.project.keyDates[0].type === 'SHOOTING'
    )
    check('guard truncates float cents', guarded.sales?.items[1]?.unitPriceCents === 15000)
    check(
      'guard drops own-team recipient',
      guarded.project?.recipients.length === 1 && guarded.project.recipients[0].email === 'jane@acme.example'
    )
    check('guard clears own company as new client', guarded.sales?.client.proposedNewClient === null)
    const libItem = guarded.sales?.items[0] as (typeof CANNED_RESULT.sales & object)['items'][0] & {
      labelName?: string | null
      taxRateName?: string | null
    }
    check(
      'guard applies library pricing + label',
      libItem?.unitPriceCents === 120000 && libItem?.taxRatePercent === 10 && libItem?.labelName === 'Production'
    )
    check(
      'guard downgrades unknown library id to custom',
      (guarded.sales?.items[2] as { libraryItemId?: string | null })?.libraryItemId === null
    )
    const reply = guarded.reply as (typeof CANNED_RESULT)['reply'] & {
      portfolio?: Array<{ id: string; title: string; url: string }>
      signature?: string | null
    }
    check(
      'guard resolves known portfolio id to real url + drops unknown',
      reply?.portfolio?.length === 1 &&
        reply.portfolio[0].url === 'https://studio.example/work/acme' &&
        reply.portfolio[0].title === 'Acme Brand Launch'
    )
    check('guard attaches signature to reply', reply?.signature === 'Cheers,\nThe Studio Team')
    check('guards recorded assumptions', guarded.assumptions.some((a) => a.startsWith('[guard]')))

    // 4a. name-mismatch: a valid id but the source names a different org → rejected, becomes new client
    const mismatch: AssistantResult = {
      project: {
        title: 'Etex — Bundaberg Solar Video',
        description: null,
        client: { sourceName: 'Etex Australia Pty Ltd', matchedClientId: 'client-acme', matchConfidence: 'exact', proposedNewClient: null },
        recipients: [],
        startDate: null,
        keyDates: [],
        schedule: null,
      },
      sales: null,
      reply: null,
      assumptions: [],
    }
    const mismatchGuarded = applyProposalGuards(mismatch, GUARD_CTX)
    check(
      'guard rejects a confidently-wrong client match (name mismatch)',
      mismatchGuarded.project?.client.matchedClientId === null &&
        mismatchGuarded.project?.client.proposedNewClient?.name === 'Etex Australia Pty Ltd'
    )
    // and does NOT reject a genuine name correspondence (source "Acme Widgets" ↔ "Acme Widgets Pty Ltd")
    check('guard keeps a genuine client match (name corresponds)', guarded.project?.client.matchedClientId === 'client-acme')

    // 4b. refine prompt shape includes current proposal + change request
    const refineUser = buildRefineUserMessage({
      today: '2026-07-05',
      clients: [{ id: 'client-acme', name: 'Acme Widgets' }],
      clientsTruncated: false,
      portfolio: [],
      currentProposal: guarded,
      instruction: 'Move the shoot to the 30th.',
    })
    check(
      'refine prompt carries current proposal + change request',
      refineUser.includes('<current_proposal>') && refineUser.includes('Move the shoot to the 30th')
    )

    // 5. timeout path
    const deadDriver = createOllamaDriver({ url: 'http://127.0.0.1:1', model: 'stub-model' })
    const dead = await deadDriver.testConnection()
    check('unreachable Ollama reports failure', !dead.ok, dead.detail)

    // 6. attachment text extraction — real parsers against generated files
    // 6a. PDF (generated with pdf-lib)
    const pdfDoc = await PDFDocument.create()
    const pdfPage = pdfDoc.addPage()
    const pdfFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
    pdfPage.drawText('PDF brief: shoot on 28 July, budget $2,400 + GST.', { x: 50, y: 700, size: 12, font: pdfFont })
    const pdfBytes = await pdfDoc.save()
    const pdfResult = await extractAttachmentText({
      fileName: 'brief.pdf',
      kind: 'document',
      size: pdfBytes.length,
      contentBase64: Buffer.from(pdfBytes).toString('base64'),
    })
    check(
      'PDF text extracted',
      !!pdfResult.extractedText?.includes('shoot on 28 July') && pdfResult.contentBase64 == null,
      pdfResult.extractionError ?? undefined
    )

    // 6b. DOCX (minimal OOXML zip built with archiver)
    const docxBuffer = await new Promise<Buffer>((resolve, reject) => {
      const archive = new ZipArchive({ zlib: { level: 6 } })
      const sink = new PassThrough()
      const chunks: Buffer[] = []
      sink.on('data', (c: Buffer) => chunks.push(c))
      sink.on('end', () => resolve(Buffer.concat(chunks)))
      archive.on('error', reject)
      archive.pipe(sink)
      archive.append(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        { name: '[Content_Types].xml' }
      )
      archive.append(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        { name: '_rels/.rels' }
      )
      archive.append(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docx brief: contact jane@acme.example for the launch video.</w:t></w:r></w:p></w:body></w:document>`,
        { name: 'word/document.xml' }
      )
      void archive.finalize()
    })
    const docxResult = await extractAttachmentText({
      fileName: 'brief.docx',
      kind: 'document',
      size: docxBuffer.length,
      contentBase64: docxBuffer.toString('base64'),
    })
    check(
      'DOCX text extracted',
      !!docxResult.extractedText?.includes('jane@acme.example') && docxResult.contentBase64 == null,
      docxResult.extractionError ?? undefined
    )

    // 6c. plain text + eml
    const txtResult = await extractAttachmentText({
      fileName: 'notes.txt',
      kind: 'document',
      size: 10,
      contentBase64: Buffer.from('Plain text notes.').toString('base64'),
    })
    check('TXT text extracted', txtResult.extractedText === 'Plain text notes.')

    const eml = 'From: Jane <jane@acme.example>\r\nTo: studio@x.com\r\nSubject: Launch video\r\n\r\nHi, brief attached.'
    const emlResult = await extractAttachmentText({
      fileName: 'client.eml',
      kind: 'email',
      size: eml.length,
      contentBase64: Buffer.from(eml).toString('base64'),
    })
    check(
      'EML text extracted with headers',
      !!emlResult.extractedText?.includes('Subject: Launch video') && !!emlResult.extractedText?.includes('brief attached')
    )

    // 6d. corrupt file → extractionError, not a throw
    const corrupt = await extractAttachmentText({
      fileName: 'broken.pdf',
      kind: 'document',
      size: 4,
      contentBase64: Buffer.from('%PDFnot-really-a-pdf').toString('base64'),
    })
    check('corrupt PDF reports extractionError', !corrupt.extractedText && !!corrupt.extractionError)
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()))
  }

  // ---- Optional: live Ollama round-trip
  const liveUrl = process.env.AI_DRY_RUN_OLLAMA_URL
  const liveModel = process.env.AI_DRY_RUN_OLLAMA_MODEL
  if (liveUrl && liveModel) {
    console.log(`\nRunning live generation against ${liveUrl} (${liveModel})...`)
    const live = createOllamaDriver({ url: liveUrl, model: liveModel })
    const raw = await live.generateStructured({
      system: ASSISTANT_SYSTEM_PROMPT,
      user: buildAssistantUserMessage({
        clients: [{ id: 'client-acme', name: 'Acme Widgets' }],
        clientsTruncated: false,
        today: new Date().toISOString().slice(0, 10),
        taxRatePercent: 10,
        defaultTerms: null,
        ownCompanyNames: ['Our Studio Pty Ltd'],
        team: [{ name: 'Simon', email: 'simon@ourstudio.example' }],
        libraryItems: [
          { id: 'lib-halfday', description: 'Half-day shoot', quantity: 1, unitPriceCents: 120000, taxRatePercent: 10, labelName: 'Production' },
        ],
        portfolio: [{ id: 'pf-brand', title: 'Acme Brand Launch', description: 'brand video' }],
        studioInstructions: null,
        replyRequested: false,
        wantProject: true,
        wantSales: true,
        docType: 'QUOTE',
        brief:
          'New brand video for Acme Widgets. Contact jane@acme.example. Shoot on the 28th, deliver mid August. Half day shoot $1,200 + GST, editing 8h at $150/h + GST.',
        attachments: [],
      }),
      schema: AssistantResultSchema,
      jsonSchema: AssistantResultJsonSchema,
    })
    const parsed = AssistantResultSchema.safeParse(raw)
    check('live generation zod-valid', parsed.success, parsed.success ? undefined : parsed.error.message)
    if (parsed.success) console.log(JSON.stringify(parsed.data, null, 2))
  }

  console.log(failures === 0 ? '\nAll dry-run checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('Dry-run crashed:', error)
  process.exitCode = 1
})

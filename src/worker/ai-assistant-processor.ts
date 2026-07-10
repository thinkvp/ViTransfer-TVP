import { Job } from 'bullmq'
import type { AiAssistantRequest, Prisma } from '@prisma/client'
import { prisma } from '../lib/db'
import type { AiAssistantJob } from '../lib/queue'
import { getAiDriver, AiNotConfiguredError } from '../lib/ai'
import type { AiDriver, AiUserContentPart } from '../lib/ai/types'
import {
  AssistantResultSchema,
  AssistantResultJsonSchema,
  applyProposalGuards,
} from '../lib/ai/proposal-schemas'
import {
  ExpenseResultSchema,
  ExpenseResultJsonSchema,
  applyExpenseGuards,
  type ResolvedExpenseProposal,
  type ResolvedExpenseResult,
} from '../lib/ai/expense-schemas'
import {
  ASSISTANT_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  EXPENSE_SYSTEM_PROMPT,
  EXPENSE_REFINE_SYSTEM_PROMPT,
  buildAssistantUserMessage,
  buildRefineUserMessage,
  buildExpenseUserMessage,
  buildExpenseRefineUserMessage,
  type ExpenseAccountOption,
  type ExpenseReceiptPart,
} from '../lib/ai/prompts'
import { extractAttachmentText } from '../lib/ai/extraction'
import { attachmentMimeType, type AiRequestAttachment } from '../lib/ai/attachments'
import type { LibraryItem } from '../lib/ai/proposal-schemas'
import { getDefaultTaxRatePercent } from '../lib/sales/line-items'
import { buildHistoricalMappings } from '../lib/accounting/description-match'
import { processImageBuffer } from '../lib/image-processing'

const DEBUG = process.env.DEBUG_WORKER === 'true'

const CLIENT_LIST_CAP = 1000
const MAX_ERROR_LENGTH = 4000

interface RequestInputMeta {
  wantProject: boolean
  wantSales: boolean
  wantReply: boolean
  wantExpense: boolean
  docType: 'QUOTE' | 'INVOICE' | 'BOTH'
}

function parseRequestMeta(contextJson: unknown): RequestInputMeta {
  const meta = (contextJson as { request?: Partial<RequestInputMeta> } | null)?.request ?? {}
  return {
    wantProject: meta.wantProject !== false,
    wantSales: meta.wantSales !== false,
    // Reply drafts are opt-in per request (the page "Response" pill), not a global setting
    wantReply: meta.wantReply === true,
    // Expense (receipt extraction) mode — exclusive of the flags above
    wantExpense: meta.wantExpense === true,
    docType: meta.docType === 'INVOICE' || meta.docType === 'BOTH' ? meta.docType : 'QUOTE',
  }
}

interface RefineInput {
  instruction: string
  of: unknown // prior AssistantResult JSON
}

function parseRefineInput(contextJson: unknown): RefineInput | null {
  const refine = (contextJson as { refine?: { instruction?: unknown; of?: unknown } } | null)?.refine
  if (!refine || typeof refine.instruction !== 'string' || !refine.of) return null
  return { instruction: refine.instruction, of: refine.of }
}

async function markFailed(requestId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await prisma.aiAssistantRequest.update({
    where: { id: requestId },
    data: {
      status: 'FAILED',
      error: message.slice(0, MAX_ERROR_LENGTH),
      completedAt: new Date(),
    },
  })
}

export async function processAiAssistantRequest(job: Job<AiAssistantJob>) {
  const { requestId } = job.data

  const request = await prisma.aiAssistantRequest.findUnique({ where: { id: requestId } })
  if (!request) {
    console.warn(`[ai-assistant] Request ${requestId} not found — skipping`)
    return
  }
  // Idempotency: only ever process a request once, even if the job is re-delivered
  if (request.status !== 'QUEUED') {
    if (DEBUG) console.log(`[ai-assistant] Request ${requestId} is ${request.status} — skipping`)
    return
  }

  await prisma.aiAssistantRequest.update({
    where: { id: requestId },
    data: { status: 'PROCESSING', error: null },
  })

  try {
    const driver = await getAiDriver()

    // Connection test: just exercise the provider and record the outcome
    if (request.kind === 'connection_test') {
      const result = await driver.testConnection()
      await prisma.aiAssistantRequest.update({
        where: { id: requestId },
        data: {
          status: result.ok ? 'COMPLETED' : 'FAILED',
          resultJson: { connectionTest: result } as unknown as Prisma.InputJsonValue,
          error: result.ok ? null : result.detail,
          provider: driver.label,
          completedAt: new Date(),
        },
      })
      return
    }

    // Expense (receipt) mode has its own attachment handling — images/PDFs go
    // to the model as native vision parts, not through text extraction.
    const earlyMeta = parseRequestMeta(request.contextJson)
    if (earlyMeta.wantExpense) {
      await processExpenseRequest(request, driver)
      return
    }

    // Extract text from attachments (.eml / .pdf / .docx / .txt). Extraction
    // failures are per-attachment and non-fatal — the request continues with
    // whatever could be read; failures surface as extractionError on the row.
    const rawAttachments = Array.isArray(request.attachmentsJson)
      ? (request.attachmentsJson as unknown as AiRequestAttachment[])
      : []
    let extractedAttachments: AiRequestAttachment[] = []
    if (rawAttachments.length > 0) {
      extractedAttachments = []
      for (const att of rawAttachments) {
        extractedAttachments.push(await extractAttachmentText(att))
      }
      // Persist extracted text (audit) and drop the raw base64 from the DB
      await prisma.aiAssistantRequest.update({
        where: { id: requestId },
        data: { attachmentsJson: extractedAttachments as unknown as Prisma.InputJsonValue },
      })
      for (const att of extractedAttachments) {
        if (att.extractionError) {
          console.warn(`[ai-assistant] ${requestId}: could not extract "${att.fileName}": ${att.extractionError}`)
        }
      }
    }

    // Snapshot context for the LLM (persisted for audit)
    const meta = parseRequestMeta(request.contextJson)
    const clients = await prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: CLIENT_LIST_CAP + 1,
    })
    const clientsTruncated = clients.length > CLIENT_LIST_CAP
    const clientList = clients.slice(0, CLIENT_LIST_CAP)
    const today = new Date().toISOString().slice(0, 10)
    const taxRatePercent = await getDefaultTaxRatePercent(prisma)
    const salesSettings = await prisma.salesSettings
      .findUnique({ where: { id: 'default' }, select: { defaultTerms: true, businessName: true } })
      .catch(() => null)

    // Safeguard + customisation context from Settings
    const appSettings = await prisma.settings
      .findUnique({
        where: { id: 'default' },
        select: {
          companyName: true,
          aiReplySignature: true,
          aiInstructions: true,
        },
      })
      .catch(() => null)
    const ownCompanyNames = [appSettings?.companyName, salesSettings?.businessName]
      .map((n) => (n ?? '').trim())
      .filter(Boolean)
    const studioInstructions = (appSettings?.aiInstructions ?? '').trim() || null
    const replySignature = (appSettings?.aiReplySignature ?? '').trim() || null
    const teamUsers = await prisma.user.findMany({
      where: { active: true },
      select: { name: true, email: true },
    })

    // Line Item Library (SalesItem + label) — authoritative pricing for quotes/invoices
    const salesItems = await prisma.salesItem.findMany({
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        description: true,
        details: true,
        quantity: true,
        unitPriceCents: true,
        taxRatePercent: true,
        taxRateName: true,
        labelId: true,
        label: { select: { name: true, color: true } },
      },
    })
    const libraryItems: LibraryItem[] = salesItems.map((item) => ({
      id: item.id,
      description: item.description,
      details: item.details,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxRatePercent: item.taxRatePercent,
      taxRateName: item.taxRateName,
      labelId: item.labelId,
      labelName: item.label?.name ?? null,
      labelColor: item.label?.color ?? null,
    }))

    // Refine mode: revise a prior proposal with a targeted change instead of a fresh extraction
    const refine = parseRefineInput(request.contextJson)

    let system: string
    let user: string
    if (refine) {
      system = REFINE_SYSTEM_PROMPT
      user = buildRefineUserMessage({
        today,
        clients: clientList,
        clientsTruncated,
        portfolio: [],
        currentProposal: refine.of,
        instruction: refine.instruction,
      })
    } else {
      system = ASSISTANT_SYSTEM_PROMPT
      user = buildAssistantUserMessage({
        clients: clientList,
        clientsTruncated,
        today,
        taxRatePercent,
        defaultTerms: salesSettings?.defaultTerms ?? null,
        ownCompanyNames,
        team: teamUsers.map((u) => ({ name: u.name || u.email, email: u.email })),
        libraryItems: libraryItems.map((item) => ({
          id: item.id,
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          taxRatePercent: item.taxRatePercent,
          labelName: item.labelName,
        })),
        portfolio: [],
        studioInstructions,
        replyRequested: meta.wantReply,
        wantProject: meta.wantProject,
        wantSales: meta.wantSales,
        docType: meta.docType,
        brief: request.prompt || '(no text brief — extract everything from the attachments)',
        attachments: extractedAttachments
          // 'audio' attachments belong to dictation requests (transcription queue) and never reach this prompt
          .filter((a): a is typeof a & { kind: 'email' | 'document' } => !!a.extractedText && a.kind !== 'audio')
          .map((a) => ({ fileName: a.fileName, kind: a.kind, text: a.extractedText as string })),
      })
    }

    const generateParams = {
      system,
      user,
      schema: AssistantResultSchema,
      jsonSchema: AssistantResultJsonSchema,
    }

    let raw = await driver.generateStructured(generateParams)
    let parsed = AssistantResultSchema.safeParse(raw)

    if (!parsed.success) {
      // One schema-repair retry (matters for Ollama; the Anthropic path is schema-guaranteed)
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      if (DEBUG) console.log(`[ai-assistant] ${requestId} schema retry: ${issues}`)
      raw = await driver.generateStructured({
        ...generateParams,
        user: `${user}\n\nYour previous attempt did not match the schema (${issues}). Return a corrected JSON document.`,
      })
      parsed = AssistantResultSchema.safeParse(raw)
    }

    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      throw new Error(`Model output did not match the expected schema: ${issues}`)
    }

    // Hard guards regardless of provider: unknown client ids, malformed dates,
    // fabricated-looking emails, non-integer money, own-brand/team leakage,
    // and authoritative library pricing/labels
    const guarded = applyProposalGuards(parsed.data, {
      validClientIds: new Set(clientList.map((c) => c.id)),
      clientNamesById: new Map(clientList.map((c) => [c.id, c.name])),
      today,
      ownCompanyNames,
      teamEmails: new Set(teamUsers.map((u) => u.email)),
      libraryById: new Map(libraryItems.map((item) => [item.id, item])),
      portfolioById: new Map(),
      replySignature,
      studioKnowledge: studioInstructions,
    })

    // Surface it loudly when the model skipped a section the user asked for —
    // otherwise the missing card is easy to miss on the review screen.
    if (meta.wantProject && !guarded.project) {
      guarded.assumptions.push(
        '[guard] A project setup was requested but the model did not produce one — try re-running, or add a line like "set up a project for this" to the brief.'
      )
    }
    if (meta.wantSales && !guarded.sales) {
      guarded.assumptions.push(
        '[guard] A quote/invoice was requested but the model did not produce one — try re-running, or spell out the billable work in the brief.'
      )
    }
    if (meta.wantReply && !guarded.reply?.body) {
      guarded.assumptions.push(
        '[guard] A reply was requested but the model did not produce one — this usually means the brief did not read like an enquiry to reply to.'
      )
    }

    await prisma.aiAssistantRequest.update({
      where: { id: requestId },
      data: {
        status: 'COMPLETED',
        resultJson: guarded as unknown as Prisma.InputJsonValue,
        provider: driver.label,
        completedAt: new Date(),
      },
    })
    if (DEBUG) console.log(`[ai-assistant] Request ${requestId} completed via ${driver.label}`)
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) {
      console.error(`[ai-assistant] Request ${requestId} failed:`, error)
    }
    await markFailed(requestId, error)
  }
}

/**
 * Expense (receipt extraction) mode. Receipt photos go to the model as native
 * image parts (downscaled first); PDFs go as native document parts on providers
 * that support them, otherwise fall back to text extraction. The model returns
 * one proposed expense per receipt; guards + duplicate detection run before the
 * result is stored for the review card. Errors propagate to the caller's
 * markFailed handler.
 */
async function processExpenseRequest(request: AiAssistantRequest, driver: AiDriver) {
  const requestId = request.id
  const refine = parseRefineInput(request.contextJson)
  const today = new Date().toISOString().slice(0, 10)

  const accounts: ExpenseAccountOption[] = await prisma.account.findMany({
    where: { type: { in: ['EXPENSE', 'COGS'] }, isActive: true },
    select: { id: true, code: true, name: true, type: true, subType: true, taxCode: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  const accountsById = new Map(accounts.map((a) => [a.id, { code: a.code, name: a.name }]))

  // Assumptions produced by attachment handling, surfaced ahead of the model's own
  const preAssumptions: string[] = []
  let system: string
  let user: string | AiUserContentPart[]
  let attachmentCount: number
  let sentImagesToOllama = false

  if (refine) {
    // Strip worker enrichment (possibleDuplicate) before sending back to the model;
    // it is recomputed below. Receipts are not resent on a refine turn.
    const prior = refine.of as Partial<ResolvedExpenseResult>
    const priorExpenses = Array.isArray(prior?.expenses) ? prior.expenses : []
    const current = {
      expenses: priorExpenses.map(({ possibleDuplicate: _dup, ...rest }) => rest),
      assumptions: [],
    }
    // attachmentIndex values still refer to the original turn's receipts
    attachmentCount = Math.max(1, ...priorExpenses.map((e) => (Number.isFinite(e.attachmentIndex) ? Math.trunc(e.attachmentIndex) + 1 : 1)))
    system = EXPENSE_REFINE_SYSTEM_PROMPT
    user = buildExpenseRefineUserMessage({
      accounts,
      today,
      currentResult: current,
      instruction: refine.instruction,
    })
  } else {
    const rawAttachments = Array.isArray(request.attachmentsJson)
      ? (request.attachmentsJson as unknown as AiRequestAttachment[])
      : []
    attachmentCount = rawAttachments.length

    const receipts: ExpenseReceiptPart[] = []
    const persisted: AiRequestAttachment[] = []
    for (const [index, att] of rawAttachments.entries()) {
      const { contentBase64, ...rest } = att
      if (!contentBase64) {
        persisted.push({ ...rest, contentBase64: null, extractionError: att.extractionError ?? 'No content provided' })
        preAssumptions.push(`[guard] Receipt "${att.fileName}" had no content and was skipped.`)
        continue
      }
      if (att.kind === 'image') {
        try {
          // Downscale before sending — keeps vision tokens sane on phone photos
          const processed = await processImageBuffer(
            Buffer.from(contentBase64, 'base64'),
            att.mimeType || attachmentMimeType(att.fileName)
          )
          receipts.push({
            index,
            fileName: att.fileName,
            part: { type: 'image', base64: processed.buffer.toString('base64'), mimeType: processed.mimeType },
          })
          persisted.push({ ...rest, contentBase64: null, extractedText: null, extractionError: null })
          if (!driver.supportsPdfInput) sentImagesToOllama = true
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          persisted.push({ ...rest, contentBase64: null, extractionError: detail.slice(0, 500) })
          preAssumptions.push(`[guard] Receipt "${att.fileName}" could not be processed as an image — it was skipped.`)
        }
      } else if (driver.supportsPdfInput) {
        receipts.push({
          index,
          fileName: att.fileName,
          part: { type: 'document', base64: contentBase64, mimeType: 'application/pdf', fileName: att.fileName },
        })
        persisted.push({ ...rest, contentBase64: null, extractedText: null, extractionError: null })
      } else {
        // Provider can't read PDFs natively (Ollama) — fall back to text extraction
        const extracted = await extractAttachmentText(att)
        persisted.push(extracted)
        if (extracted.extractedText) {
          receipts.push({ index, fileName: att.fileName, part: { type: 'extracted-text', text: extracted.extractedText } })
        } else {
          preAssumptions.push(
            `[guard] Receipt "${att.fileName}" could not be read (${extracted.extractionError ?? 'no text found'}) — it was skipped. Scanned PDFs need a provider with native PDF support (OpenAI/Anthropic).`
          )
        }
      }
    }

    // Persist processing outcomes (audit) and drop the raw base64 from the DB —
    // the browser holds the originals and attaches them to created expenses.
    await prisma.aiAssistantRequest.update({
      where: { id: requestId },
      data: { attachmentsJson: persisted as unknown as Prisma.InputJsonValue },
    })

    if (receipts.length === 0) {
      throw new Error('None of the attached receipts could be read — are they valid photos or PDFs?')
    }

    const [accountingSettings, historicalMappings, taxRatePercent] = await Promise.all([
      prisma.accountingSettings
        .findUnique({ where: { id: 'default' }, select: { accountingInstructions: true } })
        .catch(() => null),
      buildHistoricalMappings(prisma),
      getDefaultTaxRatePercent(prisma),
    ])

    system = EXPENSE_SYSTEM_PROMPT
    user = buildExpenseUserMessage({
      accounts,
      historicalMappings,
      // Expense mode deliberately uses the accounting rulebook, not the studio knowledge doc
      accountingInstructions: (accountingSettings?.accountingInstructions ?? '').trim() || null,
      today,
      taxRatePercent,
      brief: request.prompt || '',
      receipts,
    })
  }

  const generateParams = {
    system,
    user,
    schema: ExpenseResultSchema,
    jsonSchema: ExpenseResultJsonSchema,
  }

  let raw = await driver.generateStructured(generateParams)
  let parsed = ExpenseResultSchema.safeParse(raw)

  if (!parsed.success) {
    // One schema-repair retry (matters for Ollama; the Anthropic path is schema-guaranteed)
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    if (DEBUG) console.log(`[ai-assistant] ${requestId} expense schema retry: ${issues}`)
    const repairNote = `Your previous attempt did not match the schema (${issues}). Return a corrected JSON document.`
    const repairedUser: string | AiUserContentPart[] =
      typeof user === 'string' ? `${user}\n\n${repairNote}` : [...user, { type: 'text', text: repairNote }]
    raw = await driver.generateStructured({ ...generateParams, user: repairedUser })
    parsed = ExpenseResultSchema.safeParse(raw)
  }

  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Model output did not match the expected schema: ${issues}`)
  }

  const guarded = applyExpenseGuards(parsed.data, { accountsById, today, attachmentCount })
  guarded.assumptions.unshift(...preAssumptions)
  if (sentImagesToOllama) {
    guarded.assumptions.unshift(
      '[guard] Receipt photos were sent to a local Ollama model — reading them requires a vision-capable (multimodal) model. If the extracted values look like guesses, switch to a vision model or a cloud provider.'
    )
  }
  if (guarded.expenses.length === 0) {
    guarded.assumptions.push(
      '[guard] No expenses were extracted — are the attached files readable receipts or invoices?'
    )
  }

  // Flag likely re-entries: an existing expense with the same date and amount
  const expenses: ResolvedExpenseProposal[] = await Promise.all(
    guarded.expenses.map(async (e) => {
      const dup = await prisma.expense.findFirst({
        where: { date: e.date, amountIncGst: Math.round(e.amountIncGst * 100) },
        select: { id: true, date: true, description: true, amountIncGst: true },
      })
      return {
        ...e,
        possibleDuplicate: dup
          ? { expenseId: dup.id, date: dup.date, amountIncGst: dup.amountIncGst / 100, description: dup.description }
          : null,
      }
    })
  )

  const result: ResolvedExpenseResult = { expenses, assumptions: guarded.assumptions }
  await prisma.aiAssistantRequest.update({
    where: { id: requestId },
    data: {
      status: 'COMPLETED',
      resultJson: result as unknown as Prisma.InputJsonValue,
      provider: driver.label,
      completedAt: new Date(),
    },
  })
  if (DEBUG) console.log(`[ai-assistant] Expense request ${requestId} completed via ${driver.label}`)
}

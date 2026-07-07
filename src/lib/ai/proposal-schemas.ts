import { z } from 'zod'

// Proposal JSON contract shared by the worker (validation) and the admin UI (typing).
// Structured-output-safe: no min/max/format constraints (unsupported by grammar-constrained
// decoding); dates and emails are enforced post-parse by applyProposalGuards().

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const RecipientProposalSchema = z.object({
  name: z.string(),
  email: z.string(),
  isPrimary: z.boolean(),
})

export const ClientMatchSchema = z.object({
  // The organisation name as found in the source (brief/email/attachment). Always set when
  // the source names a client — used by applyProposalGuards to sanity-check any match.
  sourceName: z.string().nullable(),
  // Must be an id from the client list provided in the prompt — enforced by applyProposalGuards
  matchedClientId: z.string().nullable(),
  matchConfidence: z.enum(['exact', 'likely', 'none']),
  proposedNewClient: z
    .object({
      name: z.string(),
      address: z.string().nullable(),
      phone: z.string().nullable(),
      website: z.string().nullable(),
      // Contact people to store on the new client record (Client Recipients)
      recipients: z.array(RecipientProposalSchema),
    })
    .nullable(),
})

export const KeyDateProposalSchema = z.object({
  type: z.enum(['PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER']),
  date: z.string(), // YYYY-MM-DD
  notes: z.string().nullable(),
})

export const ScheduleExtraTaskSchema = z.object({
  phaseName: z.string(),
  name: z.string(),
  kind: z.enum(['BAR', 'MILESTONE']),
  owner: z.enum(['STUDIO', 'CLIENT']),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(), // YYYY-MM-DD
})

export const ProjectProposalSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  client: ClientMatchSchema,
  recipients: z.array(RecipientProposalSchema),
  startDate: z.string().nullable(), // YYYY-MM-DD
  keyDates: z.array(KeyDateProposalSchema),
  schedule: z
    .object({
      useStandardTemplate: z.boolean(),
      anchorDate: z.string(), // YYYY-MM-DD, usually the shooting date
      includeWeekends: z.boolean(),
      extraTasks: z.array(ScheduleExtraTaskSchema),
    })
    .nullable(),
})

export const SalesLineItemProposalSchema = z.object({
  // Id from the <line_item_library> in the prompt, or null for a custom item.
  // When set, applyProposalGuards overrides pricing/tax/label from the library —
  // the library is authoritative, the model only picks the item and quantity.
  libraryItemId: z.string().nullable(),
  description: z.string(),
  details: z.string().nullable(),
  quantity: z.number(),
  unitPriceCents: z.number(), // integer cents, coerced by applyProposalGuards
  taxRatePercent: z.number(),
})

export const SalesProposalSchema = z.object({
  docType: z.enum(['QUOTE', 'INVOICE', 'BOTH']),
  client: ClientMatchSchema,
  issueDate: z.string(), // YYYY-MM-DD
  validUntil: z.string().nullable(), // quotes
  dueDate: z.string().nullable(), // invoices
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  items: z.array(SalesLineItemProposalSchema),
})

export const ReplyDraftSchema = z.object({
  // Copy/paste reply body in the studio's voice (signature is appended in code, not by the model)
  body: z.string(),
  // Ids from <portfolio> the model judged relevant — resolved to real title/url by guards
  portfolioItemIds: z.array(z.string()),
})

export const AssistantResultSchema = z.object({
  project: ProjectProposalSchema.nullable(),
  sales: SalesProposalSchema.nullable(),
  // Enquiry reply draft — null unless reply drafting is enabled in settings
  reply: ReplyDraftSchema.nullable(),
  // Free-text notes about guesses/ambiguities the model made — surfaced in the review UI
  assumptions: z.array(z.string()),
})

// Plain JSON schema for Ollama's `format` (grammar-constrained decoding)
export const AssistantResultJsonSchema = z.toJSONSchema(AssistantResultSchema) as Record<string, unknown>

export type ClientMatch = z.infer<typeof ClientMatchSchema>
export type RecipientProposal = z.infer<typeof RecipientProposalSchema>
export type ProjectProposal = z.infer<typeof ProjectProposalSchema>
export type SalesProposal = z.infer<typeof SalesProposalSchema>
export type SalesLineItemProposal = z.infer<typeof SalesLineItemProposalSchema>
export type ReplyDraft = z.infer<typeof ReplyDraftSchema>
export type AssistantResult = z.infer<typeof AssistantResultSchema>

/** A portfolio piece the model can reference in a reply (chosen by id; url filled from here) */
export interface PortfolioItem {
  id: string
  title: string
  url: string
  description: string
}

/** Reply portfolio pick resolved to real title/url by the guard (the model never emits URLs) */
export interface ResolvedPortfolioPick {
  id: string
  title: string
  url: string
}

/** The guard attaches resolved portfolio picks + signature to the reply for the UI to render */
export interface ResolvedReplyDraft extends ReplyDraft {
  portfolio: ResolvedPortfolioPick[]
  signature: string | null
}

/** A Line Item Library entry (SalesItem + label snapshot) used for guard-side resolution */
export interface LibraryItem {
  id: string
  description: string
  details: string
  quantity: number
  unitPriceCents: number
  taxRatePercent: number
  taxRateName: string | null
  labelId: string | null
  labelName: string | null
  labelColor: string | null
}

/**
 * Resolved line item as stored on the result and sent to the sales endpoints.
 * Extends the proposal with the label snapshot fields SalesLineItem carries
 * (they pass through the server's lineItemsSchema untouched).
 */
export interface ResolvedSalesLineItem extends SalesLineItemProposal {
  taxRateName?: string | null
  labelId?: string | null
  labelName?: string | null
  labelColor?: string | null
}

export interface ProposalGuardContext {
  validClientIds: Set<string>
  /** Client id → name, used to sanity-check a proposed match against the source's client name */
  clientNamesById: Map<string, string>
  today: string // YYYY-MM-DD
  /** Our own brand names (Settings.companyName, SalesSettings.businessName) — never a client */
  ownCompanyNames: string[]
  /** Our own team's emails (Users) — never client recipients */
  teamEmails: Set<string>
  /** Line Item Library keyed by id — authoritative pricing/labels */
  libraryById: Map<string, LibraryItem>
  /** Portfolio pieces keyed by id — authoritative title/url for reply links */
  portfolioById: Map<string, PortfolioItem>
  /** Sign-off appended to a drafted reply */
  replySignature: string | null
  /**
   * The freeform studio knowledge doc (Settings house-style text) verbatim. Any URL the
   * model puts in a reply must appear literally here, or the guard strips it — this is the
   * anti-hallucination backstop that lets the model cite portfolio links from plain text.
   */
  studioKnowledge: string | null
}

/** Normalise a URL for verbatim comparison: drop scheme, lowercase, trim trailing slash/punctuation. */
function normalizeUrlForMatch(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[).,;!?'"\]]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Strip any URL from a reply body that does not appear verbatim in the studio knowledge doc.
 * Markdown links `[text](badurl)` collapse to their text; bare URLs are removed. Returns the
 * cleaned body plus the list of dropped URLs (for an assumptions note). If the doc is empty,
 * every URL is treated as unverified and stripped.
 */
function stripUnverifiedUrls(body: string, knowledge: string | null): { body: string; dropped: string[] } {
  const haystack = (knowledge ?? '').replace(/^https?:\/\//gim, '').toLowerCase()
  const dropped: string[] = []
  const isAllowed = (url: string): boolean => {
    const norm = normalizeUrlForMatch(url)
    return norm.length > 0 && haystack.includes(norm)
  }

  // Markdown links first: [text](url)
  let cleaned = body.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, text: string, url: string) => {
    if (isAllowed(url)) return `[${text}](${url})`
    dropped.push(url)
    return text
  })

  // Then any remaining bare URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s)>\]]+/gi, (url: string) => {
    if (isAllowed(url)) return url
    dropped.push(url)
    return ''
  })

  // Tidy whitespace left behind by removed bare URLs
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n')
  return { body: cleaned, dropped }
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(pty|ltd|llc|inc|co|limited|proprietary)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

// Generic words that don't distinguish one company from another — ignored when
// deciding whether a matched client name plausibly refers to the source's client.
const NAME_STOPWORDS = new Set([
  'pty', 'ltd', 'llc', 'inc', 'co', 'limited', 'proprietary', 'the', 'and',
  'group', 'holdings', 'australia', 'services', 'company', 'corporation', 'corp',
])

function significantTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w))
  )
}

/**
 * Whether a matched client's name plausibly refers to the same organisation named in the
 * source. Deliberately lenient (containment or any shared significant token passes) — its
 * job is only to catch a confidently-wrong match (e.g. source "Etex Australia" → "Simba
 * Industries"), not to adjudicate close calls. Returns true when it can't tell.
 */
function clientNamesRoughlyMatch(sourceName: string, matchedName: string): boolean {
  const a = normalizeName(sourceName)
  const b = normalizeName(matchedName)
  if (!a || !b) return true
  if (a === b || a.includes(b) || b.includes(a)) return true
  const ta = significantTokens(sourceName)
  const tb = significantTokens(matchedName)
  if (ta.size === 0 || tb.size === 0) return true
  for (const t of ta) if (tb.has(t)) return true
  return false
}

/**
 * Hard post-validation guards applied after zod parsing, regardless of provider.
 * Prompt instructions are advisory; these are enforcement. Mutations are pure —
 * a new object is returned and dropped/nulled data is recorded in `assumptions`.
 */
export function applyProposalGuards(input: AssistantResult, ctx: ProposalGuardContext): AssistantResult {
  const result: AssistantResult = JSON.parse(JSON.stringify(input))
  const note = (msg: string) => {
    result.assumptions.push(`[guard] ${msg}`)
  }

  const ownCompanySet = new Set(ctx.ownCompanyNames.map(normalizeName).filter(Boolean))
  const teamEmails = new Set(Array.from(ctx.teamEmails, (e) => e.trim().toLowerCase()))

  const guardRecipients = (recipients: RecipientProposal[], label: string): RecipientProposal[] =>
    recipients.filter((r) => {
      const email = r.email.trim().toLowerCase()
      if (!EMAIL_RE.test(email)) {
        note(`${label}: recipient "${r.name}" dropped — "${r.email}" is not a valid email.`)
        return false
      }
      if (teamEmails.has(email)) {
        note(`${label}: recipient "${r.name}" <${email}> dropped — that's one of our own team members.`)
        return false
      }
      r.email = email
      return true
    })

  const guardClient = (client: ClientMatch, label: string) => {
    if (client.matchedClientId && !ctx.validClientIds.has(client.matchedClientId)) {
      note(`${label}: matched client id "${client.matchedClientId}" is not a known client — cleared.`)
      client.matchedClientId = null
      client.matchConfidence = 'none'
    }
    // Reject a confidently-wrong match: the model picked a real client whose name bears no
    // resemblance to the organisation named in the source. Fall back to adding a new client.
    if (client.matchedClientId && client.sourceName) {
      const matchedName = ctx.clientNamesById.get(client.matchedClientId) ?? ''
      if (matchedName && !clientNamesRoughlyMatch(client.sourceName, matchedName)) {
        note(
          `${label}: the source names "${client.sourceName}" but the match was "${matchedName}" — that doesn't look like the same client, so it's set to add a new client instead. Pick an existing one if that's wrong.`
        )
        client.matchedClientId = null
        client.matchConfidence = 'none'
        if (!client.proposedNewClient) {
          client.proposedNewClient = {
            name: client.sourceName,
            address: null,
            phone: null,
            website: null,
            recipients: [],
          }
        }
      }
    }
    if (client.proposedNewClient) {
      if (ownCompanySet.has(normalizeName(client.proposedNewClient.name))) {
        note(
          `${label}: proposed new client "${client.proposedNewClient.name}" is our own company — cleared. Pick the real client manually.`
        )
        client.proposedNewClient = null
        client.matchConfidence = 'none'
      } else {
        client.proposedNewClient.recipients = guardRecipients(
          client.proposedNewClient.recipients,
          `${label} (new client)`
        )
      }
    }
  }

  if (result.project) {
    const p = result.project
    guardClient(p.client, 'Project')

    if (p.startDate && !ISO_DATE_RE.test(p.startDate)) {
      note(`Project: invalid start date "${p.startDate}" — cleared.`)
      p.startDate = null
    }

    p.recipients = guardRecipients(p.recipients, 'Project')

    p.keyDates = p.keyDates.filter((kd) => {
      if (!ISO_DATE_RE.test(kd.date)) {
        note(`Project: key date "${kd.type}" dropped — invalid date "${kd.date}".`)
        return false
      }
      return true
    })

    if (p.schedule) {
      if (!ISO_DATE_RE.test(p.schedule.anchorDate)) {
        note(`Project: schedule dropped — invalid anchor date "${p.schedule.anchorDate}".`)
        p.schedule = null
      } else {
        p.schedule.extraTasks = p.schedule.extraTasks.filter((t) => {
          if (!ISO_DATE_RE.test(t.startDate) || !ISO_DATE_RE.test(t.endDate)) {
            note(`Project: schedule task "${t.name}" dropped — invalid dates.`)
            return false
          }
          return true
        })
      }
    }
  }

  if (result.sales) {
    const s = result.sales
    guardClient(s.client, 'Sales')

    if (!ISO_DATE_RE.test(s.issueDate)) {
      note(`Sales: invalid issue date "${s.issueDate}" — replaced with today (${ctx.today}).`)
      s.issueDate = ctx.today
    }
    if (s.validUntil && !ISO_DATE_RE.test(s.validUntil)) {
      note(`Sales: invalid valid-until date "${s.validUntil}" — cleared.`)
      s.validUntil = null
    }
    if (s.dueDate && !ISO_DATE_RE.test(s.dueDate)) {
      note(`Sales: invalid due date "${s.dueDate}" — cleared.`)
      s.dueDate = null
    }

    s.items = s.items.filter((rawItem) => {
      const item = rawItem as ResolvedSalesLineItem
      if (!Number.isFinite(item.quantity)) {
        note(`Sales: line item "${item.description}" dropped — non-numeric quantity.`)
        return false
      }

      // Library items are authoritative: the model picks the item + quantity,
      // pricing/tax/label always come from the library row.
      if (item.libraryItemId) {
        const lib = ctx.libraryById.get(item.libraryItemId)
        if (!lib) {
          note(`Sales: line item "${item.description}" referenced unknown library item "${item.libraryItemId}" — treated as custom.`)
          item.libraryItemId = null
        } else {
          if (Math.trunc(item.unitPriceCents) !== lib.unitPriceCents) {
            note(`Sales: "${lib.description}" price corrected to the library rate.`)
          }
          item.description = item.description.trim() || lib.description
          if (!item.details && lib.details) item.details = lib.details
          item.unitPriceCents = lib.unitPriceCents
          item.taxRatePercent = lib.taxRatePercent
          item.taxRateName = lib.taxRateName
          item.labelId = lib.labelId
          item.labelName = lib.labelName
          item.labelColor = lib.labelColor
          return true
        }
      }

      if (!Number.isFinite(item.unitPriceCents)) {
        note(`Sales: line item "${item.description}" dropped — non-numeric price.`)
        return false
      }
      const cents = Math.trunc(item.unitPriceCents)
      if (cents < 0) {
        note(`Sales: line item "${item.description}" price was negative — set to 0.`)
      }
      item.unitPriceCents = Math.max(0, cents)
      if (!Number.isFinite(item.taxRatePercent) || item.taxRatePercent < 0 || item.taxRatePercent > 100) {
        note(`Sales: line item "${item.description}" tax rate "${item.taxRatePercent}" out of range — cleared to 0.`)
        item.taxRatePercent = 0
      }
      return true
    })
  }

  if (result.reply) {
    const resolved = result.reply as ResolvedReplyDraft

    // Portfolio links now live inline in the reply body (drawn from the freeform studio
    // knowledge doc), not the legacy structured id-list. Strip any URL the model produced
    // that does not appear verbatim in that doc — the anti-hallucination backstop.
    const { body, dropped } = stripUnverifiedUrls(result.reply.body, ctx.studioKnowledge)
    result.reply.body = body
    if (dropped.length > 0) {
      note(
        `Reply: removed ${dropped.length} link(s) not found in your studio knowledge (house-style) doc: ${dropped.join(', ')}. Add them there for the assistant to use.`
      )
    }

    // Legacy structured picks: resolved from the (now usually empty) portfolio-by-id map.
    const picks: ResolvedPortfolioPick[] = []
    for (const id of result.reply.portfolioItemIds) {
      const item = ctx.portfolioById.get(id)
      if (item) picks.push({ id: item.id, title: item.title, url: item.url })
    }
    resolved.portfolio = picks
    resolved.signature = ctx.replySignature
  }

  return result
}

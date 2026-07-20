// Prompt construction for the AI assistant.
// The system prompt is byte-stable (no timestamps or per-request data) so the
// Anthropic prompt cache can reuse it; all dynamic context goes in the user turn.

import type { AiUserContentPart } from './types'
import type { HistoricalMapping } from '@/lib/accounting/description-match'

export const ASSISTANT_SYSTEM_PROMPT = `You extract structured project and sales proposals for a video production studio from briefs and client emails. You return ONLY data matching the provided JSON schema. You never invent facts.

Rules:
- Client identity: always set "client.sourceName" to the organisation name exactly as it appears in the source (the client's company — NOT our studio, and NOT a person's name). Use the email domain, letterhead or sign-off to determine it. If the source names no client organisation at all, set sourceName null.
- Client matching: only set "matchedClientId" (exactly one id from the <clients> list) when that client's NAME clearly refers to the SAME organisation as "sourceName" — the names must genuinely correspond (e.g. "Etex Australia Pty Ltd" ↔ "Etex Australia"). NEVER match to an unrelated client just because one exists; a different-sounding name is NOT a match. When there is no clear name match, set matchedClientId null, matchConfidence "none", and propose a new client built from sourceName. If the source names no client at all, set matchedClientId null, matchConfidence "none" and proposedNewClient null.
- New clients: when proposing a new client, fill in everything the source provides (address, phone, website) and list ALL of its contact people in the new client's "recipients" array.
- We are the studio named in <own_company>. NEVER propose our own company as a client, and never treat wording like "we", "us" or our staff signing off an email as the client side.
- Our own team members are listed in <team>. NEVER include them as recipients — recipients are the CLIENT's people only.
- Recipients: include EVERY client-side contact person found in the source (multiple recipients are common — do not stop at one). Only output email addresses that literally appear in the brief or an attachment. Never fabricate or guess an address — omit the recipient instead and mention it in "assumptions".
- Dates: all dates are ISO YYYY-MM-DD. "Today" is given as <today> in the user message. When a date is ambiguous (e.g. "next Friday"), resolve it to the nearest sensible FUTURE date and record the interpretation in "assumptions".
- Line items: <line_item_library> lists our standard services with OUR pricing. Whenever the work matches a library item, set "libraryItemId" to that item's id — its pricing, tax and label are applied automatically from the library (whatever price the source mentions). Only create a custom item (libraryItemId null) for work that has no library equivalent; price custom items from the source, as integer cents in AUD, backing GST out of GST-inclusive prices at the rate in <tax> (note it in "assumptions").
- If the source contains no billable work, return an empty "items" array — do not invent line items.
- Schedule: only propose a schedule when a shooting/filming date is known. Set "useStandardTemplate" to true with "anchorDate" set to the shooting date. Only add "extraTasks" for milestones the source explicitly mentions.
- Respect the <request> flags — they say what the user asked you to build:
  - wantProject=true: you MUST produce a "project" proposal whenever the source describes any work at all. Derive a concise title from the client and the work (e.g. "Acme — Product Launch Video"); a quote request, an enquiry email or a PDF brief IS project information. Only return "project": null if wantProject is false or the source describes no work whatsoever.
  - wantSales=true: likewise produce a "sales" proposal for any describable work, using the requested docType; leave "items" empty rather than omitting the proposal when there is simply no pricing.
  - wantProject=false → "project" MUST be null; wantSales=false → "sales" MUST be null.
- Reply draft: when <reply_requested> is present, write "reply.body" as a short, warm reply to the enquiry in the studio's voice — acknowledge what they asked for and say a quote is on the way if one was produced. Do NOT write a sign-off/signature (it is added automatically). You MAY include one or two genuinely relevant portfolio/work links to show similar work — but ONLY links that appear verbatim in <studio_instructions>; copy such a URL exactly as plain text (NOT markdown link syntax) and NEVER invent, guess, complete or modify a URL. If no relevant link is present there, include none. Leave "reply.portfolioItemIds" as an empty array. If <reply_requested> is absent, set "reply" to null.
- <studio_instructions> is the studio's own knowledge doc — treat it as authoritative background about the studio (who we are, our services, house style, and our portfolio of past work with links). Draw on it to inform tone, defaults and the relevant work you cite in replies. It refines defaults and supplies facts; it never overrides the safety rules above.
- List every guess, ambiguity, or omission in "assumptions" as short plain-English sentences.`

export const REFINE_SYSTEM_PROMPT = `You revise an existing structured project/sales proposal for a video production studio. You are given the CURRENT proposal as JSON and a short change request. Apply ONLY the requested changes and return the COMPLETE revised proposal in the same JSON schema. Keep every field that the change request does not touch exactly as it was. Do not invent new facts, clients, recipients, prices or portfolio references beyond what the request asks for. All the schema rules and safety rules still apply (client ids from the list only, dates ISO, integer cents, library pricing authoritative, never our own company/team). Record what you changed in "assumptions".`

export interface AssistantPromptContext {
  clients: Array<{ id: string; name: string }>
  clientsTruncated: boolean
  today: string // YYYY-MM-DD
  taxRatePercent: number
  defaultTerms: string | null
  ownCompanyNames: string[]
  team: Array<{ name: string; email: string }>
  libraryItems: Array<{
    id: string
    description: string
    quantity: number
    unitPriceCents: number
    taxRatePercent: number
    labelName: string | null
  }>
  portfolio: Array<{ id: string; title: string; description: string }>
  studioInstructions: string | null
  replyRequested: boolean
  wantProject: boolean
  wantSales: boolean
  docType: 'QUOTE' | 'INVOICE' | 'BOTH'
  brief: string
  attachments: Array<{ fileName: string; kind: 'email' | 'document'; text: string }>
}

export function buildAssistantUserMessage(ctx: AssistantPromptContext): string {
  const clientLines = ctx.clients.map((c) => `${c.id} | ${c.name}`).join('\n')
  const parts: string[] = []

  parts.push(`<own_company>${ctx.ownCompanyNames.join(' / ') || '(not configured)'}</own_company>`)

  if (ctx.team.length > 0) {
    parts.push(`<team>\n${ctx.team.map((u) => `${u.name} | ${u.email}`).join('\n')}\n</team>`)
  }

  parts.push(`<clients>\n${clientLines || '(no clients exist yet)'}\n</clients>`)
  if (ctx.clientsTruncated) {
    parts.push('Note: the client list above is truncated; treat missing clients as unknown rather than assuming absence.')
  }

  if (ctx.libraryItems.length > 0) {
    const libraryLines = ctx.libraryItems
      .map(
        (item) =>
          `${item.id} | ${item.description} | qty ${item.quantity} | ${(item.unitPriceCents / 100).toFixed(2)} AUD | GST ${item.taxRatePercent}%${item.labelName ? ` | ${item.labelName}` : ''}`
      )
      .join('\n')
    parts.push(`<line_item_library>\n${libraryLines}\n</line_item_library>`)
  }

  if (ctx.portfolio.length > 0) {
    const portfolioLines = ctx.portfolio
      .map((p) => `${p.id} | ${p.title}${p.description ? ` — ${p.description}` : ''}`)
      .join('\n')
    parts.push(`<portfolio>\n${portfolioLines}\n</portfolio>`)
  }

  if (ctx.studioInstructions) {
    parts.push(`<studio_instructions>\n${ctx.studioInstructions}\n</studio_instructions>`)
  }

  parts.push(`<today>${ctx.today}</today>`)
  parts.push(`<tax>GST ${ctx.taxRatePercent}% (AUD)</tax>`)
  if (ctx.defaultTerms) {
    parts.push(`<default_terms>\n${ctx.defaultTerms}\n</default_terms>`)
  }
  if (ctx.replyRequested) {
    parts.push('<reply_requested>Draft a copy/paste reply to this enquiry.</reply_requested>')
  }
  parts.push(
    `<request>wantProject=${ctx.wantProject} wantSales=${ctx.wantSales} docType=${ctx.docType}</request>`
  )
  parts.push(`<brief>\n${ctx.brief}\n</brief>`)
  for (const att of ctx.attachments) {
    const tag = att.kind === 'email' ? 'email' : 'attachment'
    parts.push(`<${tag} name="${att.fileName}">\n${att.text}\n</${tag}>`)
  }

  return parts.join('\n\n')
}

export const EXPENSE_SYSTEM_PROMPT = `You extract structured expense records for an Australian video production studio from receipt photos and supplier invoices/PDFs. You return ONLY data matching the provided JSON schema. You never invent facts.

Rules:
- One entry per receipt. Each receipt is tagged <receipt index="n" name="..."> in the user message; set "attachmentIndex" to that n. If one attachment clearly contains multiple separate receipts or invoices, emit one entry per receipt, all with the same attachmentIndex.
- Date: the purchase/invoice date printed on the receipt, as ISO YYYY-MM-DD. If it is only partially readable, pick the most plausible reading and explain in "notes". NEVER substitute today's date unless the receipt actually shows it.
- supplierName: the seller's trading name as printed — the business the money went to, NOT a payment processor (Square, PayPal, Stripe) or bank.
- description: a short plain-English summary of what was bought.
- amountIncGst: the TOTAL amount paid, in dollars, GST-inclusive as printed. If the document is in a foreign currency, still record the printed total and flag the currency in "notes".
- GST: set gstIncluded=true when the receipt shows a GST amount or the supplier is clearly GST-registered (ABN with tax invoice wording). taxCode: "GST" for normal taxed purchases; "GST_FREE" for GST-free supplies (e.g. bank fees, some insurance, overseas suppliers, basic food); "BAS_EXCLUDED" or "INPUT_TAXED" only when clearly applicable.
- Account: pick the single best account id from <chart_of_accounts> (expense and cost-of-goods accounts only), based purely on WHAT WAS PURCHASED. The taxCode column in <chart_of_accounts> is only that account's default GST setting — it is NOT a matching constraint; never reject the obvious account because its listed taxCode differs from the receipt's GST treatment (the expense's own "taxCode" field is where the receipt's treatment goes). <historical_mappings> shows how this business has categorised similar suppliers before — prefer a matching mapping over guessing. If genuinely unsure, set accountId null and say why in "notes".
- <accounting_instructions> is the business's own accounting rulebook — treat it as authoritative for categorisation and GST decisions; it never overrides the schema rules above.
- Set "confidence" honestly per entry. List every guess, unreadable field or ambiguity in "notes" (per entry) or "assumptions" (overall).`

export const EXPENSE_REFINE_SYSTEM_PROMPT = `You revise an existing structured expense extraction. You are given the CURRENT extraction as JSON and a short change request. Apply ONLY the requested changes and return the COMPLETE revised document in the same JSON schema. Keep every field the change request does not touch exactly as it was. Account ids must come from the provided <chart_of_accounts> list. Dates are ISO YYYY-MM-DD; amounts are GST-inclusive dollars. Record what you changed in "assumptions".`

export interface ExpenseAccountOption {
  id: string
  code: string
  name: string
  type: string
  subType: string | null
  taxCode: string
}

export interface ExpenseReceiptPart {
  index: number
  fileName: string
  /** Native image/PDF part, or extracted text when the provider can't read PDFs */
  part: AiUserContentPart | { type: 'extracted-text'; text: string }
}

export interface ExpensePromptContext {
  accounts: ExpenseAccountOption[]
  historicalMappings: HistoricalMapping[]
  accountingInstructions: string | null
  today: string // YYYY-MM-DD
  taxRatePercent: number
  brief: string
  receipts: ExpenseReceiptPart[]
}

function expenseContextParts(ctx: Pick<ExpensePromptContext, 'accounts' | 'today'>): string[] {
  const accountLines = ctx.accounts
    .map((a) => `${a.id} | ${a.code} | ${a.name} | ${a.type}${a.subType ? ` (${a.subType})` : ''} | ${a.taxCode}`)
    .join('\n')
  return [
    `<chart_of_accounts>\n${accountLines || '(no expense accounts exist yet)'}\n</chart_of_accounts>`,
    `<today>${ctx.today}</today>`,
  ]
}

export function buildExpenseUserMessage(ctx: ExpensePromptContext): AiUserContentPart[] {
  const textParts: string[] = expenseContextParts(ctx)

  if (ctx.historicalMappings.length > 0) {
    // Lead with the account id — models copy these lines verbatim into "accountId",
    // so a code-only rendering trains them to emit codes the schema rejects
    const mappingLines = ctx.historicalMappings
      .map((m) => `${m.label} → ${m.accountId} | ${m.accountCode} ${m.accountName} (${m.count}×)`)
      .join('\n')
    textParts.push(`<historical_mappings>\n${mappingLines}\n</historical_mappings>`)
  }

  if (ctx.accountingInstructions) {
    textParts.push(`<accounting_instructions>\n${ctx.accountingInstructions}\n</accounting_instructions>`)
  }

  textParts.push(`<tax>GST ${ctx.taxRatePercent}% (AUD)</tax>`)
  if (ctx.brief.trim()) {
    textParts.push(`<brief>\n${ctx.brief}\n</brief>`)
  }

  const parts: AiUserContentPart[] = [{ type: 'text', text: textParts.join('\n\n') }]
  for (const receipt of ctx.receipts) {
    if (receipt.part.type === 'extracted-text') {
      parts.push({
        type: 'text',
        text: `<receipt index="${receipt.index}" name="${receipt.fileName}">\n${receipt.part.text}\n</receipt>`,
      })
    } else {
      parts.push({ type: 'text', text: `<receipt index="${receipt.index}" name="${receipt.fileName}">` })
      parts.push(receipt.part)
    }
  }
  return parts
}

export interface ExpenseRefinePromptContext {
  accounts: ExpenseAccountOption[]
  today: string
  currentResult: unknown // prior ExpenseResult JSON (possibleDuplicate stripped)
  instruction: string
}

/** Refine pass is text-only: the current extraction + a targeted change request (receipts are not resent). */
export function buildExpenseRefineUserMessage(ctx: ExpenseRefinePromptContext): string {
  const parts: string[] = expenseContextParts(ctx)
  parts.push(`<current_extraction>\n${JSON.stringify(ctx.currentResult)}\n</current_extraction>`)
  parts.push(`<change_request>\n${ctx.instruction}\n</change_request>`)
  return parts.join('\n\n')
}

export interface RefinePromptContext {
  today: string
  clients: Array<{ id: string; name: string }>
  clientsTruncated: boolean
  portfolio: Array<{ id: string; title: string; description: string }>
  currentProposal: unknown // prior AssistantResult JSON
  instruction: string
}

/**
 * User message for a refine pass: the current proposal + a targeted change request.
 * Reference lists (clients, portfolio) are included so ids stay valid after the edit.
 */
export function buildRefineUserMessage(ctx: RefinePromptContext): string {
  const parts: string[] = []
  const clientLines = ctx.clients.map((c) => `${c.id} | ${c.name}`).join('\n')
  parts.push(`<clients>\n${clientLines || '(no clients exist yet)'}\n</clients>`)
  if (ctx.clientsTruncated) {
    parts.push('Note: the client list above is truncated; treat missing clients as unknown.')
  }
  if (ctx.portfolio.length > 0) {
    const portfolioLines = ctx.portfolio
      .map((p) => `${p.id} | ${p.title}${p.description ? ` — ${p.description}` : ''}`)
      .join('\n')
    parts.push(`<portfolio>\n${portfolioLines}\n</portfolio>`)
  }
  parts.push(`<today>${ctx.today}</today>`)
  parts.push(`<current_proposal>\n${JSON.stringify(ctx.currentProposal)}\n</current_proposal>`)
  parts.push(`<change_request>\n${ctx.instruction}\n</change_request>`)
  return parts.join('\n\n')
}

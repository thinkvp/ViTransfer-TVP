import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'
import {
  calcLineSubtotalCents,
  calcLineTaxCents,
  centsToDollars,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'

export type PdfPartyInfo = {
  clientName?: string
  clientAddress?: string
  projectTitle?: string
  publicQuoteUrl?: string
}

function wrapUrl(url: string, maxWidth: number, font: any, size: number): string[] {
  const text = String(url ?? '').trim()
  if (!text) return []
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return [text]

  const out: string[] = []
  let remaining = text
  const preferredBreakChars = new Set(['/','?','&','=','-','_'])

  while (remaining.length) {
    let best = ''
    let bestIdx = 0

    for (let i = 1; i <= remaining.length; i++) {
      const candidate = remaining.slice(0, i)
      if (font.widthOfTextAtSize(candidate, size) > maxWidth) break
      best = candidate
      bestIdx = i
    }

    if (!best) {
      best = remaining.slice(0, 1)
      bestIdx = 1
    }

    // Prefer breaking at a delimiter within the best span.
    let breakIdx = bestIdx
    for (let i = bestIdx - 1; i > 0; i--) {
      if (preferredBreakChars.has(remaining[i - 1])) {
        breakIdx = i
        break
      }
    }

    const line = remaining.slice(0, breakIdx)
    out.push(line)
    remaining = remaining.slice(breakIdx)
  }

  return out
}

type EmbeddedLogo = {
  width: number
  height: number
  drawWidth: number
  drawHeight: number
  drawX: number
  drawY: number
  kind: 'png' | 'jpg'
  image: any
}

function wrapText(text: string, maxWidth: number, font: any, size: number): string[] {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  if (!normalized.trim()) return []

  const paragraphs = normalized.split('\n')
  const out: string[] = []

  for (const paraRaw of paragraphs) {
    const para = paraRaw.trim()
    if (!para) {
      out.push('')
      continue
    }

    const words = para.split(/\s+/g).filter(Boolean)
    let line = ''

    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      const w = font.widthOfTextAtSize(next, size)
      if (w <= maxWidth) {
        line = next
        continue
      }

      if (line) out.push(line)
      line = word
    }

    if (line) out.push(line)
  }

  // Trim trailing blank lines
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

function drawRightText(page: any, text: string, xRight: number, y: number, size: number, font: any, color: any) {
  const w = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: xRight - w, y, size, font, color })
}

function detectImageKind(contentType: string | null, bytes: Uint8Array): 'png' | 'jpg' | null {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'

  // Magic bytes fallback
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png'
    }
  }
  if (bytes.length >= 2) {
    // JPEG: FF D8
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  }
  return null
}

async function tryEmbedCompanyLogo(doc: any, opts?: { baseUrl?: string }): Promise<EmbeddedLogo | null> {
  try {
    const baseUrl = typeof opts?.baseUrl === 'string' ? opts.baseUrl.trim() : ''
    const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/branding/logo` : '/api/branding/logo'
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null

    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!bytes.length) return null

    const kind = detectImageKind(res.headers.get('content-type'), bytes)
    if (!kind) return null

    const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
    const dims = image.scale(1)

    const drawHeight = 42
    const scale = drawHeight / dims.height
    const drawWidth = dims.width * scale

    return {
      width: dims.width,
      height: dims.height,
      drawWidth,
      drawHeight,
      drawX: 50,
      drawY: 800 - drawHeight + 6,
      kind,
      image,
    }
  } catch {
    return null
  }
}

async function buildQuotePdfBytes(
  quote: SalesQuote,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  const { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, rgb } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  let page = doc.addPage([595.28, 841.89]) // A4
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const topY = 800
  const bottomMargin = 60
  let y = topY
  const left = 50
  const right = 545
  const textColor = rgb(0.1, 0.1, 0.1)
  const subtleText = rgb(0.15, 0.15, 0.15)
  const lineColor = rgb(0.85, 0.85, 0.85)
  const headerBg = rgb(0.22, 0.22, 0.24)
  const white = rgb(1, 1, 1)

  const logo = await tryEmbedCompanyLogo(doc, opts)

  const drawLeftText = (text: string, x: number, yPos: number, size: number, bold = false, color = textColor) => {
    page.drawText(text, { x, y: yPos, size, font: bold ? fontBold : font, color })
  }

  const drawLeftBlock = (lines: Array<{ text: string; size: number; bold?: boolean; color?: any }>, x: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawLeftText(l.text, x, yy, l.size, Boolean(l.bold), l.color ?? textColor)
      yy -= l.size + 5
    }
    return yy
  }

  const drawRightBlock = (lines: Array<{ text: string; size: number; bold?: boolean; color?: any }>, xRight: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawRightText(page, l.text, xRight, yy, l.size, l.bold ? fontBold : font, l.color ?? textColor)
      yy -= l.size + 5
    }
    return yy
  }

  const addLinkAnnotation = (x: number, y: number, width: number, height: number, url: string) => {
    try {
      const link = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x, y, x + width, y + height],
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'URI',
          URI: PDFString.of(url),
        },
      })
      const linkRef = doc.context.register(link)
      const annotsKey = PDFName.of('Annots')
      const annots = page.node.lookup(annotsKey, PDFArray)
      if (annots) {
        annots.push(linkRef)
      } else {
        page.node.set(annotsKey, doc.context.obj([linkRef]))
      }
    } catch {
      // ignore
    }
  }

  const drawDocTitle = () => {
    page.drawText('QUOTE', { x: right - 82, y: 800, size: 20, font: fontBold, color: textColor })
  }

  const drawContinuationHeader = () => {
    page.drawText(settings.businessName || 'Business', { x: left, y: 805, size: 12, font: fontBold, color: textColor })
    drawRightText(page, `Quote #: ${quote.quoteNumber}`, right, 805, 12, fontBold, textColor)
    page.drawLine({ start: { x: left, y: 792 }, end: { x: right, y: 792 }, thickness: 1, color: lineColor })
  }

  // Table layout
  const colItemX = left
  const colItemW = 260
  const colQtyW = 40
  const colRateW = 70
  const colTaxW = 45
  const colAmountW = (right - left) - colItemW - colQtyW - colRateW - colTaxW

  const itemRight = colItemX + colItemW
  const qtyRightEdge = itemRight + colQtyW
  const rateRightEdge = qtyRightEdge + colRateW
  const taxRightEdge = rateRightEdge + colTaxW
  const amountRightEdge = taxRightEdge + colAmountW

  const qtyRight = qtyRightEdge - 4
  const rateRight = rateRightEdge - 4
  const taxRight = taxRightEdge - 4
  const colAmountRight = amountRightEdge - 4

  const drawTableHeader = (yTop: number): number => {
    const headerHeight = 18
    page.drawRectangle({ x: left, y: yTop - headerHeight, width: right - left, height: headerHeight, color: headerBg })
    const headerTextY = yTop - 13
    page.drawText('Item', { x: colItemX, y: headerTextY, size: 10, font: fontBold, color: white })
    drawRightText(page, 'Qty', qtyRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Rate', rateRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Tax', taxRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Amount', colAmountRight, headerTextY, 10, fontBold, white)
    return yTop - headerHeight - 10
  }

  const newPage = (withTableHeader = false) => {
    page = doc.addPage([595.28, 841.89])
    y = topY
    drawDocTitle()
    drawContinuationHeader()
    y = 770
    if (withTableHeader) {
      y = drawTableHeader(y)
    }
  }

  drawDocTitle()

  if (logo) {
    page.drawImage(logo.image, {
      x: logo.drawX,
      y: logo.drawY,
      width: logo.drawWidth,
      height: logo.drawHeight,
    })
  }

  const headerTopY = 795
  const companyStartY = logo ? headerTopY - logo.drawHeight - 10 : headerTopY
  const headerRowStartY = companyStartY

  const companyLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
  companyLines.push({ text: settings.businessName || 'Business', size: 13, bold: true })
  if (settings.abn) companyLines.push({ text: `ABN: ${settings.abn}`, size: 10 })
  if (settings.address) {
    for (const line of settings.address.split('\n')) {
      if (line.trim()) companyLines.push({ text: line.trim(), size: 10 })
    }
  }
  if (settings.phone) companyLines.push({ text: `Phone: ${settings.phone}`, size: 10 })
  if (settings.email) companyLines.push({ text: `Email: ${settings.email}`, size: 10 })
  if (settings.website) companyLines.push({ text: `Web: ${settings.website}`, size: 10 })

  const metaLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
  metaLines.push({ text: `Quote #: ${quote.quoteNumber}`, size: 11, bold: true })
  metaLines.push({ text: `Issue date: ${quote.issueDate}`, size: 10 })
  if (quote.validUntil) metaLines.push({ text: `Valid until: ${quote.validUntil}`, size: 10 })

  const afterCompanyY = drawLeftBlock(companyLines, left, headerRowStartY)
  const afterMetaY = drawRightBlock(metaLines, right, headerRowStartY)
  y = Math.min(afterCompanyY, afterMetaY) - 14

  if (info.clientName || info.clientAddress || info.projectTitle) {
    const billToLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
    billToLines.push({ text: 'Bill To', size: 9, bold: true, color: subtleText })
    if (info.clientName) billToLines.push({ text: info.clientName, size: 11, bold: true })
    if (info.clientAddress) {
      for (const rawLine of info.clientAddress.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        for (const wrapped of wrapText(line, 280, font, 10)) {
          if (wrapped.trim()) billToLines.push({ text: wrapped, size: 10, color: subtleText })
        }
      }
    }
    if (info.projectTitle) billToLines.push({ text: `Project: ${info.projectTitle}`, size: 9, color: subtleText })
    y = drawLeftBlock(billToLines, left, y) - 12
  }

  y = drawTableHeader(y)

  const itemMaxWidth = colItemW - 8

  for (const item of quote.items) {
    const amount = calcLineSubtotalCents(item)
    const taxRate = item.taxRatePercent ?? settings.taxRatePercent
    const itemName = item.description || '—'
    const details = (item as any).details
    const itemLines = wrapText(itemName, itemMaxWidth, fontBold, 10)
    const detailLines = details ? wrapText(details, itemMaxWidth, font, 9) : []
    const lines = [...itemLines, ...detailLines]
    const rowHeight = Math.max(16, lines.length * 11 + 6)

    if (y - rowHeight < bottomMargin) {
      newPage(true)
    }

    const rowTopY = y
    const textY = rowTopY - 12
    let yy = textY

    for (let i = 0; i < itemLines.length; i++) {
      page.drawText(itemLines[i], { x: colItemX + 4, y: yy, size: 10, font: fontBold, color: textColor })
      yy -= 11
    }
    for (let i = 0; i < detailLines.length; i++) {
      page.drawText(detailLines[i], { x: colItemX + 4, y: yy, size: 9, font, color: subtleText })
      yy -= 11
    }

    drawRightText(page, String(item.quantity ?? 1), qtyRight, textY, 10, font, textColor)
    drawRightText(page, centsToDollars(item.unitPriceCents ?? 0), rateRight, textY, 10, font, textColor)
    drawRightText(page, `${Number(taxRate)}%`, taxRight, textY, 10, font, textColor)
    drawRightText(page, centsToDollars(amount), colAmountRight, textY, 10, fontBold, textColor)

    y -= rowHeight
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: lineColor })
    y -= 6
  }

  // Totals
  const subtotalCents = sumLineItemsSubtotal(quote.items)
  const taxCents = sumLineItemsTax(quote.items, settings.taxRatePercent)
  const totalCents = subtotalCents + taxCents

  const totalsXRight = right
  const totalsLabelXRight = totalsXRight - 120

  const drawTotalsLine = (label: string, value: string, bold = false) => {
    drawRightText(page, label, totalsLabelXRight, y, 10, font, subtleText)
    drawRightText(page, value, totalsXRight, y, 10, bold ? fontBold : font, textColor)
    y -= 14
  }

  if (y - 80 < bottomMargin) newPage(false)
  y -= 8
  drawTotalsLine('Subtotal', centsToDollars(subtotalCents))
  drawTotalsLine('Tax', centsToDollars(taxCents))
  drawTotalsLine('Total', centsToDollars(totalCents), true)

  // Optional accept link
  if (info.publicQuoteUrl) {
    if (y - 70 < bottomMargin) newPage(false)
    y -= 10
    drawLeftText('Accept this quote online', left, y, 10, true, textColor)
    y -= 18

    const buttonText = 'Accept Quote'
    const buttonFontSize = 12
    const padX = 14
    const padY = 8
    const textW = fontBold.widthOfTextAtSize(buttonText, buttonFontSize)
    const buttonW = Math.min(right - left, textW + padX * 2)
    const buttonH = buttonFontSize + padY * 2
    const buttonX = left
    const buttonY = y - buttonH

    page.drawRectangle({
      x: buttonX,
      y: buttonY,
      width: buttonW,
      height: buttonH,
      color: rgb(0.92, 0.96, 1.0),
      borderColor: rgb(0.25, 0.45, 0.85),
      borderWidth: 1,
    })
    page.drawText(buttonText, {
      x: buttonX + padX,
      y: buttonY + padY,
      size: buttonFontSize,
      font: fontBold,
      color: rgb(0.1, 0.25, 0.55),
    })
    addLinkAnnotation(buttonX, buttonY, buttonW, buttonH, info.publicQuoteUrl)
    y = buttonY - 14
  }

  // Notes (full width)
  if (quote.notes?.trim()) {
    y -= 10
    const notesLines = wrapText(quote.notes, right - left, font, 10)
    if (y - 30 < bottomMargin) newPage(false)
    drawLeftText('Notes', left, y, 11, true)
    y -= 16
    for (const line of notesLines) {
      if (y < bottomMargin) newPage(false)
      if (!line.trim()) {
        y -= 10
        continue
      }
      drawLeftText(line, left, y, 10, false, subtleText)
      y -= 12
    }
  }

  // Terms & conditions (full width, final section)
  y -= 28
  if (quote.terms?.trim()) {
    const termsLines = wrapText(quote.terms, right - left, font, 10)

    const drawTermsHeader = (continued: boolean) => {
      const title = continued ? 'Terms & conditions (cont.)' : 'Terms & conditions'
      drawLeftText(title, left, y, 11, true)
      y -= 16
    }

    if (y - 40 < bottomMargin) newPage(false)
    drawTermsHeader(false)

    let continued = false
    for (const line of termsLines) {
      if (y < bottomMargin) {
        newPage(false)
        continued = true
        drawTermsHeader(continued)
      }
      if (!line.trim()) {
        y -= 10
        continue
      }
      drawLeftText(line, left, y, 10, false, subtleText)
      y -= 12
    }
  }

  addPageNumbers(doc, font, rgb(0.45, 0.45, 0.45))
  const bytes = await doc.save()
  return bytes
}
 
function downloadBytes(filename: string, bytes: Uint8Array) {
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function addPageNumbers(doc: any, font: any, color: any) {
  const pages = doc.getPages()
  const total = pages.length
  pages.forEach((p: any, idx: number) => {
    const label = `Page ${idx + 1} of ${total}`
    const size = 9
    const marginX = 50
    const y = 28
    const xRight = (typeof p.getWidth === 'function' ? p.getWidth() : 595.28) - marginX
    drawRightText(p, label, xRight, y, size, font, color)
  })
}

export async function downloadQuotePdf(
  quote: SalesQuote,
  settings: SalesSettings,
  info: PdfPartyInfo = {}
): Promise<void> {
  const bytes = await buildQuotePdfBytes(quote, settings, info)
  downloadBytes(`${quote.quoteNumber}.pdf`, bytes)
}

export async function renderQuotePdfBytes(
  quote: SalesQuote,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  return buildQuotePdfBytes(quote, settings, info, opts)
}

async function buildInvoicePdfBytes(
  invoice: SalesInvoice,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  let page = doc.addPage([595.28, 841.89]) // A4
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const topY = 800
  const bottomMargin = 60
  let y = topY
  const left = 50
  const right = 545
  const textColor = rgb(0.1, 0.1, 0.1)
  const subtleText = rgb(0.15, 0.15, 0.15)
  const lineColor = rgb(0.85, 0.85, 0.85)
  const headerBg = rgb(0.22, 0.22, 0.24)
  const white = rgb(1, 1, 1)

  const logo = await tryEmbedCompanyLogo(doc, opts)

  const drawLeftText = (text: string, x: number, yPos: number, size: number, bold = false, color = textColor) => {
    page.drawText(text, { x, y: yPos, size, font: bold ? fontBold : font, color })
  }

  const drawLeftBlock = (lines: Array<{ text: string; size: number; bold?: boolean; color?: any }>, x: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawLeftText(l.text, x, yy, l.size, Boolean(l.bold), l.color ?? textColor)
      yy -= l.size + 5
    }
    return yy
  }

  const drawRightBlock = (lines: Array<{ text: string; size: number; bold?: boolean; color?: any }>, xRight: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawRightText(page, l.text, xRight, yy, l.size, l.bold ? fontBold : font, l.color ?? textColor)
      yy -= l.size + 5
    }
    return yy
  }

  const drawDocTitle = () => {
    page.drawText('INVOICE', { x: right - 95, y: 800, size: 20, font: fontBold, color: textColor })
  }

  const drawContinuationHeader = () => {
    page.drawText(settings.businessName || 'Business', { x: left, y: 805, size: 12, font: fontBold, color: textColor })
    drawRightText(page, `Invoice #: ${invoice.invoiceNumber}`, right, 805, 12, fontBold, textColor)
    page.drawLine({ start: { x: left, y: 792 }, end: { x: right, y: 792 }, thickness: 1, color: lineColor })
  }

  // Table layout
  const colItemX = left
  const colItemW = 260
  const colQtyW = 40
  const colRateW = 70
  const colTaxW = 45
  const colAmountW = (right - left) - colItemW - colQtyW - colRateW - colTaxW

  const itemRight = colItemX + colItemW
  const qtyRightEdge = itemRight + colQtyW
  const rateRightEdge = qtyRightEdge + colRateW
  const taxRightEdge = rateRightEdge + colTaxW
  const amountRightEdge = taxRightEdge + colAmountW

  const qtyRight = qtyRightEdge - 4
  const rateRight = rateRightEdge - 4
  const taxRight = taxRightEdge - 4
  const colAmountRight = amountRightEdge - 4

  const drawTableHeader = (yTop: number): number => {
    const headerHeight = 18
    page.drawRectangle({ x: left, y: yTop - headerHeight, width: right - left, height: headerHeight, color: headerBg })
    const headerTextY = yTop - 13
    page.drawText('Item', { x: colItemX, y: headerTextY, size: 10, font: fontBold, color: white })
    drawRightText(page, 'Qty', qtyRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Rate', rateRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Tax', taxRight, headerTextY, 10, fontBold, white)
    drawRightText(page, 'Amount', colAmountRight, headerTextY, 10, fontBold, white)
    return yTop - headerHeight - 10
  }

  const newPage = (withTableHeader = false) => {
    page = doc.addPage([595.28, 841.89])
    y = topY
    drawDocTitle()
    drawContinuationHeader()
    y = 770
    if (withTableHeader) {
      y = drawTableHeader(y)
    }
  }

  drawDocTitle()

  if (logo) {
    page.drawImage(logo.image, {
      x: logo.drawX,
      y: logo.drawY,
      width: logo.drawWidth,
      height: logo.drawHeight,
    })
  }

  const headerTopY = 795
  const companyStartY = logo ? headerTopY - logo.drawHeight - 10 : headerTopY
  const headerRowStartY = companyStartY

  const companyLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
  companyLines.push({ text: settings.businessName || 'Business', size: 13, bold: true })
  if (settings.abn) companyLines.push({ text: `ABN: ${settings.abn}`, size: 10 })
  if (settings.address) {
    for (const line of settings.address.split('\n')) {
      if (line.trim()) companyLines.push({ text: line.trim(), size: 10 })
    }
  }
  if (settings.phone) companyLines.push({ text: `Phone: ${settings.phone}`, size: 10 })
  if (settings.email) companyLines.push({ text: `Email: ${settings.email}`, size: 10 })
  if (settings.website) companyLines.push({ text: `Web: ${settings.website}`, size: 10 })

  const metaLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
  metaLines.push({ text: `Invoice #: ${invoice.invoiceNumber}`, size: 11, bold: true })
  metaLines.push({ text: `Issue date: ${invoice.issueDate}`, size: 10 })
  if (invoice.dueDate) metaLines.push({ text: `Due date: ${invoice.dueDate}`, size: 10 })

  const afterCompanyY = drawLeftBlock(companyLines, left, headerRowStartY)
  const afterMetaY = drawRightBlock(metaLines, right, headerRowStartY)
  y = Math.min(afterCompanyY, afterMetaY) - 14

  if (info.clientName || info.clientAddress || info.projectTitle) {
    const billToLines: Array<{ text: string; size: number; bold?: boolean; color?: any }> = []
    billToLines.push({ text: 'Bill To', size: 9, bold: true, color: subtleText })
    if (info.clientName) billToLines.push({ text: info.clientName, size: 11, bold: true })
    if (info.clientAddress) {
      for (const rawLine of info.clientAddress.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        for (const wrapped of wrapText(line, 280, font, 10)) {
          if (wrapped.trim()) billToLines.push({ text: wrapped, size: 10, color: subtleText })
        }
      }
    }
    if (info.projectTitle) billToLines.push({ text: `Project: ${info.projectTitle}`, size: 9, color: subtleText })
    y = drawLeftBlock(billToLines, left, y) - 12
  }

  y = drawTableHeader(y)

  const itemMaxWidth = colItemW - 8

  for (const item of invoice.items) {
    const amount = calcLineSubtotalCents(item)
    const taxRate = item.taxRatePercent ?? settings.taxRatePercent
    const itemName = item.description || '—'
    const details = (item as any).details

    const itemLines = wrapText(itemName, itemMaxWidth, fontBold, 10)
    const detailLines = details ? wrapText(details, itemMaxWidth, font, 9) : []
    const lines = [...itemLines, ...detailLines]
    const rowHeight = Math.max(16, lines.length * 11 + 6)

    if (y - rowHeight < bottomMargin) {
      newPage(true)
    }

    const rowTopY = y
    const textY = rowTopY - 12
    let yy = textY

    for (let i = 0; i < itemLines.length; i++) {
      page.drawText(itemLines[i], { x: colItemX + 4, y: yy, size: 10, font: fontBold, color: textColor })
      yy -= 11
    }

    for (let i = 0; i < detailLines.length; i++) {
      page.drawText(detailLines[i], { x: colItemX + 4, y: yy, size: 9, font, color: subtleText })
      yy -= 11
    }

    drawRightText(page, String(item.quantity ?? 1), qtyRight, textY, 10, font, textColor)
    drawRightText(page, centsToDollars(item.unitPriceCents ?? 0), rateRight, textY, 10, font, textColor)
    drawRightText(page, `${Number(taxRate)}%`, taxRight, textY, 10, font, textColor)
    drawRightText(page, centsToDollars(amount), colAmountRight, textY, 10, fontBold, textColor)

    y -= rowHeight

    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: lineColor })

    y -= 6
  }

  // Totals
  const subtotalCents = sumLineItemsSubtotal(invoice.items)
  const taxCents = sumLineItemsTax(invoice.items, settings.taxRatePercent)
  const totalCents = subtotalCents + taxCents

  const totalsXRight = right
  const totalsLabelXRight = totalsXRight - 120

  const drawTotalsLine = (label: string, value: string, bold = false) => {
    drawRightText(page, label, totalsLabelXRight, y, 10, font, subtleText)
    drawRightText(page, value, totalsXRight, y, 10, bold ? fontBold : font, textColor)
    y -= 14
  }

  if (y - 80 < bottomMargin) newPage(false)

  y -= 8
  drawTotalsLine('Subtotal', centsToDollars(subtotalCents))
  drawTotalsLine('Tax', centsToDollars(taxCents))
  drawTotalsLine('Total', centsToDollars(totalCents), true)

  // Notes
  if (invoice.notes?.trim()) {
    y -= 10
    const notesLines = wrapText(invoice.notes, right - left, font, 10)
    if (y - 30 < bottomMargin) newPage(false)

    drawLeftText('Notes', left, y, 11, true)
    y -= 16
    for (const line of notesLines) {
      if (y < bottomMargin) newPage(false)
      if (!line.trim()) {
        y -= 10
        continue
      }
      drawLeftText(line, left, y, 10, false, subtleText)
      y -= 12
    }
  }

  // Terms & conditions
  y -= 28
  if (invoice.terms?.trim()) {
    const termsLines = wrapText(invoice.terms, right - left, font, 10)

    const drawTermsHeader = (continued: boolean) => {
      const title = continued ? 'Terms & conditions (cont.)' : 'Terms & conditions'
      drawLeftText(title, left, y, 11, true)
      y -= 16
    }

    if (y - 40 < bottomMargin) newPage(false)
    drawTermsHeader(false)

    let continued = false
    for (const line of termsLines) {
      if (y < bottomMargin) {
        newPage(false)
        continued = true
        drawTermsHeader(continued)
      }
      if (!line.trim()) {
        y -= 10
        continue
      }
      drawLeftText(line, left, y, 10, false, subtleText)
      y -= 12
    }
  }

  addPageNumbers(doc, font, rgb(0.45, 0.45, 0.45))
  const bytes = await doc.save()
  return bytes
}

export async function downloadInvoicePdf(
  invoice: SalesInvoice,
  settings: SalesSettings,
  info: PdfPartyInfo = {}
): Promise<void> {
  const bytes = await buildInvoicePdfBytes(invoice, settings, info)
  downloadBytes(`${invoice.invoiceNumber}.pdf`, bytes)
}

export async function renderInvoicePdfBytes(
  invoice: SalesInvoice,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  return buildInvoicePdfBytes(invoice, settings, info, opts)
}

import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'
import {
  calcLineSubtotalCents,
  centsToDollars,
  formatMoney,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'
import { formatDate } from '@/lib/utils'
import { getCurrencySymbol } from '@/lib/sales/currency'

export type PdfPartyInfo = {
  clientName?: string
  clientAddress?: string
  projectTitle?: string
  stripeProcessingFeeCents?: number
  stripeProcessingFeeCurrency?: string
  publicQuoteUrl?: string
  publicInvoiceUrl?: string
  /** Total of all counted payments against an invoice (local + Stripe), in cents. */
  amountPaidCents?: number
}

type BlockLine = { text: string; size: number; bold?: boolean; color?: any }

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
    const isBrowser = typeof window !== 'undefined'

    const candidates: string[] = []
    if (baseUrl) candidates.push(`${baseUrl.replace(/\/$/, '')}/api/branding/logo`)
    if (isBrowser) {
      candidates.push('/api/branding/logo')
    } else {
      // Container-friendly fallbacks (avoid external TLS/proxy issues).
      candidates.push('http://localhost:4321/api/branding/logo')
      candidates.push('http://127.0.0.1:4321/api/branding/logo')

      // Last resort: if NEXT_PUBLIC_APP_URL is set to a valid absolute URL, try it.
      const envUrl = typeof process.env.NEXT_PUBLIC_APP_URL === 'string' ? process.env.NEXT_PUBLIC_APP_URL.trim() : ''
      if (envUrl && /^(https?:)\/\//i.test(envUrl)) {
        try {
          const origin = new URL(envUrl).origin
          candidates.push(`${origin}/api/branding/logo`)
        } catch {
          // ignore
        }
      }
    }

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          headers: {
            Accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
          },
        })
        if (!res.ok) continue

        const bytes = new Uint8Array(await res.arrayBuffer())
        if (!bytes.length) continue

        const kind = detectImageKind(res.headers.get('content-type'), bytes)
        if (!kind) continue

        const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
        const dims = image.scale(1)

        const drawHeight = 46
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
        // ignore and try next candidate
      }
    }

    return null
  } catch {
    return null
  }
}

function addPageNumbers(doc: any, font: any, color: any, opts?: { leftLabel?: string; leftColor?: any }) {
  const pages = doc.getPages()
  const total = pages.length
  pages.forEach((p: any, idx: number) => {
    const label = `Page ${idx + 1} of ${total}`
    const size = 9
    const marginX = 50
    const y = 28

    const leftLabel = String(opts?.leftLabel ?? '').trim()
    if (leftLabel) {
      p.drawText(leftLabel, { x: marginX, y, size, font, color: opts?.leftColor ?? color })
    }

    const xRight = (typeof p.getWidth === 'function' ? p.getWidth() : 595.28) - marginX
    drawRightText(p, label, xRight, y, size, font, color)
  })
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

type SalesDocKind = 'quote' | 'invoice'

type SalesDocDescriptor = {
  kind: SalesDocKind
  /** Document number, e.g. "INV-2026-031". */
  number: string
  /** Big masthead title, e.g. "INVOICE" / "QUOTE". */
  titleLabel: string
  /** Meta label for the number row, e.g. "Invoice #" / "Quote #". */
  numberLabel: string
  /** Right-hand meta date rows (issue date, due/valid-until date). */
  dateRows: Array<{ label: string; value: string }>
  taxEnabled: boolean
  items: SalesQuote['items']
  notes: string
  terms: string
  /** Public accept/pay URL, when available. */
  publicUrl?: string
  /** Footer left label, e.g. "Invoice: INV-2026-031". */
  pageLeftLabel: string
}

/**
 * Shared renderer for both quotes and invoices. The two documents are visually
 * identical apart from their labels, the meta date rows, and the call-to-action
 * section at the foot (accept-quote vs. pay-invoice + payment details).
 */
async function buildSalesDocPdfBytes(
  descriptor: SalesDocDescriptor,
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
  const textColor = rgb(0.13, 0.14, 0.17)
  const subtleText = rgb(0.36, 0.39, 0.44)
  const lineColor = rgb(0.87, 0.88, 0.9)
  // Neutral charcoal accent — brand-agnostic so it sits well beside any logo.
  const accent = rgb(0.2, 0.21, 0.24)
  const zebraBg = rgb(0.965, 0.97, 0.98)
  // Darker "success-solid" green from globals.css (HSL 145 65% 30%) for CTA buttons.
  const buttonGreen = rgb(0.106, 0.495, 0.268)
  const white = rgb(1, 1, 1)

  // Vertical line spacing within a stacked text block (tighter than before).
  const blockGap = 3

  const logo = await tryEmbedCompanyLogo(doc, opts)

  const drawLeftText = (text: string, x: number, yPos: number, size: number, bold = false, color = textColor) => {
    page.drawText(text, { x, y: yPos, size, font: bold ? fontBold : font, color })
  }

  const formatMoneyWithCurrency = (cents: number, currency: string): string => {
    const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : (settings.currencyCode || 'AUD').toUpperCase()
    const sym = getCurrencySymbol(settings.currencyCode)
    const amount = centsToDollars(cents)
    if (cur === (settings.currencyCode || 'AUD').toUpperCase()) return `${sym}${amount}`
    return `${cur} ${amount}`
  }

  const drawLeftBlock = (lines: BlockLine[], x: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawLeftText(l.text, x, yy, l.size, Boolean(l.bold), l.color ?? textColor)
      yy -= l.size + blockGap
    }
    return yy
  }

  const drawRightBlock = (lines: BlockLine[], xRight: number, yStart: number) => {
    let yy = yStart
    for (const l of lines) {
      if (!String(l.text ?? '').trim()) continue
      drawRightText(page, l.text, xRight, yy, l.size, l.bold ? fontBold : font, l.color ?? textColor)
      yy -= l.size + blockGap
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

  // Filled rounded rectangle (no native border-radius in pdf-lib): a horizontal
  // and vertical body rect plus four quarter-circle corners.
  const drawRoundedRect = (x: number, yb: number, w: number, h: number, radius: number, color: any) => {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2))
    if (r <= 0) {
      page.drawRectangle({ x, y: yb, width: w, height: h, color })
      return
    }
    page.drawRectangle({ x, y: yb + r, width: w, height: h - 2 * r, color })
    page.drawRectangle({ x: x + r, y: yb, width: w - 2 * r, height: h, color })
    page.drawCircle({ x: x + r, y: yb + r, size: r, color })
    page.drawCircle({ x: x + w - r, y: yb + r, size: r, color })
    page.drawCircle({ x: x + r, y: yb + h - r, size: r, color })
    page.drawCircle({ x: x + w - r, y: yb + h - r, size: r, color })
  }

  // Green, rounded call-to-action button. Returns the button's bottom y.
  const drawCtaButton = (label: string, topY: number, url?: string): number => {
    const fontSize = 12
    const padX = 16
    const padY = 8
    const textW = fontBold.widthOfTextAtSize(label, fontSize)
    const buttonW = Math.min(right - left, textW + padX * 2)
    const buttonH = fontSize + padY * 2
    const buttonX = left
    const buttonY = topY - buttonH

    drawRoundedRect(buttonX, buttonY, buttonW, buttonH, 6, buttonGreen)
    page.drawText(label, {
      x: buttonX + (buttonW - textW) / 2,
      y: buttonY + padY,
      size: fontSize,
      font: fontBold,
      color: white,
    })
    if (url) addLinkAnnotation(buttonX, buttonY, buttonW, buttonH, url)
    return buttonY
  }

  const drawDocTitle = () => {
    const label = (descriptor.titleLabel || (descriptor.kind === 'quote' ? 'QUOTE' : 'INVOICE')).toUpperCase()
    const size = 26
    const labelW = fontBold.widthOfTextAtSize(label, size)
    page.drawText(label, { x: right - labelW, y: 800, size, font: fontBold, color: textColor })
  }

  const taxEnabled = descriptor.taxEnabled

  // Table layout
  const colItemX = left
  const colItemW = taxEnabled ? 235 : 305
  const colQtyW = 40
  const colRateW = 70
  const colTaxW = taxEnabled ? 70 : 0
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
    const headerHeight = 22
    page.drawRectangle({ x: left, y: yTop - headerHeight, width: right - left, height: headerHeight, color: accent })
    const headerTextY = yTop - 15
    page.drawText('Item', { x: colItemX + 10, y: headerTextY, size: 9.5, font: fontBold, color: white })
    drawRightText(page, 'Qty', qtyRight, headerTextY, 9.5, fontBold, white)
    drawRightText(page, 'Rate', rateRight, headerTextY, 9.5, fontBold, white)
    if (taxEnabled) drawRightText(page, 'Tax', taxRight, headerTextY, 9.5, fontBold, white)
    drawRightText(page, 'Amount', colAmountRight, headerTextY, 9.5, fontBold, white)
    return yTop - headerHeight - 8
  }

  const newPage = (withTableHeader = false) => {
    page = doc.addPage([595.28, 841.89])
    y = topY
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
  const reservedLogoHeight = Math.max(logo?.drawHeight ?? 0, 42)
  const headerRowStartY = headerTopY - reservedLogoHeight - 10

  const companyLines: BlockLine[] = []
  companyLines.push({ text: settings.businessName || 'Business', size: 13, bold: true })
  if (settings.abn) companyLines.push({ text: `${settings.businessRegistrationLabel || 'ABN'}: ${settings.abn}`, size: 10 })
  if (settings.address) {
    for (const line of settings.address.split('\n')) {
      if (line.trim()) companyLines.push({ text: line.trim(), size: 10 })
    }
  }
  if (settings.phone) companyLines.push({ text: `Phone: ${settings.phone}`, size: 10 })
  if (settings.email) companyLines.push({ text: `Email: ${settings.email}`, size: 10 })
  if (settings.website) companyLines.push({ text: `Web: ${settings.website}`, size: 10 })

  const metaLines: BlockLine[] = []
  metaLines.push({ text: `${descriptor.numberLabel}: ${descriptor.number}`, size: 11, bold: true })
  for (const row of descriptor.dateRows) {
    if (row.value) metaLines.push({ text: `${row.label}: ${row.value}`, size: 10 })
  }

  const afterCompanyY = drawLeftBlock(companyLines, left, headerRowStartY)
  const afterMetaY = drawRightBlock(metaLines, right, headerRowStartY)

  let afterBillToY = afterMetaY
  if (info.clientName || info.clientAddress || info.projectTitle) {
    const billToLines: BlockLine[] = []
    billToLines.push({ text: 'Bill To', size: 9, bold: true, color: subtleText })
    if (info.clientName) {
      for (const wrapped of wrapText(info.clientName, 220, fontBold, 11)) {
        if (wrapped.trim()) billToLines.push({ text: wrapped, size: 11, bold: true })
      }
    }
    if (info.clientAddress) {
      for (const rawLine of info.clientAddress.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        for (const wrapped of wrapText(line, 220, font, 10)) {
          if (wrapped.trim()) billToLines.push({ text: wrapped, size: 10, color: subtleText })
        }
      }
    }
    const billToStartY = afterMetaY - 10
    afterBillToY = drawRightBlock(billToLines, right, billToStartY)
    if (info.projectTitle) {
      afterBillToY -= 4
      for (const wrapped of wrapText(`Project: ${info.projectTitle}`, 220, fontBold, 10)) {
        if (wrapped.trim()) {
          drawRightText(page, wrapped, right, afterBillToY, 10, fontBold, subtleText)
          afterBillToY -= 14
        }
      }
    }
  }

  // Hairline rule separating the masthead from the body.
  y = Math.min(afterCompanyY, afterBillToY) - 12
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: lineColor })
  y -= 16

  y = drawTableHeader(y)

  const itemMaxWidth = colItemW - 12

  let rowIndex = 0
  for (const item of descriptor.items) {
    const amount = calcLineSubtotalCents(item)
    const taxRate = item.taxRatePercent ?? settings.taxRatePercent
    const itemName = item.description || '—'
    const details = (item as any).details

    const itemLines = wrapText(itemName, itemMaxWidth, fontBold, 10)
    const detailLines = details ? wrapText(details, itemMaxWidth, font, 9) : []
    const lines = [...itemLines, ...detailLines]
    const rowHeight = Math.max(20, lines.length * 11 + 9)

    if (y - rowHeight < bottomMargin) {
      newPage(true)
      rowIndex = 0
    }

    const rowTopY = y
    if (rowIndex % 2 === 1) {
      page.drawRectangle({ x: left, y: rowTopY - rowHeight, width: right - left, height: rowHeight, color: zebraBg })
    }

    const textY = rowTopY - 14
    let yy = textY

    for (let i = 0; i < itemLines.length; i++) {
      page.drawText(itemLines[i], { x: colItemX + 10, y: yy, size: 10, font: fontBold, color: textColor })
      yy -= 11
    }

    for (let i = 0; i < detailLines.length; i++) {
      page.drawText(detailLines[i], { x: colItemX + 10, y: yy, size: 9, font, color: subtleText })
      yy -= 11
    }

    drawRightText(page, String(item.quantity ?? 1), qtyRight, textY, 10, font, textColor)
    drawRightText(page, centsToDollars(item.unitPriceCents ?? 0), rateRight, textY, 10, font, textColor)
    if (taxEnabled) {
      const taxLabel = item.taxRateName ? `${item.taxRateName} ${Number(taxRate)}%` : `${Number(taxRate)}%`
      drawRightText(page, taxLabel, taxRight, textY, 10, font, subtleText)
    }
    drawRightText(page, formatMoney(amount, getCurrencySymbol(settings.currencyCode)), colAmountRight, textY, 10, fontBold, textColor)

    y -= rowHeight
    rowIndex++
  }

  // Closing rule under the table body.
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: lineColor })
  y -= 6

  // Totals
  const subtotalCents = sumLineItemsSubtotal(descriptor.items)
  const taxCents = taxEnabled ? sumLineItemsTax(descriptor.items, settings.taxRatePercent) : 0
  const totalCents = subtotalCents + taxCents

  const totalsValueRight = colAmountRight
  const totalsLabelRight = totalsValueRight - 110
  const totalsPanelLeft = totalsLabelRight - 48

  const drawTotalsLine = (label: string, value: string) => {
    drawRightText(page, label, totalsLabelRight, y, 10, font, subtleText)
    drawRightText(page, value, totalsValueRight, y, 10, font, textColor)
    y -= 15
  }

  // Recorded payments (invoices only) → show "Amount paid" + "Balance due".
  const paidRaw = descriptor.kind === 'invoice' && typeof info.amountPaidCents === 'number' ? info.amountPaidCents : 0
  const paidCents = Number.isFinite(paidRaw) ? Math.max(0, Math.trunc(paidRaw)) : 0
  const showPayments = paidCents > 0
  const balanceCents = Math.max(0, totalCents - paidCents)

  if (y - (86 + (showPayments ? 38 : 0)) < bottomMargin) newPage(false)

  y -= 10
  drawTotalsLine('Subtotal', formatMoney(subtotalCents, getCurrencySymbol(settings.currencyCode)))
  if (taxEnabled) {
    const taxTotalsLabel = settings.taxLabel ? `Tax (${settings.taxLabel})` : 'Tax'
    drawTotalsLine(taxTotalsLabel, formatMoney(taxCents, getCurrencySymbol(settings.currencyCode)))
  }

  // Emphasised Total row in a filled accent panel.
  y -= 2
  const totalRowH = 24
  const totalPanelTop = y + 8
  page.drawRectangle({ x: totalsPanelLeft, y: totalPanelTop - totalRowH, width: right - totalsPanelLeft, height: totalRowH, color: accent })
  const totalTextY = totalPanelTop - totalRowH + 9
  drawRightText(page, 'Total', totalsLabelRight, totalTextY, 11, fontBold, white)
  drawRightText(page, formatMoney(totalCents, getCurrencySymbol(settings.currencyCode)), totalsValueRight, totalTextY, 12, fontBold, white)
  y = totalPanelTop - totalRowH - 14

  if (showPayments) {
    drawTotalsLine('Amount paid', `-${formatMoney(paidCents, getCurrencySymbol(settings.currencyCode))}`)
    drawRightText(page, 'Balance due', totalsLabelRight, y, 11, fontBold, textColor)
    drawRightText(page, formatMoney(balanceCents, getCurrencySymbol(settings.currencyCode)), totalsValueRight, y, 12, fontBold, textColor)
    y -= 18
  }

  // Call-to-action / payment section.
  if (descriptor.kind === 'invoice') {
    const paymentDetails = typeof settings.paymentDetails === 'string' ? settings.paymentDetails.trim() : ''
    const hasPaymentDetails = Boolean(paymentDetails)
    const hasPayOnline = Boolean(descriptor.publicUrl)

    if (hasPayOnline || hasPaymentDetails) {
      const paymentDetailsLines: BlockLine[] = []
      if (hasPaymentDetails) {
        for (const rawLine of paymentDetails.split('\n')) {
          const line = rawLine.trim()
          if (!line) continue
          for (const wrapped of wrapText(line, hasPayOnline ? 220 : (right - left), font, 9)) {
            if (wrapped.trim()) paymentDetailsLines.push({ text: wrapped, size: 9, color: subtleText })
          }
        }
      }

      const estimatedNeeded = Math.max(
        hasPayOnline ? 110 : 70,
        (paymentDetailsLines.length + (hasPaymentDetails ? 2 : 0)) * 13 + 30
      )
      if (y - estimatedNeeded < bottomMargin) newPage(false)

      y -= 10
      const sectionHeaderY = y

      if (hasPayOnline) {
        drawLeftText('Pay this invoice online', left, sectionHeaderY, 10, true, textColor)
      } else {
        drawLeftText('Payment details', left, sectionHeaderY, 10, true, textColor)
      }

      // Right column: payment details (when pay-online is present).
      let afterPaymentDetailsY = sectionHeaderY - 16
      if (hasPayOnline) {
        if (hasPaymentDetails) {
          const rightLines: BlockLine[] = [{ text: 'Payment details', size: 10, bold: true, color: textColor }, ...paymentDetailsLines]
          afterPaymentDetailsY = drawRightBlock(rightLines, right, sectionHeaderY)
        }
      } else {
        // Full-width payment details (no public pay link).
        y = sectionHeaderY - 15
        for (const l of paymentDetailsLines) {
          if (y < bottomMargin) newPage(false)
          drawLeftText(l.text, left, y, l.size, false, l.color ?? subtleText)
          y -= l.size + blockGap
        }
        y -= 14
      }

      // Left column: pay button (only when we have a public invoice URL).
      if (hasPayOnline && descriptor.publicUrl) {
        const feeCentsRaw = typeof info.stripeProcessingFeeCents === 'number' ? info.stripeProcessingFeeCents : NaN
        const feeCents = Number.isFinite(feeCentsRaw) ? Math.max(0, Math.trunc(feeCentsRaw)) : 0
        const feeCurrency = typeof info.stripeProcessingFeeCurrency === 'string' ? info.stripeProcessingFeeCurrency : (settings.currencyCode || 'AUD')

        let leftAfterHeaderY = sectionHeaderY - 18
        if (feeCents > 0) {
          const feeText = `Attracts ${formatMoneyWithCurrency(feeCents, feeCurrency)} in card processing fees`
          drawLeftText(feeText, left, sectionHeaderY - 14, 9, false, subtleText)
          // Keep the Pay button close under the fee line.
          leftAfterHeaderY = sectionHeaderY - 26
        }

        const buttonY = drawCtaButton('Pay Invoice', leftAfterHeaderY - 4, descriptor.publicUrl)

        // Continue below whichever side (left button or right payment details) is lower.
        y = Math.min(buttonY - 14, afterPaymentDetailsY) - 20
      }
    }
  } else if (descriptor.publicUrl) {
    if (y - 70 < bottomMargin) newPage(false)
    y -= 10
    drawLeftText('Accept this quote online', left, y, 10, true, textColor)
    y -= 18
    const buttonY = drawCtaButton('Accept Quote', y, descriptor.publicUrl)
    y = buttonY - 14
  }

  // Notes
  if (descriptor.notes?.trim()) {
    y -= 10
    const notesLines = wrapText(descriptor.notes, right - left, font, 10)
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
  if (descriptor.terms?.trim()) {
    const termsLines = wrapText(descriptor.terms, right - left, font, 10)

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

  addPageNumbers(doc, font, rgb(0.45, 0.45, 0.45), { leftLabel: descriptor.pageLeftLabel })
  const bytes = await doc.save()
  return bytes
}

function quoteDescriptor(quote: SalesQuote, settings: SalesSettings, info: PdfPartyInfo): SalesDocDescriptor {
  // Use per-document taxEnabled (snapshot from creation); fall back to settings for legacy docs.
  const taxEnabled = quote.taxEnabled ?? settings.taxEnabled
  const dateRows: Array<{ label: string; value: string }> = [{ label: 'Issue date', value: formatDate(quote.issueDate) }]
  if (quote.validUntil) dateRows.push({ label: 'Valid until', value: formatDate(quote.validUntil) })

  return {
    kind: 'quote',
    number: quote.quoteNumber,
    titleLabel: settings.quoteLabel || 'QUOTE',
    numberLabel: 'Quote #',
    dateRows,
    taxEnabled,
    items: quote.items,
    notes: quote.notes,
    terms: quote.terms,
    publicUrl: info.publicQuoteUrl,
    pageLeftLabel: `Quote: ${quote.quoteNumber}`,
  }
}

function invoiceDescriptor(invoice: SalesInvoice, settings: SalesSettings, info: PdfPartyInfo): SalesDocDescriptor {
  const taxEnabled = invoice.taxEnabled ?? settings.taxEnabled
  const dateRows: Array<{ label: string; value: string }> = [{ label: 'Issue date', value: formatDate(invoice.issueDate) }]
  if (invoice.dueDate) dateRows.push({ label: 'Due date', value: formatDate(invoice.dueDate) })

  return {
    kind: 'invoice',
    number: invoice.invoiceNumber,
    titleLabel: settings.invoiceLabel || 'INVOICE',
    numberLabel: 'Invoice #',
    dateRows,
    taxEnabled,
    items: invoice.items,
    notes: invoice.notes,
    terms: invoice.terms,
    publicUrl: info.publicInvoiceUrl,
    pageLeftLabel: `Invoice: ${invoice.invoiceNumber}`,
  }
}

export async function downloadQuotePdf(
  quote: SalesQuote,
  settings: SalesSettings,
  info: PdfPartyInfo = {}
): Promise<void> {
  const bytes = await buildSalesDocPdfBytes(quoteDescriptor(quote, settings, info), settings, info)
  downloadBytes(`${quote.quoteNumber}.pdf`, bytes)
}

export async function renderQuotePdfBytes(
  quote: SalesQuote,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  return buildSalesDocPdfBytes(quoteDescriptor(quote, settings, info), settings, info, opts)
}

export async function downloadInvoicePdf(
  invoice: SalesInvoice,
  settings: SalesSettings,
  info: PdfPartyInfo = {}
): Promise<void> {
  const bytes = await buildSalesDocPdfBytes(invoiceDescriptor(invoice, settings, info), settings, info)
  downloadBytes(`${invoice.invoiceNumber}.pdf`, bytes)
}

export async function renderInvoicePdfBytes(
  invoice: SalesInvoice,
  settings: SalesSettings,
  info: PdfPartyInfo = {},
  opts?: { baseUrl?: string }
): Promise<Uint8Array> {
  return buildSalesDocPdfBytes(invoiceDescriptor(invoice, settings, info), settings, info, opts)
}

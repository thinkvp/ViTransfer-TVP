export function isHexDisplayColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return /^#[0-9a-fA-F]{6}$/.test(value.trim())
}

export function normalizeHexDisplayColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return isHexDisplayColor(trimmed) ? trimmed.toUpperCase() : null
}

export function generateRandomHexDisplayColor(): string {
  // Prefer Web Crypto when available (browser + modern Node).
  const cryptoObj: Crypto | undefined = (globalThis as any).crypto

  const toHex2 = (n: number) => n.toString(16).padStart(2, '0')

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(3)
    cryptoObj.getRandomValues(bytes)
    return `#${toHex2(bytes[0])}${toHex2(bytes[1])}${toHex2(bytes[2])}`.toUpperCase()
  }

  // Fallback: non-crypto randomness (should be rare).
  const r = Math.floor(Math.random() * 256)
  const g = Math.floor(Math.random() * 256)
  const b = Math.floor(Math.random() * 256)
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`.toUpperCase()
}

// ─── Readable text on a coloured background ──────────────────────────────────
// Initials avatars paint the person's display colour as the background. Those
// colours are user-chosen (or random), so a fixed white text colour disappears
// on pale backgrounds. Pick whichever of the two candidates below has the
// better WCAG contrast ratio against the background instead.

export const AVATAR_TEXT_LIGHT = '#FFFFFF'
export const AVATAR_TEXT_DARK = '#111827'

function parseHexRgb(value: string): [number, number, number] | null {
  const clean = value.trim().replace(/^#/, '')
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

/** WCAG 2.x relative luminance for an 8-bit sRGB triple. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Return the foreground colour (near-black or white) that reads best on `background`.
 * Falls back to white for anything that isn't a parseable hex colour.
 */
export function readableTextColorForBackground(background: unknown): string {
  if (typeof background !== 'string') return AVATAR_TEXT_LIGHT
  const bg = parseHexRgb(background)
  if (!bg) return AVATAR_TEXT_LIGHT
  const light = parseHexRgb(AVATAR_TEXT_LIGHT)!
  const dark = parseHexRgb(AVATAR_TEXT_DARK)!
  return contrastRatio(bg, dark) > contrastRatio(bg, light) ? AVATAR_TEXT_DARK : AVATAR_TEXT_LIGHT
}

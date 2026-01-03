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

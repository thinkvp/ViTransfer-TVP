import { prisma } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/encryption'

const INTEGRATION_ID = 'default'

export async function getStoredQuickBooksRefreshToken(): Promise<string | null> {
  try {
    const row = await (prisma as any).quickBooksIntegration.findUnique({
      where: { id: INTEGRATION_ID },
      select: { refreshTokenEncrypted: true },
    })

    const encrypted = row?.refreshTokenEncrypted
    if (!encrypted) return null
    const token = decrypt(encrypted)
    return token?.trim() ? token.trim() : null
  } catch {
    // If migration hasn't been applied yet, or DB is unavailable, don't block pulls.
    return null
  }
}

export async function storeQuickBooksRefreshToken(refreshToken: string): Promise<boolean> {
  const token = refreshToken.trim()
  if (!token) return false

  try {
    const encrypted = encrypt(token)

    await (prisma as any).quickBooksIntegration.upsert({
      where: { id: INTEGRATION_ID },
      create: {
        id: INTEGRATION_ID,
        refreshTokenEncrypted: encrypted,
        lastRefreshedAt: new Date(),
      },
      update: {
        refreshTokenEncrypted: encrypted,
        lastRefreshedAt: new Date(),
      },
      select: { id: true },
    })

    return true
  } catch {
    // Non-fatal: pulls can still work off env vars.
    return false
  }
}

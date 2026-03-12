import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { shouldExcludeInternalIpsFromAnalytics } from '@/lib/settings'

/**
 * Best-effort check: is the given IP address likely an internal user (admin)?
 *
 * Strategy (in order):
 * 1. Check a short-lived Redis cache (`admin_ip:{ip}`) — avoids a DB query on
 *    every public page load.
 * 2. Query the SecurityEvent table for a recent successful admin login from
 *    this IP (password or passkey).
 * 3. If found, cache the positive result in Redis for 24 hours so subsequent
 *    hits from the same IP are fast.
 *
 * Returns `true` when the IP matches a known internal user; `false` otherwise.
 * Any errors are swallowed — this is an analytics-quality signal, not a
 * security gate.
 */
export async function isLikelyAdminIp(ipAddress: string | null | undefined): Promise<boolean> {
  if (!ipAddress || ipAddress === 'unknown') return false

  const excludeInternalIps = await shouldExcludeInternalIpsFromAnalytics().catch(() => true)
  if (!excludeInternalIps) return false

  try {
    const redis = getRedis()
    const cacheKey = `admin_ip:${ipAddress}`

    // 1. Check Redis cache first.
    const cached = await redis.get(cacheKey).catch(() => null)
    if (cached === '1') return true
    if (cached === '0') return false // negative cache (shorter TTL set below)

    // 2. Query the database for a recent admin login from this IP.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days
    const match = await prisma.securityEvent.findFirst({
      where: {
        type: { in: ['ADMIN_PASSWORD_LOGIN_SUCCESS', 'PASSKEY_LOGIN_SUCCESS'] },
        ipAddress,
        createdAt: { gte: since },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })

    if (match) {
      // Positive: cache for 24 h.
      await redis.setex(cacheKey, 24 * 60 * 60, '1').catch(() => {})
      return true
    }

    // Negative: cache for 5 min to avoid repeated queries for the same
    // non-admin IP, but keep it short so a new admin login is picked up
    // quickly.
    await redis.setex(cacheKey, 5 * 60, '0').catch(() => {})
    return false
  } catch {
    return false
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { listWebPushSubscriptionsForUser } from '@/lib/admin-web-push'
import { Prisma } from '@prisma/client'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const user = await requireApiAdmin(request)
  if (user instanceof Response) return user

  const limited = await rateLimit(request, { maxRequests: 60, windowMs: 60_000 }, 'web-push-subs-list')
  if (limited) return limited

  try {
    const subs = await listWebPushSubscriptionsForUser(user.id)

    const res = NextResponse.json({ subscriptions: subs })
    res.headers.set('Cache-Control', 'no-store')
    res.headers.set('Pragma', 'no-cache')
    return res
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2021' || error.code === 'P2022') {
        return NextResponse.json(
          {
            error: 'Web push tables/columns are missing. Run Prisma migrations (npx prisma migrate deploy) and restart the app.',
            code: error.code,
          },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ error: 'Failed to list subscriptions' }, { status: 500 })
  }
}

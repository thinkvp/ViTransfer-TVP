import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { upsertWebPushSubscription } from '@/lib/admin-web-push'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function POST(request: NextRequest) {
  const user = await requireApiAdmin(request)
  if (user instanceof Response) return user

  try {
    const body = await request.json()

    const endpoint = asTrimmedString(body?.subscription?.endpoint)
    const p256dh = asTrimmedString(body?.subscription?.keys?.p256dh)
    const auth = asTrimmedString(body?.subscription?.keys?.auth)

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: 'Invalid subscription payload' }, { status: 400 })
    }

    const deviceName = asTrimmedString(body?.deviceName) || null
    const userAgent = request.headers.get('user-agent')

    const sub = await upsertWebPushSubscription({
      userId: user.id,
      endpoint,
      p256dh,
      auth,
      deviceName,
      userAgent,
    })

    if (!sub) {
      return NextResponse.json({ error: 'Failed to create subscription' }, { status: 500 })
    }

    const res = NextResponse.json({ subscription: sub })
    res.headers.set('Cache-Control', 'no-store')
    res.headers.set('Pragma', 'no-cache')
    return res
  } catch (err: any) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2021' || err.code === 'P2022') {
        return NextResponse.json(
          {
            error: 'Web push tables/columns are missing. Run Prisma migrations (npx prisma migrate deploy) and restart the app.',
            code: err.code,
          },
          { status: 500 }
        )
      }
    }

    const message = typeof err?.message === 'string' ? err.message : 'Failed to subscribe'
    const status = message.includes('already registered') ? 409 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

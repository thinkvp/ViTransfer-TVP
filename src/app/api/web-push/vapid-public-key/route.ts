import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { getWebPushPublicKey } from '@/lib/admin-web-push'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const user = await requireApiAdmin(request)
  if (user instanceof Response) return user

  try {
    const publicKey = await getWebPushPublicKey()

    const res = NextResponse.json({ publicKey })
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

    return NextResponse.json({ error: 'Failed to fetch VAPID public key' }, { status: 500 })
  }
}

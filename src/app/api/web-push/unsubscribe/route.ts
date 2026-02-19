import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { deleteWebPushSubscription } from '@/lib/admin-web-push'
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
    const body = await request.json().catch(() => null)
    const endpoint = asTrimmedString(body?.endpoint)
    const id = asTrimmedString(body?.id)

    const deleted = await deleteWebPushSubscription({ userId: user.id, endpoint: endpoint || undefined, id: id || undefined })
    return NextResponse.json({ deleted })
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

    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 })
  }
}

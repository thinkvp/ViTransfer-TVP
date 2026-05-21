import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Deprecated endpoint kept for compatibility after dark-logo support removal.
export async function GET(_request: NextRequest) {
  return NextResponse.json(
    { error: 'Dark logo is no longer supported.' },
    { status: 404 }
  )
}

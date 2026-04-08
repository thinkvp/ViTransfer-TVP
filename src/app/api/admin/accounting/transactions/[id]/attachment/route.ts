import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const gone = () => NextResponse.json({ error: 'This endpoint has been removed. Use /attachments instead.' }, { status: 410 })
export const GET = gone
export const POST = gone
export const DELETE = gone

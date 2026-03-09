import { NextRequest, NextResponse } from 'next/server'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getClientIpAddress } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONNECTION_TEST_TOTAL_BYTES = 256 * 1024 * 1024
const CONNECTION_TEST_MAX_RANGE_BYTES = 64 * 1024 * 1024
const CONNECTION_TEST_CHUNK_BYTES = 256 * 1024

const SEED_BLOCK = (() => {
  const block = new Uint8Array(1024 * 1024)
  let state = 0x12345678
  for (let index = 0; index < block.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    block[index] = state & 0xff
  }
  return block
})()

function parseRangeHeader(rangeHeader: string | null): { start: number; end: number } | null {
  if (!rangeHeader) {
    return null
  }

  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) {
    return null
  }

  const start = Number(match[1])
  if (!Number.isFinite(start) || start < 0) {
    return null
  }

  const requestedEnd = match[2] ? Number(match[2]) : start + CONNECTION_TEST_MAX_RANGE_BYTES - 1
  if (!Number.isFinite(requestedEnd)) {
    return null
  }

  return {
    start,
    end: requestedEnd,
  }
}

function buildSyntheticStream(start: number, end: number): ReadableStream<Uint8Array> {
  let offset = start

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset > end) {
        controller.close()
        return
      }

      const remaining = (end - offset) + 1
      const chunkSize = Math.min(CONNECTION_TEST_CHUNK_BYTES, remaining)
      const chunk = new Uint8Array(chunkSize)
      let written = 0

      while (written < chunkSize) {
        const seedOffset = offset % SEED_BLOCK.length
        const copyLength = Math.min(SEED_BLOCK.length - seedOffset, chunkSize - written)
        chunk.set(SEED_BLOCK.subarray(seedOffset, seedOffset + copyLength), written)
        written += copyLength
        offset += copyLength
      }

      controller.enqueue(chunk)
    },
  })
}

export async function GET(request: NextRequest) {
  const authContext = await getAuthContext(request)
  if (!authContext.isAdmin && !authContext.shareContext) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 1200,
    message: 'Too many connection test requests. Please slow down.',
  }, 'connection-test-ip')

  if (rateLimitResult) {
    return rateLimitResult
  }

  const parsedRange = parseRangeHeader(request.headers.get('range'))
  const start = parsedRange?.start ?? 0

  if (start >= CONNECTION_TEST_TOTAL_BYTES) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store, no-transform',
        'Content-Range': `bytes */${CONNECTION_TEST_TOTAL_BYTES}`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  const requestedEnd = parsedRange?.end ?? Math.min(CONNECTION_TEST_TOTAL_BYTES - 1, CONNECTION_TEST_MAX_RANGE_BYTES - 1)
  const end = Math.min(
    requestedEnd,
    start + CONNECTION_TEST_MAX_RANGE_BYTES - 1,
    CONNECTION_TEST_TOTAL_BYTES - 1,
  )

  if (end < start) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store, no-transform',
        'Content-Range': `bytes */${CONNECTION_TEST_TOTAL_BYTES}`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  const contentLength = (end - start) + 1
  const body = buildSyntheticStream(start, end)

  return new NextResponse(body, {
    status: parsedRange ? 206 : 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store, no-transform',
      'Content-Length': contentLength.toString(),
      'Content-Range': `bytes ${start}-${end}/${CONNECTION_TEST_TOTAL_BYTES}`,
      'Content-Type': 'application/octet-stream',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Test-Data': 'synthetic-stream',
    },
  })
}
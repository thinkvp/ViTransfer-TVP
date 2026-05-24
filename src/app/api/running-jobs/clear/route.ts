import type { NextRequest } from 'next/server'
import { POST as clearRunningJobsPost } from '../route'

export const runtime = 'nodejs'

// Backward-compatible alias so older/cached clients that POST to
// /api/running-jobs/clear continue to work.
export async function POST(request: NextRequest) {
  return clearRunningJobsPost(request)
}

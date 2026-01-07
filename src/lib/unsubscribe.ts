import { createHmac, timingSafeEqual } from 'crypto'

function getUnsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || process.env.ENCRYPTION_KEY
  if (secret && secret.trim()) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing unsubscribe signing secret (set UNSUBSCRIBE_SECRET or JWT_SECRET)')
  }

  return 'DEV_ONLY_INSECURE_UNSUBSCRIBE_SECRET'
}

export function signUnsubscribe(projectId: string, recipientId: string): string {
  const secret = getUnsubscribeSecret()
  const payload = `${projectId}.${recipientId}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function verifyUnsubscribe(projectId: string, recipientId: string, signature: string): boolean {
  if (!projectId || !recipientId || !signature) return false

  const expected = signUnsubscribe(projectId, recipientId)

  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signature, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function buildUnsubscribeUrl(baseUrl: string, projectId: string, recipientId: string): string {
  const sig = signUnsubscribe(projectId, recipientId)
  const parsedBase = new URL(baseUrl)
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error('Unsubscribe baseUrl must be http(s)')
  }
  const url = new URL('/unsubscribe', parsedBase.origin)
  url.searchParams.set('projectId', projectId)
  url.searchParams.set('recipientId', recipientId)
  url.searchParams.set('sig', sig)
  return url.toString()
}

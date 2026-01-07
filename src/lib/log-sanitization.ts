export function redactEmailForLogs(email: string | null | undefined): string {
  if (!email) return ''
  const trimmed = email.trim()

  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return '[redacted]'

  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)

  const keep = local.length <= 2 ? 1 : 2
  const visible = local.slice(0, keep)

  return `${visible}***@${domain}`
}

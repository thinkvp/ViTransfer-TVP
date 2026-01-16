function escapeText(value: string): string {
  // RFC 5545 text escaping
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
}

function foldLine(line: string): string {
  // RFC 5545 line folding: 75 octets recommended. We'll fold by char count for simplicity.
  // Uses CRLF + single space continuation.
  const limit = 74
  if (line.length <= limit) return line

  let out = ''
  let i = 0
  while (i < line.length) {
    const chunk = line.slice(i, i + limit)
    out += chunk
    i += limit
    if (i < line.length) out += '\r\n '
  }
  return out
}

export function icsProperty(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

export function icsTextProperty(name: string, value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = String(value)
  if (!trimmed) return null
  return icsProperty(name, escapeText(trimmed))
}

export function icsJoinLines(lines: Array<string | null | undefined>): string {
  return lines.filter(Boolean).join('\r\n') + '\r\n'
}

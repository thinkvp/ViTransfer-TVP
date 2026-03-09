function createDownloadId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.randomUUID) {
    return `download-${Date.now()}-${cryptoObj.randomUUID()}`
  }
  return `download-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function withDownloadTracking(url: string): string {
  if (typeof window === 'undefined') {
    return url
  }

  try {
    const nextUrl = new URL(url, window.location.origin)
    nextUrl.searchParams.set('downloadId', createDownloadId())
    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
  } catch {
    return url
  }
}
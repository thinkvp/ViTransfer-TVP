let inMemoryAccessToken: string | null = null
let cachedRefreshToken: string | null = null

const REFRESH_TOKEN_KEY = 'vitransfer_refresh_token'
const REMEMBER_DEVICE_KEY = 'vitransfer_remember_device'

type TokenChangeListener = (tokens: { accessToken: string | null; refreshToken: string | null }) => void
const listeners = new Set<TokenChangeListener>()

function getRememberDeviceEnabledUnsafe(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(REMEMBER_DEVICE_KEY) === '1'
  } catch {
    return false
  }
}

function getPreferredRefreshStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return getRememberDeviceEnabledUnsafe() ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function syncRefreshFromStorage(): string | null {
  if (typeof window === 'undefined') return null
  if (cachedRefreshToken) return cachedRefreshToken

  // Preferred storage first, then fallback to sessionStorage (helps if the preference was toggled).
  const preferred = getPreferredRefreshStorage()
  const preferredToken = preferred?.getItem(REFRESH_TOKEN_KEY) ?? null
  const sessionToken = window.sessionStorage.getItem(REFRESH_TOKEN_KEY)

  cachedRefreshToken = preferredToken || sessionToken || null
  return cachedRefreshToken
}

export function getRememberDeviceEnabled(): boolean {
  return getRememberDeviceEnabledUnsafe()
}

export function setRememberDeviceEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return

  try {
    if (enabled) {
      window.localStorage.setItem(REMEMBER_DEVICE_KEY, '1')
    } else {
      window.localStorage.removeItem(REMEMBER_DEVICE_KEY)
    }

    // Migrate refresh token to the newly preferred storage.
    const token = cachedRefreshToken || window.localStorage.getItem(REFRESH_TOKEN_KEY) || window.sessionStorage.getItem(REFRESH_TOKEN_KEY)
    if (token) {
      if (enabled) {
        window.localStorage.setItem(REFRESH_TOKEN_KEY, token)
        window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
      } else {
        window.sessionStorage.setItem(REFRESH_TOKEN_KEY, token)
        window.localStorage.removeItem(REFRESH_TOKEN_KEY)
      }
    }

    cachedRefreshToken = token || null
  } catch {
    // Ignore storage errors (Safari private mode, etc.)
  }

  notifyListeners()
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken
}

export function getRefreshToken(): string | null {
  return cachedRefreshToken || syncRefreshFromStorage()
}

export function setTokens(tokens: { accessToken: string; refreshToken: string }) {
  inMemoryAccessToken = tokens.accessToken
  cachedRefreshToken = tokens.refreshToken

  if (typeof window !== 'undefined') {
    try {
      const preferred = getPreferredRefreshStorage()
      preferred?.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)

      // Ensure the token only lives in one place.
      if (getRememberDeviceEnabledUnsafe()) {
        window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
      } else {
        window.localStorage.removeItem(REFRESH_TOKEN_KEY)
      }
    } catch {
      // ignore
    }
  }

  notifyListeners()
}

export function updateAccessToken(accessToken: string) {
  inMemoryAccessToken = accessToken
  notifyListeners()
}

export function clearTokens() {
  inMemoryAccessToken = null
  cachedRefreshToken = null

  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
      window.localStorage.removeItem(REFRESH_TOKEN_KEY)
    } catch {
      // ignore
    }
  }

  notifyListeners()
}

export function subscribe(listener: TokenChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyListeners() {
  const snapshot = { accessToken: inMemoryAccessToken, refreshToken: cachedRefreshToken }
  listeners.forEach(fn => fn(snapshot))
}

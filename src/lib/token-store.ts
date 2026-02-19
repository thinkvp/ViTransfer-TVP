let inMemoryAccessToken: string | null = null
let cachedRefreshToken: string | null = null

const REFRESH_TOKEN_KEY = 'vitransfer_refresh_token'
const REMEMBER_DEVICE_KEY = 'vitransfer_remember_device'
const TOKEN_CHANNEL_NAME = 'vitransfer_auth_tokens'

type TokenChangeListener = (tokens: { accessToken: string | null; refreshToken: string | null }) => void
const listeners = new Set<TokenChangeListener>()
let tokenChannel: BroadcastChannel | null = null
let tokenChannelInitialized = false

/**
 * Persist a refresh token received from another window (via BroadcastChannel / storage event)
 * into THIS window's own storage so that page reloads pick up the latest rotated token.
 */
function persistReceivedRefreshToken(token: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (token) {
      const preferred = getPreferredRefreshStorage()
      preferred?.setItem(REFRESH_TOKEN_KEY, token)
      // Keep token in one storage only
      if (getRememberDeviceEnabledUnsafe()) {
        window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
      } else {
        window.localStorage.removeItem(REFRESH_TOKEN_KEY)
      }
    } else {
      window.localStorage.removeItem(REFRESH_TOKEN_KEY)
      window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
    }
  } catch {
    // Ignore storage errors
  }
}

function ensureTokenChannel(): BroadcastChannel | null {
  if (tokenChannelInitialized) return tokenChannel
  tokenChannelInitialized = true

  if (typeof window === 'undefined') return null
  if (typeof (window as any).BroadcastChannel !== 'function') return null

  try {
    tokenChannel = new BroadcastChannel(TOKEN_CHANNEL_NAME)
    tokenChannel.onmessage = (event) => {
      const data = event?.data as any
      if (!data || typeof data !== 'object') return

      if (data.type === 'tokens') {
        if (Object.prototype.hasOwnProperty.call(data, 'accessToken')) {
          inMemoryAccessToken = typeof data.accessToken === 'string' ? data.accessToken : null
        }
        if (Object.prototype.hasOwnProperty.call(data, 'refreshToken')) {
          cachedRefreshToken = typeof data.refreshToken === 'string' ? data.refreshToken : null
          // Persist to THIS window's storage so reloads / re-opens stay fresh
          persistReceivedRefreshToken(cachedRefreshToken)
        }
        notifyListeners()
      }

      if (data.type === 'clear') {
        inMemoryAccessToken = null
        cachedRefreshToken = null
        persistReceivedRefreshToken(null)
        notifyListeners()
      }
    }
  } catch {
    tokenChannel = null
  }

  // Backup sync: listen for localStorage changes made by other windows.
  // This fires when another Chrome window writes to localStorage (same origin).
  // It does NOT fire in the window that made the change, so there's no loop.
  try {
    window.addEventListener('storage', (event) => {
      if (event.key === REFRESH_TOKEN_KEY && event.storageArea === window.localStorage) {
        cachedRefreshToken = event.newValue
        notifyListeners()
      }
      if (event.key === REMEMBER_DEVICE_KEY && event.storageArea === window.localStorage) {
        // Another window toggled remember-device; re-sync refresh token from storage
        syncRefreshFromStorage()
        notifyListeners()
      }
    })
  } catch {
    // Ignore — SSR or non-standard environment
  }

  return tokenChannel
}

function broadcastTokens(payload: { type: 'tokens' | 'clear'; accessToken?: string | null; refreshToken?: string | null }) {
  const channel = ensureTokenChannel()
  if (!channel) return
  try {
    channel.postMessage(payload)
  } catch {
    // ignore
  }
}

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

  try {
    // Preferred storage first, then fallback to sessionStorage (helps if the preference was toggled).
    const preferred = getPreferredRefreshStorage()
    const preferredToken = preferred?.getItem(REFRESH_TOKEN_KEY) ?? null
    const sessionToken = window.sessionStorage.getItem(REFRESH_TOKEN_KEY)

    cachedRefreshToken = preferredToken || sessionToken || null
    return cachedRefreshToken
  } catch {
    return cachedRefreshToken
  }
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
  ensureTokenChannel()
  return inMemoryAccessToken
}

export function getRefreshToken(): string | null {
  ensureTokenChannel()
  // Trust in-memory cache first — it's kept fresh by BroadcastChannel and
  // storage event listeners. Fall back to storage only on first load (cold start).
  if (cachedRefreshToken) return cachedRefreshToken
  return syncRefreshFromStorage()
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
  broadcastTokens({
    type: 'tokens',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  })
}

export function updateAccessToken(accessToken: string) {
  inMemoryAccessToken = accessToken
  notifyListeners()
  broadcastTokens({
    type: 'tokens',
    accessToken,
    refreshToken: cachedRefreshToken,
  })
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
  broadcastTokens({ type: 'clear' })
}

export function subscribe(listener: TokenChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyListeners() {
  const snapshot = { accessToken: inMemoryAccessToken, refreshToken: cachedRefreshToken }
  listeners.forEach(fn => fn(snapshot))
}

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { expireCurrentWindowSession, getAccessToken, isCurrentWindowSessionTimedOut, subscribe } from '@/lib/token-store'
import { attemptRefresh } from '@/lib/api-client'

const INACTIVITY_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const CHECK_INTERVAL = 30 * 1000 // 30 seconds
const PROACTIVE_REFRESH_BEFORE_MS = 5 * 60 * 1000 // Refresh 5 min before access token expires

/** Decode the exp claim from a JWT without verifying the signature. */
function getJwtExpMs(token: string): number | null {
  try {
    const b64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    if (!b64) return null
    const payload = JSON.parse(atob(b64))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export default function SessionMonitor() {
  const router = useRouter()
  const [showWarning, setShowWarning] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(0)
  const lastActivityRef = useRef<number>(0)
  const didExpireRef = useRef(false)

  const handleTimeout = useCallback(() => {
    if (didExpireRef.current) return
    didExpireRef.current = true

    expireCurrentWindowSession()
    setShowWarning(false)
    router.push('/login?sessionExpired=true')
  }, [router])

  // Proactive token refresh: silently renew the access token before it expires
  // so there is no 401-triggered race when multiple browser windows share a
  // refresh token and all detect expiry simultaneously.
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleProactiveRefresh() {
      if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      const token = getAccessToken()
      if (!token || isCurrentWindowSessionTimedOut()) return
      const expMs = getJwtExpMs(token)
      if (!expMs) return
      const msUntilRefresh = expMs - Date.now() - PROACTIVE_REFRESH_BEFORE_MS
      if (msUntilRefresh <= 0) {
        // Already inside the refresh window — trigger immediately
        attemptRefresh().catch(() => {})
        return
      }
      refreshTimer = setTimeout(() => {
        if (!isCurrentWindowSessionTimedOut()) {
          attemptRefresh().catch(() => {})
        }
      }, msUntilRefresh)
    }

    scheduleProactiveRefresh()
    const unsubscribe = subscribe(() => scheduleProactiveRefresh())
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    // Initialize last activity time
    lastActivityRef.current = Date.now()

    const onActivity = () => {
      lastActivityRef.current = Date.now()
      setShowWarning(false)
    }

    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']
    activityEvents.forEach(event => {
      document.addEventListener(event, onActivity, { passive: true, capture: true })
    })

    const inactivityTimer = setInterval(() => {
      const timeSinceActivity = Date.now() - lastActivityRef.current
      const timeUntilLogout = INACTIVITY_TIMEOUT - timeSinceActivity

      if (timeUntilLogout <= 0) {
        handleTimeout()
      } else if (timeUntilLogout <= 2 * 60 * 1000) {
        setShowWarning(true)
        setTimeRemaining(Math.ceil(timeUntilLogout / 1000))
      } else {
        setShowWarning(false)
      }
    }, CHECK_INTERVAL)

    return () => {
      activityEvents.forEach(event => {
        document.removeEventListener(event, onActivity, { capture: true } as any)
      })
      clearInterval(inactivityTimer)
    }
  }, [handleTimeout])

  if (!showWarning) {
    return null
  }

  const minutes = Math.floor(timeRemaining / 60)
  const seconds = timeRemaining % 60

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in slide-in-from-bottom-5">
      <div className="bg-warning-visible border-2 border-warning-visible rounded-lg shadow-lg p-4 max-w-sm">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <svg
              className="w-6 h-6 text-warning"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-warning">
              Inactivity Warning
            </h3>
            <p className="text-sm text-warning font-medium mt-1">
              You will be logged out in {minutes}:{seconds.toString().padStart(2, '0')} due to inactivity.
            </p>
            <p className="text-xs text-warning font-medium mt-2">
              Click anywhere or move your mouse to stay logged in.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useCallback, useRef } from 'react'

const CONFIRM_MESSAGE = 'You have unsaved changes. Are you sure you want to leave?'

/**
 * Hook that warns users when they try to navigate away with unsaved changes.
 * Handles:
 *  - browser close / reload (beforeunload)
 *  - Next.js App Router client-side navigation (history.pushState / replaceState)
 *  - browser back / forward (popstate)
 *
 * @param hasUnsavedChanges - whether the form currently has unsaved changes
 */
export function useUnsavedChanges(hasUnsavedChanges: boolean) {
  const dirtyRef = useRef(hasUnsavedChanges)

  useEffect(() => {
    dirtyRef.current = hasUnsavedChanges
  }, [hasUnsavedChanges])

  // Browser close / reload guard
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Intercept Next.js App Router client-side navigation (pushState / replaceState)
  // and browser back/forward (popstate).
  useEffect(() => {
    const originalPushState = history.pushState.bind(history)
    const originalReplaceState = history.replaceState.bind(history)

    history.pushState = function (data: any, unused: string, url?: string | URL | null) {
      if (dirtyRef.current && !window.confirm(CONFIRM_MESSAGE)) {
        return // block navigation
      }
      return originalPushState(data, unused, url)
    }

    history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
      // Allow same-URL replaceState calls (scroll restoration, hash changes, etc.)
      if (url && new URL(url, location.href).pathname !== location.pathname) {
        if (dirtyRef.current && !window.confirm(CONFIRM_MESSAGE)) {
          return
        }
      }
      return originalReplaceState(data, unused, url)
    }

    const handlePopState = () => {
      if (!dirtyRef.current) return
      if (!window.confirm(CONFIRM_MESSAGE)) {
        // Push the current entry back so the user stays on this page
        originalPushState(null, '', location.href)
      }
    }

    window.addEventListener('popstate', handlePopState)

    return () => {
      history.pushState = originalPushState
      history.replaceState = originalReplaceState
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  /**
   * Call before programmatic navigation (e.g. router.push).
   * Returns true if navigation should proceed,
   * false if the user chose to stay.
   */
  const confirmNavigation = useCallback((): boolean => {
    if (!dirtyRef.current) return true
    return window.confirm(CONFIRM_MESSAGE)
  }, [])

  return { confirmNavigation }
}

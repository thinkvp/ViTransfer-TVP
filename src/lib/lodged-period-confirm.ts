/**
 * Client-side confirmation for writes that change a lodged BAS period.
 *
 * Routes guarded by lodgedPeriodGuard answer 409 `code: 'LODGED_BAS_PERIOD'`; apiFetch
 * asks here, and on yes repeats the request with the confirm header. The admin layout
 * mounts LodgedPeriodConfirmHost, which registers a styled dialog; without it (any page
 * outside the admin layout) this falls back to the browser's confirm().
 */

export const LODGED_PERIOD_CONFIRM_HEADER = 'X-Confirm-Lodged-Period'
export const LODGED_PERIOD_CODE = 'LODGED_BAS_PERIOD'

type ConfirmHandler = (message: string) => Promise<boolean>

let handler: ConfirmHandler | null = null

export function registerLodgedPeriodConfirmHandler(next: ConfirmHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

export function requestLodgedPeriodConfirm(message: string): Promise<boolean> {
  if (handler) return handler(message)
  if (typeof window === 'undefined') return Promise.resolve(false)
  return Promise.resolve(window.confirm(message))
}

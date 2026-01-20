'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { KeyRound, ArrowLeft, CheckCircle2, Loader2, AlertCircle, XCircle } from 'lucide-react'

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams?.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [validating, setValidating] = useState(true)
  const [tokenValid, setTokenValid] = useState(false)
  const [tokenError, setTokenError] = useState('')
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [success, setSuccess] = useState(false)

  // Validate token on mount
  useEffect(() => {
    async function validateToken() {
      if (!token) {
        setTokenError('No reset token provided.')
        setValidating(false)
        return
      }

      try {
        const response = await fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`)
        const data = await response.json()

        if (data.valid) {
          setTokenValid(true)
        } else {
          setTokenError(data.error || 'Invalid or expired reset link.')
        }
      } catch (err) {
        setTokenError('Failed to validate reset link. Please try again.')
      } finally {
        setValidating(false)
      }
    }

    validateToken()
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setErrors([])
    setLoading(true)

    // Client-side validation
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      setLoading(false)
      return
    }

    if (password.length < 12) {
      setError('Password must be at least 12 characters long.')
      setLoading(false)
      return
    }

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          password,
          confirmPassword,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        if (data.details && Array.isArray(data.details)) {
          setErrors(data.details)
        }
        setError(data.error || 'Failed to reset password.')
        setLoading(false)
        return
      }

      setSuccess(true)
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Loading state while validating token
  if (validating) {
    return (
      <div className="flex-1 min-h-0 bg-background flex flex-col">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col items-center justify-center space-y-4">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  <p className="text-muted-foreground">Validating reset link...</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  // Invalid token state
  if (!tokenValid) {
    return (
      <div className="flex-1 min-h-0 bg-background flex flex-col">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <Card>
              <CardHeader className="text-center">
                <div className="mx-auto mb-4 w-12 h-12 bg-destructive-visible rounded-full flex items-center justify-center">
                  <XCircle className="w-6 h-6 text-destructive" />
                </div>
                <CardTitle>Invalid Reset Link</CardTitle>
                <CardDescription className="mt-2">
                  {tokenError}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="bg-muted p-4 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Reset links expire after <strong>15 minutes</strong> for security.
                    If your link has expired, please request a new one.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Link href="/forgot-password" className="w-full">
                    <Button variant="default" className="w-full">
                      Request New Reset Link
                    </Button>
                  </Link>
                  <Link href="/login" className="w-full">
                    <Button variant="ghost" className="w-full">
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back to Login
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  // Success state
  if (success) {
    return (
      <div className="flex-1 min-h-0 bg-background flex flex-col">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <Card>
              <CardHeader className="text-center">
                <div className="mx-auto mb-4 w-12 h-12 bg-success-visible rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-success" />
                </div>
                <CardTitle>Password Reset Successfully</CardTitle>
                <CardDescription className="mt-2">
                  Your password has been changed. You can now log in with your new password.
                </CardDescription>
              </CardHeader>

              <CardContent>
                <div className="bg-muted p-4 rounded-lg mb-4">
                  <p className="text-sm text-muted-foreground">
                    <strong>Security Notice:</strong> All your existing sessions have been logged out
                    for security purposes.
                  </p>
                </div>

                <Link href="/login" className="w-full">
                  <Button variant="default" className="w-full">
                    Continue to Login
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  // Reset password form
  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="w-5 h-5" />
                Reset Password
              </CardTitle>
              <CardDescription>
                Choose a strong password for your account.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="p-3 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
                    <p className="text-sm text-destructive font-medium">{error}</p>
                    {errors.length > 0 && (
                      <ul className="mt-2 text-sm text-destructive list-disc list-inside">
                        {errors.map((err, idx) => (
                          <li key={idx}>{err}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="password">New Password</Label>
                  <PasswordInput
                    id="password"
                    placeholder="Enter your new password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    autoFocus
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm New Password</Label>
                  <PasswordInput
                    id="confirmPassword"
                    placeholder="Confirm your new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    disabled={loading}
                  />
                </div>

                <div className="bg-muted p-3 rounded-lg">
                  <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Password Requirements
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li className={password.length >= 12 ? 'text-success' : ''}>
                      • At least 12 characters
                    </li>
                    <li className={/[A-Z]/.test(password) ? 'text-success' : ''}>
                      • One uppercase letter
                    </li>
                    <li className={/[a-z]/.test(password) ? 'text-success' : ''}>
                      • One lowercase letter
                    </li>
                    <li className={/[0-9]/.test(password) ? 'text-success' : ''}>
                      • One number
                    </li>
                    <li className={/[^A-Za-z0-9]/.test(password) ? 'text-success' : ''}>
                      • One special character (!@#$%^&*)
                    </li>
                  </ul>
                </div>

                <Button
                  type="submit"
                  variant="default"
                  size="default"
                  className="w-full"
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Resetting Password...
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4 mr-2" />
                      Reset Password
                    </>
                  )}
                </Button>

                <div className="text-center">
                  <Link
                    href="/login"
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    <ArrowLeft className="w-3 h-3 inline mr-1" />
                    Back to Login
                  </Link>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          </div>
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  )
}

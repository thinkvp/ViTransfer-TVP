'use client'

import { useCallback, useMemo, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Eye, EyeOff, RefreshCw, Copy, Check, Plus, X, Mail, AlertCircle } from 'lucide-react'
import { apiPost, apiFetch } from '@/lib/api-client'
import { SharePasswordRequirements } from '@/components/SharePasswordRequirements'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { RecipientsEditor, type EditableRecipient } from '@/components/RecipientsEditor'

// Client-safe password generation using Web Crypto API
function generateSecurePassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const numbers = '23456789'
  const special = '!@#$%'
  const all = letters + numbers + special

  const getRandomInt = (max: number) => {
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    return array[0] % max
  }

  let password = ''
  password += letters.charAt(getRandomInt(letters.length))
  password += numbers.charAt(getRandomInt(numbers.length))

  for (let i = 2; i < 12; i++) {
    password += all.charAt(getRandomInt(all.length))
  }

  // Fisher-Yates shuffle
  const chars = password.split('')
  for (let i = chars.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}

export default function NewProjectPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const permissions = normalizeRolePermissions(user?.permissions)
  const canCreateProject = canDoAction(permissions, 'changeProjectSettings')
  const [loading, setLoading] = useState(false)
  const [passwordProtected, setPasswordProtected] = useState(true)
  const [sharePassword, setSharePassword] = useState('')
  const [showPassword, setShowPassword] = useState(true)
  const [copied, setCopied] = useState(false)

  // Authentication mode
  const [authMode, setAuthMode] = useState<'PASSWORD' | 'OTP' | 'BOTH'>('PASSWORD')
  const [smtpConfigured, setSmtpConfigured] = useState(false)
  const [companyNameValue, setCompanyNameValue] = useState('')
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [clientSuggestions, setClientSuggestions] = useState<Array<{ id: string; name: string; recipients?: any[] }>>([])
  const [clientsLoading, setClientsLoading] = useState(false)
  const [recipients, setRecipients] = useState<EditableRecipient[]>([])

  const isForbidden = !authLoading && user && !canCreateProject

  const checkSmtpConfiguration = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        // Settings API now includes smtpConfigured field using isSmtpConfigured() helper
        setSmtpConfigured(data.smtpConfigured !== false)
      }
    } catch (err) {
      console.error('Failed to check SMTP configuration:', err)
    }
  }, [])

  // Generate password on mount
  useEffect(() => {
    setSharePassword(generateSecurePassword())
    checkSmtpConfiguration()
  }, [checkSmtpConfiguration])

  const hasAnyRecipientEmail = useMemo(() => {
    return recipients.some((r) => (r.email || '').trim().includes('@'))
  }, [recipients])

  const canUseOTP = smtpConfigured && hasAnyRecipientEmail
  const showOTPRecommendation = hasAnyRecipientEmail && smtpConfigured && authMode === 'PASSWORD'

  function normalizeEmail(email: string | null | undefined) {
    return (email || '').trim().toLowerCase()
  }

  function ensurePrimary(next: EditableRecipient[]) {
    if (next.length === 0) return next
    const primaryCount = next.filter((r) => r.isPrimary).length
    if (primaryCount === 1) return next
    return next.map((r, idx) => ({ ...r, isPrimary: idx === 0 }))
  }

  const loadClientSuggestions = useCallback(async (query: string) => {
    const q = query.trim()
    if (!q) {
      setClientSuggestions([])
      setClientsLoading(false)
      return
    }

    setClientsLoading(true)
    try {
      const res = await apiFetch(`/api/clients?query=${encodeURIComponent(q)}&includeRecipients=1`)
      if (!res.ok) {
        setClientSuggestions([])
        return
      }
      const data = await res.json()
      setClientSuggestions((data?.clients || []) as any[])
    } catch {
      setClientSuggestions([])
    } finally {
      setClientsLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => {
      void loadClientSuggestions(companyNameValue)
    }, 200)
    return () => clearTimeout(handle)
  }, [companyNameValue, loadClientSuggestions])

  function handleGeneratePassword() {
    setSharePassword(generateSecurePassword())
    setCopied(false)
  }

  function handleCopyPassword() {
    navigator.clipboard.writeText(sharePassword)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)

    const formData = new FormData(e.currentTarget)
    const data = {
      title: formData.get('title') as string,
      description: formData.get('description') as string,
      companyName: companyNameValue,
      clientId: selectedClientId,
      recipients: recipients.map((r) => ({
        name: r.name?.trim() ? r.name.trim() : null,
        email: r.email?.trim() ? r.email.trim() : null,
        isPrimary: Boolean(r.isPrimary),
        receiveNotifications: Boolean(r.receiveNotifications),
      })),
      sharePassword: (authMode === 'PASSWORD' || authMode === 'BOTH') && passwordProtected ? sharePassword : '',
      authMode: passwordProtected ? authMode : 'NONE',
    }

    try {
      const project = await apiPost('/api/projects', data)
      router.push(`/admin/projects/${project.id}`)
    } catch (error) {
      alert('Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  const needsPassword = authMode === 'PASSWORD' || authMode === 'BOTH'

  if (isForbidden) {
    return (
      <div className="flex-1 min-h-0 bg-background">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
          <Card>
            <CardHeader>
              <CardTitle>New Project</CardTitle>
              <CardDescription>Forbidden</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">You don&apos;t have permission to create projects.</p>
              <div className="mt-4">
                <Button variant="outline" onClick={() => router.push('/admin/projects')}>Back to Projects</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Create New Project</CardTitle>
            <CardDescription>Set up a new video project for your client</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Project Title</Label>
                <Input
                  id="title"
                  name="title"
                  placeholder="e.g., Video Project - Client Name"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="e.g., Project details, deliverables, notes..."
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="companyName">Company/Brand Name (Optional)</Label>
                <div className="relative">
                  <Input
                    id="companyName"
                    name="companyName"
                    placeholder="e.g., XYZ Corporation"
                    maxLength={100}
                    value={companyNameValue}
                    onChange={(e) => {
                      const next = e.target.value
                      setCompanyNameValue(next)
                      setSelectedClientId(null)
                    }}
                    autoComplete="off"
                  />

                  {clientSuggestions.length > 0 && !selectedClientId && (
                    <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-sm overflow-hidden">
                      {clientSuggestions.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40"
                          onClick={() => {
                            setSelectedClientId(c.id)
                            setCompanyNameValue(c.name)
                            setClientSuggestions([])

                            const clientRecipients = Array.isArray((c as any).recipients) ? (c as any).recipients : []
                            if (clientRecipients.length > 0) {
                              setRecipients((prev) => {
                                const existingEmails = new Set(prev.map((r) => normalizeEmail(r.email)))
                                const merged: EditableRecipient[] = [...prev]

                                for (const r of clientRecipients) {
                                  const email = normalizeEmail(r?.email)
                                  if (email && existingEmails.has(email)) continue

                                  merged.push({
                                    name: r?.name ?? null,
                                    email: r?.email ?? null,
                                    isPrimary: Boolean(r?.isPrimary),
                                    receiveNotifications: r?.receiveNotifications !== false,
                                  })

                                  if (email) existingEmails.add(email)
                                }

                                return ensurePrimary(merged)
                              })
                            }
                          }}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Start typing to match existing Clients.
                  {clientsLoading ? ' Searching…' : ''}
                </p>
              </div>

              <div className="border rounded-lg p-4 bg-card">
                <RecipientsEditor
                  label="Recipients"
                  description="Manage who receives notifications and updates"
                  value={recipients}
                  onChange={setRecipients}
                  addButtonLabel="Add Recipient"
                />
              </div>

              {/* Authentication Section */}
              <div className="space-y-4 border rounded-lg p-4 bg-primary-visible border-2 border-primary-visible">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="passwordProtected" className="text-base font-semibold">
                      Require Authentication (Recommended)
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Secure by default. Clients must authenticate (password, email OTP, or both) to view and approve the project.
                    </p>
                  </div>
                  <input
                    id="passwordProtected"
                    type="checkbox"
                    checked={passwordProtected}
                    onChange={(e) => setPasswordProtected(e.target.checked)}
                    className="h-5 w-5 rounded border-border text-primary focus:ring-primary mt-1"
                  />
                </div>

                {passwordProtected && (
                  <div className="space-y-4 pt-2 border-t">
                    {/* Authentication Method Selection */}
                    <div className="space-y-2">
                      <Label htmlFor="authMode">Authentication Method</Label>
                      <select
                        id="authMode"
                        value={authMode}
                        onChange={(e) => setAuthMode(e.target.value as any)}
                        className="w-full px-3 py-2 bg-card border border-border rounded-md"
                      >
                        <option value="PASSWORD">Password Only</option>
                        <option value="OTP" disabled={!canUseOTP}>
                          Email OTP Only {!canUseOTP ? '(requires SMTP & client email)' : ''}
                        </option>
                        <option value="BOTH" disabled={!canUseOTP}>
                          Both Password and OTP {!canUseOTP ? '(requires SMTP & client email)' : ''}
                        </option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {authMode === 'PASSWORD' && 'Clients must enter a password to access the project'}
                        {authMode === 'OTP' && 'Clients receive a one-time code via email (must be a registered recipient)'}
                        {authMode === 'BOTH' && 'Clients can choose between password or email OTP authentication'}
                      </p>

                      {/* Smart Recommendation */}
                      {showOTPRecommendation && (
                        <div className="flex items-start gap-2 p-3 bg-muted border border-border rounded-md">
                          <Mail className="w-4 h-4 text-primary mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm font-medium">Consider Email OTP</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              You&apos;ve provided a client email. Email OTP provides seamless authentication without sharing passwords.
                            </p>
                            <div className="flex gap-2 mt-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setAuthMode('OTP')}
                              >
                                OTP Only
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setAuthMode('BOTH')}
                              >
                                Both Password + OTP
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      {!smtpConfigured && (
                        <div className="flex items-start gap-2 p-3 bg-warning-visible border border-warning-visible rounded-md">
                          <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
                          <p className="text-xs text-warning">
                            Configure SMTP in Settings to enable OTP authentication options
                          </p>
                        </div>
                      )}

                      {smtpConfigured && !hasAnyRecipientEmail && authMode !== 'PASSWORD' && (
                        <div className="flex items-start gap-2 p-3 bg-warning-visible border border-warning-visible rounded-md">
                          <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
                          <p className="text-xs text-warning">
                            Add a recipient email address above to use OTP authentication
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Password Field (conditional) */}
                    {needsPassword && (
                      <div className="space-y-3">
                        <Label htmlFor="sharePassword">Share Password</Label>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Input
                              id="sharePassword"
                              value={sharePassword}
                              onChange={(e) => setSharePassword(e.target.value)}
                              type={showPassword ? 'text' : 'password'}
                              className="pr-10 font-mono"
                              required={needsPassword}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={handleGeneratePassword}
                            title="Generate new password"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={handleCopyPassword}
                            title="Copy password"
                          >
                            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                        {sharePassword && (
                          <SharePasswordRequirements password={sharePassword} />
                        )}
                        <p className="text-xs text-muted-foreground">
                          <strong className="text-warning">Important:</strong> Save this password!
                          You&apos;ll need to share it with your client so they can view and approve the project.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {!passwordProtected && (
                  <div className="flex items-start gap-2 p-3 bg-warning-visible border-2 border-warning-visible rounded-md">
                    <span className="text-warning text-sm font-bold">!</span>
                    <p className="text-sm text-warning font-medium">
                      Without authentication, anyone with the share link can view and approve your project. Not recommended for sensitive content.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  <strong>Note:</strong> Additional options like revision tracking, comment restrictions, and feedback settings can be configured after project creation in Project Settings.
                </p>
              </div>

              <div className="flex gap-3 pt-4">
                <Button type="submit" variant="default" size="lg" disabled={loading}>
                  <Plus className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">{loading ? 'Creating...' : 'Create Project'}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => router.push('/admin/projects')}
                  disabled={loading}
                >
                  <X className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">Cancel</span>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  )
}

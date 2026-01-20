'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { X, Save, RefreshCw, Eye, EyeOff, Copy, Check, Fingerprint, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordRequirements } from '@/components/PasswordRequirements'
import { apiPatch, apiPost, apiDelete, apiFetch } from '@/lib/api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/components/AuthProvider'
import { startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

interface Role {
  id: string
  name: string
  isSystemAdmin: boolean
}

export default function EditUserPage() {
  const router = useRouter()
  const params = useParams()
  const userId = params?.id as string
  const { user: sessionUser } = useAuth()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [copied, setCopied] = useState(false)
  const [formData, setFormData] = useState({
    email: '',
    username: '',
    name: '',
    displayColor: '#22C55E',
    appRoleId: 'role_admin',
    oldPassword: '',
    password: '',
    confirmPassword: '',
  })

  const [roles, setRoles] = useState<Role[]>([])
  const [rolesLoading, setRolesLoading] = useState(true)

  // PassKey state
  const [passkeyAvailable, setPasskeyAvailable] = useState(false)
  const [passkeyReason, setPasskeyReason] = useState('')
  const [passkeys, setPasskeys] = useState<any[]>([])
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [passkeyError, setPasskeyError] = useState('')

  const fetchUser = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/users/${userId}`)
      if (!res.ok) throw new Error('Failed to fetch user')
      const data = await res.json()
      setCurrentUser(data.user)
      setFormData({
        email: data.user.email,
        username: data.user.username || '',
        name: data.user.name || '',
        displayColor: data.user.displayColor || '#22C55E',
        appRoleId: data.user.appRoleId || 'role_admin',
        oldPassword: '',
        password: '',
        confirmPassword: '',
      })
    } catch (err: any) {
      setError(err.message)
    }
  }, [userId])

  useEffect(() => {
    fetchUser()
    fetchPasskeyStatus()
    fetchPasskeys()
  }, [fetchUser])

  useEffect(() => {
    const loadRoles = async () => {
      try {
        const res = await apiFetch('/api/roles')
        if (!res.ok) throw new Error('Failed to fetch roles')
        const data = await res.json()
        setRoles((data.roles || []) as Role[])
      } catch {
        // ignore
      } finally {
        setRolesLoading(false)
      }
    }
    void loadRoles()
  }, [])

  const fetchPasskeyStatus = async () => {
    try {
      const res = await apiFetch('/api/auth/passkey/status')
      if (res.ok) {
        const data = await res.json()
        setPasskeyAvailable(data.available)
        setPasskeyReason(data.reason || '')
      }
    } catch (err) {
      // Silently fail - passkey is optional
    }
  }

  const fetchPasskeys = async () => {
    try {
      const res = await apiFetch('/api/auth/passkey/list')
      if (res.ok) {
        const data = await res.json()
        setPasskeys(data.passkeys || [])
      }
    } catch (err) {
      // Silently fail
    }
  }

  const handleRegisterPasskey = async () => {
    setPasskeyError('')
    setPasskeyLoading(true)

    try {
      // Get registration options
      const options: PublicKeyCredentialCreationOptionsJSON = await apiPost('/api/auth/passkey/register/options', {})

      // Start WebAuthn ceremony
      const attestation = await startRegistration({ optionsJSON: options })

      // Verify registration
      await apiPost('/api/auth/passkey/register/verify', attestation)

      // Refresh passkey list
      await fetchPasskeys()
    } catch (err: any) {
      // Log full error for debugging
      console.error('[PASSKEY] Registration error:', err)

      // Show generic errors to prevent information disclosure
      if (err.name === 'NotAllowedError') {
        setPasskeyError('Cancelled or timed out')
      } else if (err.name === 'InvalidStateError') {
        setPasskeyError('This authenticator is already registered')
      } else {
        setPasskeyError('Failed to register PassKey. Please check your configuration.')
      }
    } finally {
      setPasskeyLoading(false)
    }
  }

  const handleDeletePasskey = async (id: string) => {
    if (!confirm('Delete this PassKey?')) return

    setPasskeyError('')
    try {
      await apiDelete(`/api/auth/passkey/${id}`)
      await fetchPasskeys()
    } catch (err: any) {
      setPasskeyError(err.message)
    }
  }

  const generateRandomPassword = () => {
    // Generate a random password with at least 16 characters
    const length = 16
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const lowercase = 'abcdefghijklmnopqrstuvwxyz'
    const numbers = '0123456789'
    const special = '!@#$%^&*'
    const all = uppercase + lowercase + numbers + special

    // Helper function for cryptographically secure random int
    const getRandomInt = (max: number) => {
      const array = new Uint32Array(1)
      crypto.getRandomValues(array)
      return array[0] % max
    }

    // Ensure at least one of each type
    let password = ''
    password += uppercase[getRandomInt(uppercase.length)]
    password += lowercase[getRandomInt(lowercase.length)]
    password += numbers[getRandomInt(numbers.length)]
    password += special[getRandomInt(special.length)]

    // Fill the rest randomly
    for (let i = password.length; i < length; i++) {
      password += all[getRandomInt(all.length)]
    }

    // Shuffle the password using Fisher-Yates
    const chars = password.split('')
    for (let i = chars.length - 1; i > 0; i--) {
      const j = getRandomInt(i + 1)
      ;[chars[i], chars[j]] = [chars[j], chars[i]]
    }
    password = chars.join('')

    setFormData({
      ...formData,
      password,
      confirmPassword: password,
    })

    // Automatically show password when generated so user can see/copy it
    setShowPassword(true)
    setShowConfirmPassword(true)
  }

  const copyPassword = async () => {
    if (formData.password) {
      await navigator.clipboard.writeText(formData.password)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const isEditingSelf = sessionUser?.id === userId
    const canAdminResetPassword = !isEditingSelf && sessionUser?.isSystemAdmin === true

    // Validation
    if (formData.password && formData.password !== formData.confirmPassword) {
      setError('Passwords do not match')
      return
    }

    // If changing your own password, current password is required.
    // Admins can reset another user's password without their current password.
    if (formData.password && isEditingSelf && !formData.oldPassword) {
      setError('Current password is required to set a new password')
      return
    }
    if (formData.password && !isEditingSelf && !canAdminResetPassword) {
      setError('Only an Admin can reset another user\'s password')
      return
    }

    // Password validation will be done by the API using the passwordSchema
    // which requires 12+ chars, uppercase, lowercase, number, and special char

    setLoading(true)

    try {
      const updateData: any = {
        email: formData.email,
        username: formData.username || null,
        name: formData.name || null,
        displayColor: formData.displayColor || null,
        appRoleId: formData.appRoleId,
      }

      // Only include password if it's being changed
      if (formData.password) {
        if (isEditingSelf) {
          updateData.oldPassword = formData.oldPassword
        }
        updateData.password = formData.password
      }

      // Update user
      await apiPatch(`/api/users/${userId}`, updateData)

      router.push('/admin/users')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6 overflow-hidden">
      <div className="max-w-2xl mx-auto w-full min-w-0">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">Edit User</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">Update user account details</p>
        </div>

        <Card className="w-full min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>User Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                key={rolesLoading ? 'roles-loading' : 'roles-loaded'}
                value={formData.appRoleId}
                onValueChange={(value) => setFormData({ ...formData, appRoleId: value })}
                disabled={rolesLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={rolesLoading ? 'Loading roles…' : 'Select a role'} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayColor">Display Colour</Label>
              <div className="flex items-center gap-3">
                <input
                  id="displayColor"
                  type="color"
                  value={formData.displayColor}
                  onChange={(e) => setFormData({ ...formData, displayColor: e.target.value })}
                  className="h-10 w-14 rounded-md border border-input bg-background p-1"
                  aria-label="Display colour"
                />
                <Input
                  type="text"
                  value={formData.displayColor}
                  onChange={(e) => setFormData({ ...formData, displayColor: e.target.value })}
                  placeholder="#RRGGBB"
                  className="max-w-[140px]"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Used for this admin’s comment highlight and timeline markers.
              </p>
            </div>

            <div className="border-t pt-4 mt-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium">Change Password (optional)</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    {sessionUser?.id === userId
                      ? 'Leave blank to keep current password'
                      : sessionUser?.isSystemAdmin
                        ? 'Set a new password for this user (they will need to log in again)'
                        : 'Password can only be changed by the account owner'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={generateRandomPassword}
                  className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span className="sm:hidden">Generate</span>
                  <span className="hidden sm:inline">Generate Password</span>
                </Button>
              </div>

              {sessionUser?.id === userId && (
                <div className="space-y-2">
                  <Label htmlFor="oldPassword">Current Password</Label>
                  <Input
                    id="oldPassword"
                    type="password"
                    value={formData.oldPassword}
                    onChange={(e) => setFormData({ ...formData, oldPassword: e.target.value })}
                    placeholder="Required to change password"
                  />
                </div>
              )}

              <div className="space-y-2 mt-3">
                <Label htmlFor="password">New Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="Leave blank to keep current"
                    className="pr-20"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                    {formData.password && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={copyPassword}
                        className="h-7 w-7 p-0"
                        title="Copy password"
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowPassword(!showPassword)}
                      className="h-7 w-7 p-0"
                      title={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {formData.password && (
                  <PasswordRequirements password={formData.password} className="mt-3" />
                )}
              </div>

              <div className="space-y-2 mt-3">
                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? "text" : "password"}
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    placeholder="Leave blank to keep current"
                    className="pr-10"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="h-7 w-7 p-0"
                      title={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {formData.password && formData.confirmPassword && formData.password !== formData.confirmPassword && (
                  <p className="text-sm text-destructive flex items-center gap-1">
                    <X className="w-4 h-4" /> Passwords do not match
                  </p>
                )}
                {formData.password && formData.confirmPassword && formData.password === formData.confirmPassword && formData.password.length > 0 && (
                  <p className="text-sm text-success flex items-center gap-1">
                    <Check className="w-4 h-4" /> Passwords match
                  </p>
                )}
              </div>
            </div>

            {/* PassKey Section */}
            <div className="border-t pt-4 mt-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Fingerprint className="w-4 h-4" />
                    PassKey Authentication
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Passwordless login using biometrics or security keys
                  </p>
                </div>
              </div>

              {!passkeyAvailable ? (
                <div className="bg-muted border border-border rounded p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <div className="text-sm">
                    <p className="font-medium">Not Available</p>
                    <p className="text-xs text-muted-foreground mt-1">{passkeyReason}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {passkeyError && (
                    <div className="bg-destructive-visible border-2 border-destructive-visible text-destructive font-medium px-3 py-2 rounded text-sm">
                      {passkeyError}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-muted p-3 rounded">
                    <div className="text-sm min-w-0 flex-1">
                      <p className="font-medium">
                        {passkeys.length === 0 ? 'No passkeys registered' : `${passkeys.length} passkey(s)`}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {passkeys.length === 0 ? 'Register your first passkey' : 'Manage your passkeys'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto flex-shrink-0"
                      onClick={handleRegisterPasskey}
                      disabled={passkeyLoading}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add PassKey
                    </Button>
                  </div>

                  {passkeys.length > 0 && (
                    <div className="space-y-2">
                      {passkeys.map((pk: any) => (
                        <div key={pk.id} className="flex items-center justify-between bg-card border p-3 rounded">
                          <div className="text-sm">
                            <p className="font-medium">{pk.credentialName || 'Unnamed PassKey'}</p>
                            <p className="text-xs text-muted-foreground">
                              {pk.deviceType === 'multiDevice' ? 'Multi-device' : 'Single device'} •
                              Last used: {new Date(pk.lastUsedAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeletePasskey(pk.id)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-4 w-full sm:justify-end">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="flex-1 sm:flex-none"
                onClick={() => router.push('/admin/users')}
                disabled={loading}
              >
                <X className="w-4 h-4 mr-2" />
                <span>Cancel</span>
              </Button>
              <Button type="submit" variant="default" size="lg" className="flex-1 sm:flex-none" disabled={loading}>
                <Save className="w-4 h-4 mr-2" />
                <span>{loading ? 'Saving...' : 'Save Changes'}</span>
              </Button>
            </div>
          </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

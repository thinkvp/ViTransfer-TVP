import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface CompanyBrandingSectionProps {
  companyName: string
  setCompanyName: (value: string) => void
  companyLogoMode: 'NONE' | 'UPLOAD' | 'LINK'
  setCompanyLogoMode: (value: 'NONE' | 'UPLOAD' | 'LINK') => void
  companyLogoLinkUrl: string
  setCompanyLogoLinkUrl: (value: string) => void
  companyLogoConfigured: boolean
  companyLogoUrl: string | null
  onCompanyLogoUploaded: () => void
  darkLogoEnabled: boolean
  setDarkLogoEnabled: (value: boolean) => void
  darkLogoMode: 'NONE' | 'UPLOAD' | 'LINK'
  setDarkLogoMode: (value: 'NONE' | 'UPLOAD' | 'LINK') => void
  darkLogoLinkUrl: string
  setDarkLogoLinkUrl: (value: string) => void
  darkLogoConfigured: boolean
  darkLogoUrl: string | null
  onDarkLogoUploaded: () => void
  companyFaviconMode: 'NONE' | 'UPLOAD' | 'LINK'
  setCompanyFaviconMode: (value: 'NONE' | 'UPLOAD' | 'LINK') => void
  companyFaviconLinkUrl: string
  setCompanyFaviconLinkUrl: (value: string) => void
  companyFaviconConfigured: boolean
  companyFaviconUrl: string | null
  onCompanyFaviconUploaded: () => void
  accentColor: string
  setAccentColor: (value: string) => void
  show: boolean
  setShow: (value: boolean) => void
}

const COMPANY_LOGO_MAX_WIDTH = 800
const COMPANY_LOGO_MAX_HEIGHT = 800

const FAVICON_MAX_WIDTH = 512
const FAVICON_MAX_HEIGHT = 512

export function CompanyBrandingSection({
  companyName,
  setCompanyName,
  companyLogoMode,
  setCompanyLogoMode,
  companyLogoLinkUrl,
  setCompanyLogoLinkUrl,
  companyLogoConfigured,
  companyLogoUrl,
  onCompanyLogoUploaded,
  darkLogoEnabled,
  setDarkLogoEnabled,
  darkLogoMode,
  setDarkLogoMode,
  darkLogoLinkUrl,
  setDarkLogoLinkUrl,
  darkLogoConfigured,
  darkLogoUrl,
  onDarkLogoUploaded,
  companyFaviconMode,
  setCompanyFaviconMode,
  companyFaviconLinkUrl,
  setCompanyFaviconLinkUrl,
  companyFaviconConfigured,
  companyFaviconUrl,
  onCompanyFaviconUploaded,
  accentColor,
  setAccentColor,
  show,
  setShow,
}: CompanyBrandingSectionProps) {
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [logoSuccess, setLogoSuccess] = useState<string | null>(null)

  const [darkLogoUploading, setDarkLogoUploading] = useState(false)
  const [darkLogoError, setDarkLogoError] = useState<string | null>(null)
  const [darkLogoSuccess, setDarkLogoSuccess] = useState<string | null>(null)

  const [faviconUploading, setFaviconUploading] = useState(false)
  const [faviconError, setFaviconError] = useState<string | null>(null)
  const [faviconSuccess, setFaviconSuccess] = useState<string | null>(null)

  const logoHelpText = useMemo(() => {
    return `This logo will be displayed on email communications. You can test it using “Send Test Email” in the SMTP settings section.`
  }, [])

  const uploadHelpText = useMemo(() => {
    return `Upload a PNG or JPG logo (max: ${COMPANY_LOGO_MAX_WIDTH}x${COMPANY_LOGO_MAX_HEIGHT}px).`
  }, [])

  const linkHelpText = useMemo(() => {
    return `Link directly to a PNG or JPG image (max: ${COMPANY_LOGO_MAX_WIDTH}x${COMPANY_LOGO_MAX_HEIGHT}px, <= 2MB). Use an https:// URL that is publicly accessible.`
  }, [])

  const faviconHelpText = useMemo(() => {
    return `This favicon will be used by browsers for the tab icon.`
  }, [])

  const faviconUploadHelpText = useMemo(() => {
    return `Upload a PNG favicon (max: ${FAVICON_MAX_WIDTH}x${FAVICON_MAX_HEIGHT}px).`
  }, [])

  const faviconLinkHelpText = useMemo(() => {
    return `Link directly to a PNG favicon (max: ${FAVICON_MAX_WIDTH}x${FAVICON_MAX_HEIGHT}px, <= 512KB). Use an https:// URL that is publicly accessible.`
  }, [])

  async function validateDimensions(file: File): Promise<{ ok: boolean; error?: string }> {
    try {
      const objectUrl = URL.createObjectURL(file)
      try {
        const img = new Image()
        const loaded = await new Promise<boolean>((resolve) => {
          img.onload = () => resolve(true)
          img.onerror = () => resolve(false)
          img.src = objectUrl
        })
        if (!loaded) return { ok: false, error: 'Unable to read image. Please upload a valid PNG or JPG.' }
        if (img.naturalWidth > COMPANY_LOGO_MAX_WIDTH || img.naturalHeight > COMPANY_LOGO_MAX_HEIGHT) {
          return { ok: false, error: `Invalid logo resolution. Max allowed: ${COMPANY_LOGO_MAX_WIDTH}x${COMPANY_LOGO_MAX_HEIGHT}px.` }
        }
        return { ok: true }
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    } catch {
      return { ok: false, error: 'Unable to validate image. Please try again.' }
    }
  }

  async function handleLogoSelected(file: File | null) {
    setLogoError(null)
    setLogoSuccess(null)
    if (!file) return

    const type = (file.type || '').toLowerCase()
    if (type !== 'image/png' && type !== 'image/jpeg') {
      setLogoError('Invalid file type. Please upload a PNG or JPG.')
      return
    }

    const dimCheck = await validateDimensions(file)
    if (!dimCheck.ok) {
      setLogoError(dimCheck.error || 'Invalid image dimensions.')
      return
    }

    try {
      setLogoUploading(true)
      const formData = new FormData()
      formData.append('file', file)

      const response = await apiFetch('/api/settings/company-logo', {
        method: 'POST',
        body: formData,
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setLogoError(data?.error || 'Failed to upload logo')
        return
      }

      setLogoSuccess('Logo uploaded successfully.')
      onCompanyLogoUploaded()
    } catch {
      setLogoError('Failed to upload logo')
    } finally {
      setLogoUploading(false)
    }
  }

  async function handleDarkLogoSelected(file: File | null) {
    setDarkLogoError(null)
    setDarkLogoSuccess(null)
    if (!file) return

    const type = (file.type || '').toLowerCase()
    if (type !== 'image/png' && type !== 'image/jpeg') {
      setDarkLogoError('Invalid file type. Please upload a PNG or JPG.')
      return
    }

    const dimCheck = await validateDimensions(file)
    if (!dimCheck.ok) {
      setDarkLogoError(dimCheck.error || 'Invalid image dimensions.')
      return
    }

    try {
      setDarkLogoUploading(true)
      const formData = new FormData()
      formData.append('file', file)

      const response = await apiFetch('/api/settings/dark-logo', {
        method: 'POST',
        body: formData,
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setDarkLogoError(data?.error || 'Failed to upload dark logo')
        return
      }

      setDarkLogoSuccess('Dark logo uploaded successfully.')
      onDarkLogoUploaded()
    } catch {
      setDarkLogoError('Failed to upload dark logo')
    } finally {
      setDarkLogoUploading(false)
    }
  }

  async function validateFaviconDimensions(file: File): Promise<{ ok: boolean; error?: string }> {
    try {
      const objectUrl = URL.createObjectURL(file)
      try {
        const img = new Image()
        const loaded = await new Promise<boolean>((resolve) => {
          img.onload = () => resolve(true)
          img.onerror = () => resolve(false)
          img.src = objectUrl
        })
        if (!loaded) return { ok: false, error: 'Unable to read image. Please upload a valid PNG.' }
        if (img.naturalWidth > FAVICON_MAX_WIDTH || img.naturalHeight > FAVICON_MAX_HEIGHT) {
          return { ok: false, error: `Invalid favicon resolution. Max allowed: ${FAVICON_MAX_WIDTH}x${FAVICON_MAX_HEIGHT}px.` }
        }
        return { ok: true }
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    } catch {
      return { ok: false, error: 'Unable to validate image. Please try again.' }
    }
  }

  async function handleFaviconSelected(file: File | null) {
    setFaviconError(null)
    setFaviconSuccess(null)
    if (!file) return

    const type = (file.type || '').toLowerCase()
    if (type !== 'image/png') {
      setFaviconError('Invalid file type. Please upload a PNG.')
      return
    }

    const dimCheck = await validateFaviconDimensions(file)
    if (!dimCheck.ok) {
      setFaviconError(dimCheck.error || 'Invalid image dimensions.')
      return
    }

    try {
      setFaviconUploading(true)
      const formData = new FormData()
      formData.append('file', file)

      const response = await apiFetch('/api/settings/company-favicon', {
        method: 'POST',
        body: formData,
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setFaviconError(data?.error || 'Failed to upload favicon')
        return
      }

      setFaviconSuccess('Favicon uploaded successfully.')
      onCompanyFaviconUploaded()
    } catch {
      setFaviconError('Failed to upload favicon')
    } finally {
      setFaviconUploading(false)
    }
  }

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Company Branding</CardTitle>
            <CardDescription>
              Customize how your company appears in the application
            </CardDescription>
          </div>
          {show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>

      {show && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <Label htmlFor="companyName">Company Name</Label>
            <Input
              id="companyName"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g., Studio, Your Company Name"
            />
            <p className="text-xs text-muted-foreground">
              This name will be displayed in feedback messages and comments instead of &quot;Studio&quot;
            </p>

            <div className="pt-3 border-t space-y-2">
              <Label htmlFor="companyLogo">Company Logo</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={companyLogoMode}
                onChange={(e) => {
                  setLogoError(null)
                  setLogoSuccess(null)
                  const value = e.target.value
                  if (value === 'NONE' || value === 'UPLOAD' || value === 'LINK') {
                    setCompanyLogoMode(value)
                  }
                }}
              >
                <option value="NONE">None</option>
                <option value="UPLOAD">Upload</option>
                <option value="LINK">Link</option>
              </select>
              <p className="text-xs text-muted-foreground">{logoHelpText}</p>

              {companyLogoMode === 'UPLOAD' ? (
                <div className="space-y-2">
                  <Input
                    id="companyLogo"
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={logoUploading}
                    onChange={(e) => handleLogoSelected(e.target.files?.[0] || null)}
                  />
                  <p className="text-xs text-muted-foreground">{uploadHelpText}</p>
                </div>
              ) : null}

              {companyLogoMode === 'LINK' ? (
                <div className="space-y-2">
                  <Input
                    id="companyLogoLink"
                    type="url"
                    value={companyLogoLinkUrl}
                    onChange={(e) => setCompanyLogoLinkUrl(e.target.value)}
                    placeholder="https://example.com/logo.png"
                  />
                  <p className="text-xs text-muted-foreground">{linkHelpText}</p>
                </div>
              ) : null}

              {companyLogoMode !== 'NONE' && companyLogoUrl ? (
                <div className="mt-2 rounded-md border bg-background p-3">
                  <p className="text-xs text-muted-foreground mb-2">Current logo preview</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={companyLogoUrl}
                    alt="Company logo"
                    style={{ width: 'auto', height: 'auto', maxWidth: 300, maxHeight: 120 }}
                  />
                </div>
              ) : null}

              {logoError ? <p className="text-xs text-destructive">{logoError}</p> : null}
              {logoSuccess ? <p className="text-xs text-success">{logoSuccess}</p> : null}

              {companyLogoMode !== 'NONE' ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" disabled={logoUploading} onClick={() => onCompanyLogoUploaded()}>
                    Refresh Preview
                  </Button>
                  {logoUploading ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
                </div>
              ) : null}
            </div>

            <div className="pt-3 border-t space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="darkLogoToggle">Use separate Company Logo for Dark Mode</Label>
                <Switch
                  id="darkLogoToggle"
                  checked={darkLogoEnabled}
                  onCheckedChange={(checked) => {
                    setDarkLogoEnabled(checked)
                    setDarkLogoError(null)
                    setDarkLogoSuccess(null)
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, a separate logo will be used when the application is in dark mode. The Company Logo above will still be used for light mode and email communications.
              </p>

              {darkLogoEnabled ? (
                <>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={darkLogoMode}
                    onChange={(e) => {
                      setDarkLogoError(null)
                      setDarkLogoSuccess(null)
                      const value = e.target.value
                      if (value === 'NONE' || value === 'UPLOAD' || value === 'LINK') {
                        setDarkLogoMode(value)
                      }
                    }}
                  >
                    <option value="NONE">None</option>
                    <option value="UPLOAD">Upload</option>
                    <option value="LINK">Link</option>
                  </select>

                  {darkLogoMode === 'UPLOAD' ? (
                    <div className="space-y-2">
                      <Input
                        id="darkLogo"
                        type="file"
                        accept="image/png,image/jpeg"
                        disabled={darkLogoUploading}
                        onChange={(e) => handleDarkLogoSelected(e.target.files?.[0] || null)}
                      />
                      <p className="text-xs text-muted-foreground">{uploadHelpText}</p>
                    </div>
                  ) : null}

                  {darkLogoMode === 'LINK' ? (
                    <div className="space-y-2">
                      <Input
                        id="darkLogoLink"
                        type="url"
                        value={darkLogoLinkUrl}
                        onChange={(e) => setDarkLogoLinkUrl(e.target.value)}
                        placeholder="https://example.com/logo-dark.png"
                      />
                      <p className="text-xs text-muted-foreground">{linkHelpText}</p>
                    </div>
                  ) : null}

                  {darkLogoMode !== 'NONE' && darkLogoUrl ? (
                    <div className="mt-2 rounded-md border bg-background p-3 dark:bg-zinc-900">
                      <p className="text-xs text-muted-foreground mb-2">Dark logo preview</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={darkLogoUrl}
                        alt="Dark mode company logo"
                        style={{ width: 'auto', height: 'auto', maxWidth: 300, maxHeight: 120 }}
                      />
                    </div>
                  ) : null}

                  {darkLogoError ? <p className="text-xs text-destructive">{darkLogoError}</p> : null}
                  {darkLogoSuccess ? <p className="text-xs text-success">{darkLogoSuccess}</p> : null}

                  {darkLogoMode !== 'NONE' ? (
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="secondary" disabled={darkLogoUploading} onClick={() => onDarkLogoUploaded()}>
                        Refresh Preview
                      </Button>
                      {darkLogoUploading ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className="pt-3 border-t space-y-2">
              <Label htmlFor="companyFavicon">Favicon</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={companyFaviconMode}
                onChange={(e) => {
                  setFaviconError(null)
                  setFaviconSuccess(null)
                  const value = e.target.value
                  if (value === 'NONE' || value === 'UPLOAD' || value === 'LINK') {
                    setCompanyFaviconMode(value)
                  }
                }}
              >
                <option value="NONE">None</option>
                <option value="UPLOAD">Upload</option>
                <option value="LINK">Link</option>
              </select>
              <p className="text-xs text-muted-foreground">{faviconHelpText}</p>

              {companyFaviconMode === 'UPLOAD' ? (
                <div className="space-y-2">
                  <Input
                    id="companyFavicon"
                    type="file"
                    accept="image/png"
                    disabled={faviconUploading}
                    onChange={(e) => handleFaviconSelected(e.target.files?.[0] || null)}
                  />
                  <p className="text-xs text-muted-foreground">{faviconUploadHelpText}</p>
                </div>
              ) : null}

              {companyFaviconMode === 'LINK' ? (
                <div className="space-y-2">
                  <Input
                    id="companyFaviconLink"
                    type="url"
                    value={companyFaviconLinkUrl}
                    onChange={(e) => setCompanyFaviconLinkUrl(e.target.value)}
                    placeholder="https://example.com/favicon.png"
                  />
                  <p className="text-xs text-muted-foreground">{faviconLinkHelpText}</p>
                </div>
              ) : null}

              {companyFaviconMode !== 'NONE' && companyFaviconUrl ? (
                <div className="mt-2 rounded-md border bg-background p-3">
                  <p className="text-xs text-muted-foreground mb-2">Current favicon preview</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={companyFaviconUrl} alt="Favicon" style={{ width: 32, height: 32 }} />
                  {!companyFaviconConfigured ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Linked favicons must be publicly accessible.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {faviconError ? <p className="text-xs text-destructive">{faviconError}</p> : null}
              {faviconSuccess ? <p className="text-xs text-success">{faviconSuccess}</p> : null}

              {companyFaviconMode !== 'NONE' ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" disabled={faviconUploading} onClick={() => onCompanyFaviconUploaded()}>
                    Refresh Preview
                  </Button>
                  {faviconUploading ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
                </div>
              ) : null}
            </div>

            <div className="pt-3 border-t space-y-2">
              <Label htmlFor="accentColor">Accent colour</Label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  id="accentColor"
                  value={accentColor || '#007AFF'}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="h-10 w-14 rounded-md border border-input bg-background cursor-pointer p-0.5"
                />
                <Input
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  placeholder="#007AFF"
                  className="h-9 w-32 font-mono text-sm"
                  maxLength={7}
                />
                {accentColor && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccentColor('')}>
                    Reset
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Custom accent colour for buttons, links, toggles, and email templates. Leave empty for default blue.</p>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

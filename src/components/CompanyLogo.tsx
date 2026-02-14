'use client'

import { useTheme } from '@/hooks/useTheme'

interface CompanyLogoProps {
  /** URL of the main company domain — if set, the logo becomes a clickable link */
  mainCompanyDomain?: string | null
  /** Alt text for the logo image */
  alt?: string
  /** CSS classes for the logo container */
  className?: string
  /** CSS classes for the image itself */
  imgClassName?: string
  /** Max width constraint for the image */
  maxWidth?: number
  /** Whether to render as a block-level container (default true) */
  block?: boolean
  /** Whether a separate dark-mode logo has been configured */
  hasDarkLogo?: boolean
}

/**
 * Renders the company logo (/api/branding/logo) with optional clickable link.
 * Opens in a new tab when clicked inside the app.
 * When hasDarkLogo is true and the app is in dark mode, renders the dark logo instead.
 */
export function CompanyLogo({
  mainCompanyDomain,
  alt = 'Company logo',
  className = '',
  imgClassName = '',
  maxWidth,
  block = true,
  hasDarkLogo = false,
}: CompanyLogoProps) {
  const { isDark } = useTheme()
  const logoSrc = isDark && hasDarkLogo ? '/api/branding/dark-logo' : '/api/branding/logo'

  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoSrc}
      alt={alt}
      className={imgClassName || undefined}
      style={{
        display: 'block',
        width: '100%',
        height: 'auto',
        objectFit: 'contain',
        ...(maxWidth ? { maxWidth: `${maxWidth}px` } : {}),
      }}
    />
  )

  const content = mainCompanyDomain ? (
    <a
      href={mainCompanyDomain}
      target="_blank"
      rel="noopener noreferrer"
    >
      {img}
    </a>
  ) : (
    img
  )

  if (!block) return content

  return <div className={className}>{content}</div>
}

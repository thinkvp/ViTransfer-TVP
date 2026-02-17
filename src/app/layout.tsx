import type { Metadata } from 'next'
import './globals.css'
import { prisma } from '@/lib/db'
import { unstable_noStore as noStore } from 'next/cache'

// Force Node.js runtime across the app to allow use of Node APIs (e.g., crypto).
export const runtime = 'nodejs'

/**
 * Convert a hex colour (#RRGGBB) to HSL space-separated values like "210 100% 50%".
 * Returns null for invalid input.
 */
function hexToHslValues(hex: string): { h: number; s: number; l: number } | null {
  const clean = hex.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/**
 * Build a CSS override block that replaces the default blue primary colour
 * with a custom accent colour in both light and dark modes.
 */
function buildAccentOverrideCss(hex: string, textMode?: string | null): string | null {
  const hsl = hexToHslValues(hex)
  if (!hsl) return null
  const { h, s } = hsl
  // Light mode: use the colour at 50% lightness (vibrant), dark at 60%
  const lightL = 50, darkL = 60
  const lightVisibleL = 95, darkVisibleL = 20
  // Accent text: LIGHT = white (0 0% 100%), DARK = near-black (220 14% 7%)
  const foreground = textMode === 'DARK' ? '220 14% 7%' : '0 0% 100%'
  return `
    :root {
      --primary: ${h} ${s}% ${lightL}%;
      --primary-foreground: ${foreground};
      --primary-visible: ${h} ${s}% ${lightVisibleL}%;
      --accent-foreground: ${h} ${s}% ${lightL}%;
      --ring: ${h} ${s}% ${lightL}%;
    }
    .dark {
      --primary: ${h} ${s}% ${darkL}%;
      --primary-foreground: ${foreground};
      --primary-visible: ${h} ${s}% ${darkVisibleL}%;
      --accent-foreground: ${h} ${s}% ${darkL}%;
      --ring: ${h} ${s}% ${darkL}%;
    }
  `
}

export async function generateMetadata(): Promise<Metadata> {
  noStore()

  const settings = await prisma.settings
    .findUnique({
      where: { id: 'default' },
      select: {
        companyName: true,
        companyFaviconMode: true,
        companyFaviconPath: true,
        companyFaviconUrl: true,
        updatedAt: true,
      },
    })
    .catch(() => null)

  const companyName = typeof settings?.companyName === 'string' ? settings.companyName.trim() : ''
  const siteName = companyName || 'Portal'

  const faviconConfigured =
    (settings?.companyFaviconMode === 'UPLOAD' && !!settings.companyFaviconPath) ||
    (settings?.companyFaviconMode === 'LINK' && typeof settings.companyFaviconUrl === 'string' && !!settings.companyFaviconUrl.trim())

  const faviconUrl = faviconConfigured
    ? `/api/branding/favicon?v=${settings?.updatedAt ? new Date(settings.updatedAt).getTime() : 0}`
    : '/icon.svg'

  return {
    title: {
      default: siteName,
      template: `%s | ${siteName}`,
    },
    description: 'Secure portal',
    icons: {
      icon: [{ url: faviconUrl }],
    },
  }
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  noStore()

  // Read accent colour and theme settings from database.
  const brandingSettings = await prisma.settings
    .findUnique({
      where: { id: 'default' },
      select: { accentColor: true, accentTextMode: true, defaultTheme: true, allowThemeToggle: true },
    })
    .catch(() => null)

  const accentCss = brandingSettings?.accentColor
    ? buildAccentOverrideCss(brandingSettings.accentColor, brandingSettings.accentTextMode)
    : brandingSettings?.accentTextMode === 'DARK'
      ? `:root, .dark { --primary-foreground: 220 14% 7%; }`
      : null

  const defaultTheme = brandingSettings?.defaultTheme || 'DARK'
  const allowThemeToggle = brandingSettings?.allowThemeToggle ?? true

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {accentCss && (
          <style dangerouslySetInnerHTML={{ __html: accentCss }} />
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  window.__THEME_CONFIG__ = { defaultTheme: ${JSON.stringify(defaultTheme)}, allowToggle: ${JSON.stringify(allowThemeToggle)} };
                  var theme = localStorage.getItem('theme');
                  if (!${JSON.stringify(allowThemeToggle)}) {
                    // Theme toggle disabled — always use the admin-configured default
                    localStorage.removeItem('theme');
                    theme = null;
                  }
                  if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                  } else if (theme === 'light') {
                    document.documentElement.classList.remove('dark');
                  } else {
                    // No saved preference: use admin default
                    var def = ${JSON.stringify(defaultTheme)};
                    if (def === 'AUTO') {
                      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                        document.documentElement.classList.add('dark');
                      } else {
                        document.documentElement.classList.remove('dark');
                      }
                    } else if (def === 'LIGHT') {
                      document.documentElement.classList.remove('dark');
                    } else {
                      document.documentElement.classList.add('dark');
                    }
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="flex flex-col min-h-dvh overflow-x-hidden">
        <main className="flex-1 min-h-0 flex flex-col">{children}</main>
      </body>
    </html>
  )
}

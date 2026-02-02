import type { Metadata } from 'next'
import './globals.css'
import { prisma } from '@/lib/db'
import { unstable_noStore as noStore } from 'next/cache'

// Force Node.js runtime across the app to allow use of Node APIs (e.g., crypto).
export const runtime = 'nodejs'

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme');
                  if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                  } else if (theme === 'light') {
                    document.documentElement.classList.remove('dark');
                  } else {
                    // No saved preference: default to dark
                    document.documentElement.classList.add('dark');
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

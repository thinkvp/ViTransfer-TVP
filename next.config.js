/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Avoid bundling certain Node-only packages into the server build.
  // This prevents webpack from rewriting jsdom asset paths (e.g. default-stylesheet.css)
  // into `.next/` and causing ENOENT during `next build`.
  serverExternalPackages: ['jsdom', 'isomorphic-dompurify'],

  // Increase body size limit for TUS chunked uploads
  // TUS uploads can send chunks larger than 10MB (default Next.js limit)
  // Set to 100MB to handle large video chunks safely
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb'
    }
  },

  // SECURITY: Add comprehensive security headers
  async headers() {
    // Check if HTTPS is enabled (via environment variable)
    const isHttpsEnabled = process.env.HTTPS_ENABLED === 'true' || process.env.HTTPS_ENABLED === '1';
    const isProd = process.env.NODE_ENV === 'production'

    // Sanitize env-provided endpoint to an origin to avoid CSP injection.
    // Accept only http/https absolute URLs; ignore relative paths.
    const sanitizeOrigin = (value) => {
      if (!value || typeof value !== 'string') return ''
      try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
        return url.origin
      } catch {
        return ''
      }
    }

    const tusOrigin = sanitizeOrigin(process.env.NEXT_PUBLIC_TUS_ENDPOINT)

    const cspDirectives = [
      {
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          // Keep 'unsafe-inline' for the theme bootstrap inline script in src/app/layout.tsx.
          // Avoid 'unsafe-eval' in production to reduce XSS blast radius (dev tooling may require it).
          `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
          "style-src 'self' 'unsafe-inline' https:",
          // Avoid wildcard origins where possible; allow https for externally hosted images/assets.
          "img-src 'self' data: blob: https:",
          "font-src 'self' data: https:",
          `connect-src 'self' blob:${tusOrigin ? ` ${tusOrigin}` : ''} https:`,
          "media-src 'self' blob: https:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ]
      },
      {
        key: 'X-DNS-Prefetch-Control',
        value: 'on'
      },
      {
        key: 'X-Frame-Options',
        value: 'DENY'
      },
      {
        key: 'X-Content-Type-Options',
        value: 'nosniff'
      },
      {
        key: 'Referrer-Policy',
        value: 'same-origin'
      },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()'
      }
    ];

    // Only upgrade to HTTPS when HTTPS is actually enabled
    if (isHttpsEnabled) {
      cspDirectives[0].value.push('upgrade-insecure-requests');
    }

    const securityHeaders = cspDirectives.map(header => {
      if (header.key === 'Content-Security-Policy') {
        return { ...header, value: header.value.join('; ') };
      }
      return header;
    });

    // Only add HSTS when HTTPS is enabled
    if (isHttpsEnabled) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload'
      });
    }

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Share links - still deny framing for security
        source: '/share/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          }
        ]
      }
    ]
  }
}

module.exports = nextConfig

# Security Policy

This security policy applies to **ViTransfer-TVP**.

Note: This document was originally adapted from the upstream ViTransfer project and has been updated for the ViTransfer-TVP fork.



## Reporting a Vulnerability

If you discover a security vulnerability in ViTransfer-TVP, please report it by creating a private security advisory on GitHub.

**Please do not open public issues for security vulnerabilities.**

We aim to respond to reports within 48 hours and provide a timeline for a fix.

## Security Features

### Authentication & Sessions
- **Bearer-only authentication** (v0.6.0+): admin and share flows use Authorization headers only; browser-managed credentials are not trusted.
- **Access tokens** are returned in JSON and are kept in memory on the client.
- **Refresh tokens** are stored in browser storage (sessionStorage by default; optional localStorage when “Remember this device” is enabled).
- **Admin UI inactivity timeout** automatically logs out after 30 minutes of inactivity, with an on-screen warning shortly before logout.
- **Token rotation** on each refresh to prevent replay attacks
- **Token revocation** support for forced logouts
- **No implicit cross-site tokens**: all state-changing endpoints rely on explicit bearer tokens

Token lifetimes (defaults; may be configured via environment/settings):
- Admin access token: 60 minutes
- Admin refresh token: 7 days
- Share token: 45 minutes (share token TTL may also be overridden by server settings)

### Password Protection
- **AES-256-GCM encryption** for share passwords
- **Bcrypt hashing** (bcryptjs, cost factor 14) for admin passwords
- **Rate limiting / lockout** for authentication attempts (defaults: 5 attempts per 15 minutes; configurable via Security Settings)
- **Real-time password validation** with inline feedback

### Video Access Control
- **Token-based video streaming** with session validation
- **Hotlink protection** to prevent unauthorized embedding
- **Watermarking** on preview videos
- **Time-limited access tokens** aligned with the configured client session timeout (default: 15 minutes)
- **Session binding** for video access tokens

### Data Protection
- **Encrypted passwords** stored in database
- **Database context isolation** for multi-tenancy
- **Input validation** using Zod schemas
- **Comment sanitization** to prevent XSS attacks
- **Content Security Policy** headers (nonce-based, no unsafe-inline/eval)

### Rate Limiting
- **Redis-backed rate limiting** with hashed identifiers (IP + User-Agent for general limits; custom keys for sensitive flows)
- **Configurable per-minute limits** via Security Settings (defaults: 1000 req/min per IP, 600 req/min per admin session, 300 req/min per share session)
- **Stricter per-endpoint limits** may be applied for sensitive routes (login/OTP/etc.)

### Security Logging
- **Failed login attempts** tracking
- **Suspicious activity** monitoring
- **Rate limit violations** logging
- **Video access** audit trail
- **Security events** stored in the database and available in the admin UI when enabled

## Vulnerability Assessment

We recommend regularly scanning your deployed images and dependencies. Results change over time as base images and packages update.

Example commands:
```bash
docker scout cves thinkvp/vitransfer-tvp-app:latest
docker scout cves thinkvp/vitransfer-tvp-worker:latest
```

## Security Hardening

### Container Security
- Base image: node:24.13.0-alpine3.23
- Non-root user execution
- no-new-privileges security option enabled
- Regular image rebuilds with security updates

### Defense in Depth
- Container isolation
- Input validation on all uploads
- Rate limiting on all endpoints
- File type restrictions
- Health checks and monitoring

## Recommended Actions

### For Production Deployments

**1. Keep images updated:**
```bash
docker pull thinkvp/vitransfer-tvp-app:latest
docker pull thinkvp/vitransfer-tvp-worker:latest
docker-compose up -d
```

**2. Run security scans:**
```bash
docker scout cves thinkvp/vitransfer-tvp-app:latest
docker scout cves thinkvp/vitransfer-tvp-worker:latest
```

**3. Enable HTTPS:**
- Always use a reverse proxy with TLS/SSL

**4. Regular backups:**
- Backup database and uploads directory

## Security Best Practices

### Deployment
- Always use HTTPS with valid SSL certificates
- Set secure `ENCRYPTION_KEY` and `JWT_SECRET` values
- Use strong admin passwords (12+ characters)
- Run behind a reverse proxy (Nginx, Traefik, Caddy)
- Enable rate limiting at the reverse proxy level
- Keep Docker images updated

### Configuration
- Change default admin password immediately
- Use unique passwords for each project
- Review security logs regularly
- Limit admin user accounts to necessary personnel

### Network Security
- Use firewall rules to restrict access
- Consider hosting the app on a VLAN
- Consider VPN for admin access
- Enable fail2ban or similar intrusion prevention
- Monitor access logs for suspicious patterns



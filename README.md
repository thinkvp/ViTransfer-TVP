# ViTransfer-TVP

**Professional Video Production Review Platform & CRM**

ViTransfer-TVP is a self-hosted web application for video production teams to share work with clients, collect timestamped feedback, manage approvals, and handle invoicing. Built on top of the original [ViTransfer](https://github.com/MansiVisuals/ViTransfer) by MansiVisuals, this fork extends the platform with sales/CRM capabilities and professional workflow features.

⚡ **"Vibecoded" Project:** This project extensively uses AI-assisted development (Claude AI & ChatGPT) with a focus on security and best practices. While we've implemented comprehensive testing and security measures, we encourage you to review the code and implement appropriate safeguards for your deployment environment. Always conduct your own security audits before production use.

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![GitHub](https://img.shields.io/badge/github-thinkvp%2FViTransfer--TVP-blue)](https://github.com/thinkvp/ViTransfer-TVP)

> **Fork Notice:** ViTransfer-TVP forked from [ViTransfer v0.8.2](https://github.com/MansiVisuals/ViTransfer/releases/tag/v0.8.2) and has since diverged significantly (170+ commits). The upstream project continues independently at [MansiVisuals/ViTransfer](https://github.com/MansiVisuals/ViTransfer). We gratefully credit them for the original concept and foundation.


---

## What is ViTransfer-TVP?

ViTransfer-TVP is designed for video production companies, freelance filmmakers, and post-production houses who need a self-hosted platform to:

- **Share video previews** with clients via secure, branded links
- **Collect timestamped feedback** with threaded, version-aware comments
- **Manage approval workflows** with per-video approval tracking
- **Send professional invoices** with QuickBooks and Stripe integration
- **Track project analytics** including page visits, downloads, and engagement
- **Maintain full control** over your data with self-hosted deployment

Think of it as a self-hosted alternative to Frame.io or Wipster, with added CRM and invoicing capabilities.

---

## Features

### Core Video Review
- **Video Upload & Processing** — Automatic FFmpeg transcoding to 720p, 1080p, or 4K with resumable uploads via TUS protocol
- **Smart Watermarking** — Customizable watermarks with center and corner placements, configurable per project or globally
- **Timestamped Comments** — Timestamped feedback with threaded replies that track video versions (up to 10,000 characters), with full timecode support (HH:MM:SS:FF including drop-frame)
- **SRT Comment Export** — Export timestamped comments and feedback as standard .SRT subtitle files for import into any NLE (Premiere Pro, DaVinci Resolve, Final Cut Pro, etc.). Unlike timeline markers, SRT subtitles remain synchronised with your edit — when clips are moved, trimmed, or deleted, the feedback stays anchored to the correct timecode rather than becoming orphaned markers on a static timeline
- **Comment Attachments** — Multi-file uploads (up to 5 files per comment) supporting images, PSD/AI, and common video formats
- **Approval Workflow** — Per-video approval system with automatic project approval when all videos are approved
- **Version Control** — Multiple video versions per project with revision tracking and optional max revision limits
- **Custom Thumbnails** — Set per-version thumbnails from uploaded image assets
- **Dark Mode** — Native light and dark themes for consistent experience across devices
- **Responsive Design** — Optimized for desktop, tablet, and mobile devices

### Authentication & Access Control
- **Flexible Share Authentication** — Password protection, email OTP codes, both methods, or no authentication with optional guest mode
- **WebAuthn Passkeys** — Modern passwordless login for admin accounts with multi-device support
- **Guest Mode** — View-only guest access with optional restriction to latest version only
- **Session Management** — Configurable timeouts, IP binding, and automatic session invalidation on security changes

### Sales & CRM (TVP Exclusive)
- **QuickBooks Integration** — Pull client and invoice data from QuickBooks Online (read-only sync)
- **Stripe Checkout** — Accept payments directly on invoices with Stripe payment links
- **Invoice Management** — Create, send, and track invoices with payment reminders
- **Sales Dashboard** — Overview of outstanding invoices, payment status, and revenue

### Notifications
- **In-App Notification Bell** — Real-time notification center in admin header with unread badge count, auto-polling (30s intervals), click-to-navigate links, and persistent read/unread state tracking. Covers client comments, video approvals, sales events, and security alerts.
- **Smart Email Notifications** — Scheduling options: immediate, hourly, daily, or weekly digests
- **Email Tracking** — Optional tracking pixels for email open analytics (can be disabled globally). ⚠️ **Legal Notice:** Email tracking regulations vary by jurisdiction. Some regions (e.g., GDPR in EU, CPRA in California) require explicit consent before tracking email opens. Check your local laws and privacy regulations before enabling this feature. You are responsible for ensuring compliance with applicable privacy laws.
- **Project Update Digests** — Batched comment summaries to reduce email noise
- **Payment Reminders** — Automated invoice payment reminder emails
- **Push Notifications** — Optional Gotify integration and browser Web Push notifications for instant alerts

### Admin Features
- **Multi-User Support** — Multiple admin accounts with JWT authentication and optional WebAuthn passkey support
- **Analytics Dashboard** — Track page visits and download events per project and video with engagement metrics
- **Security Dashboard** — IP/domain blocklists, rate-limit visibility, event tracking, and one-click unblock
- **Asset Management** — Attach images, audio, subtitles, project files (Premiere, DaVinci Resolve, Final Cut), and documents with magic byte validation
- **Detailed Storage Statistics** — Per-project storage breakdowns showing videos, video assets, comment attachments, photos, and project files with percentage visualizations. Includes both database-tracked totals (totalBytes) and on-disk reconciliation (diskBytes) to account for transcoded previews, thumbnails, and sprites. Admin-triggerable manual recalculation and daily automated reconciliation.
- **Flexible Settings** — Per-project and global configuration with override capabilities

### Technical
- **Docker First** — Easy deployment with Docker Compose (linux/amd64)
- **High Performance** — Built with Next.js 16 and React 19 with CPU-aware FFmpeg presets
- **Background Processing** — Redis 8 queue with BullMQ for video transcoding, notifications, and sales reminders
- **Professional Video** — FFmpeg-powered transcoding supporting MP4, MOV, AVI, MKV, MXF, and ProRes formats
- **Reliable Database** — PostgreSQL 17 with Prisma 6 ORM for type-safe data access
- **Secure Authentication** — JWT tokens with refresh rotation, WebAuthn passkeys, and bearer-only auth
- **Resumable Uploads** — TUS protocol for large file uploads with progress tracking
- **Progressive Web App (PWA)** — Installable admin interface with Web App Manifest and Service Worker for mobile app-like experience. Supports browser Web Push notifications (admin-scoped, /admin/ only) with VAPID authentication for real-time alerts on mobile/desktop devices.

---

## Unique Features (TVP Extensions)

These features distinguish ViTransfer-TVP from the original ViTransfer:

### Sales & CRM Integration
Built-in customer relationship management and invoicing capabilities:
- **QuickBooks Sync** — One-way sync pulls clients, quotes, and invoices from QuickBooks Online with automatic daily updates
- **Stripe Checkout** — Generate payment links for invoices that redirect to Stripe-hosted checkout pages
- **Client Database** — Centralized client management with company details, contact information, and display colors
- **Sales Dashboard** — Overview of outstanding invoices, payment status, revenue tracking, and quote conversion
- **Invoice Management** — Create, send, and track invoices with automated payment reminder emails
- **Payment Tracking** — Real-time payment status updates from Stripe webhooks
- **Quote System** — Manage quotes with expiry dates and conversion to projects
- **Calendar Integration** — Quote expiry and invoice due dates automatically appear on the calendar view
- **Project Linking** — Link invoices directly to projects for seamless workflow from quote to delivery

### Guest Video Links
Per-video shareable links for targeted distribution:
- **Single-Video Access** — Generate unique links for individual videos without exposing the entire project
- **Version-Specific** — Links are tied to specific video versions, automatically updating when versions change
- **Token-Based Security** — Cryptographically secure random tokens (like `gv/abc123xyz`) for each link
- **14-Day Expiry** — Auto-expiring links with ability to refresh expiry without regenerating token
- **Guest Mode Required** — Requires project guest mode to be enabled for security
- **Analytics Tracking** — Track views and IP-based dedupe to prevent analytics inflation
- **Push Notifications** — Optional admin notifications when guest video links are accessed
- **Project Status Checks** — Links automatically disabled when projects are CLOSED
- **Watermark Support** — Respects project watermark settings for embedded videos
- **No Downloads** — View-only access (no download capability) to protect work-in-progress
- **Client Generation** — Both admins and authenticated share users can generate guest video links

### Comprehensive Branding
Deep customization throughout the entire application:
- **Company Logo** — Upload or link to PNG/JPG logo displayed in app header and email communications
- **Dark Mode Logo** — Optional separate logo for dark theme with automatic theme switching
- **Favicon** — Custom browser favicon (upload or link) for professional browser tab appearance
- **Accent Color** — Custom hex color for buttons, links, toggles, and email templates (default blue)
- **Accent Text Mode** — Choose light (white) or dark (black) text on accent-colored buttons for contrast
- **Email Header Color** — Custom background color for email headers (default: dark gray)
- **Email Header Text Mode** — Light or dark text in email headers based on your header color
- **Clickable Logos** — Optional main company domain URL makes logos clickable in emails and app
- **Email Watermark** — Company name and logo embedded in all client communications
- **Consistent Theming** — Colors and branding propagate through all admin pages, share pages, and emails

### Better Aspect Ratio Support
Intelligent handling of various video dimensions:
- **Portrait Video** — Proper 9:16 vertical video support with correct scaling and no stretching
- **Square Video** — Native 1:1 aspect ratio support for social media content
- **Ultra-Wide** — Handles 21:9, 2.39:1, and other cinematic aspect ratios
- **Legacy Formats** — 4:3 standard definition video support with proper pillarboxing
- **Dynamic Player** — Video player automatically adjusts to video dimensions without black bars
- **Container Queries** — Modern CSS container queries ensure proper scaling on all screen sizes
- **Mobile Optimization** — Portrait videos fill mobile screens efficiently without awkward letterboxing
- **Metadata-First** — Uses database-stored dimensions before video element metadata to prevent visible jumps
- **FFmpeg Aware** — Video worker calculates correct output dimensions maintaining aspect ratio for all orientations
- **Thumbnail Sizing** — Sidebar thumbnails calculate proper dimensions to maintain aspect ratio within 16:9 containers

### Photos & Albums
Comprehensive photo management and delivery system:
- **Multi-Photo Albums** — Create multiple albums per project for different shoots or deliverables
- **Batch Upload** — Upload up to 300 photos at once with parallel processing (3 concurrent uploads)
- **Resumable Uploads** — TUS protocol allows pausing and resuming large photo uploads
- **JPEG Only** — Strict JPEG/JPG validation with magic byte verification for security
- **Photo Galleries** — Grid-based photo viewer with lightbox for full-screen viewing
- **Social Media Export** — Automatic 4:5 (1080x1350) Instagram portrait crop generation for all photos
- **Bulk Downloads** — Generate ZIP files for all photos (full resolution) or social crops
- **Share Integration** — Photos appear on client share pages when project `enablePhotos` setting is enabled
- **Client Access** — Clients can view, download individual photos, or download entire albums as ZIP
- **Flexible Workflow** — Projects can enable videos only, photos only, or both
- **Storage Tracking** — Photo uploads count toward project total bytes for storage management
- **Album Notes** — Add descriptions or notes to albums for context

### Improved Communication Options
Enhanced tools for project communication and notification management:
- **Video Version Notes** — Add notes to each video version (up to 500 characters) visible to clients and admins on share pages
- **Inline Note Display** — Version notes appear in expandable sections on video player cards for easy reference
- **Admin Note Editing** — Admins can edit version notes directly from the video list without re-uploading
- **Selectable Email Recipients** — Choose which project recipients receive notifications for each email sent
- **Per-Recipient Preferences** — Each recipient has a `receiveNotifications` toggle to opt in/out of project emails
- **Visual Notification Status** — Bell icons show which recipients have notifications enabled at a glance
- **Notification Defaults** — Recipients with notifications enabled are pre-selected when composing emails
- **Flexible Targeting** — Send entire project updates, specific video notifications, or comment summaries to selected recipients only
- **Internal User Invites** — Invite assigned users to projects with optional file attachments and custom notes
- **Key Date Reminders** — Send automated reminder emails to specific users and/or recipients before key dates
- **Unsubscribe Links** — All client-facing emails include unsubscribe links to disable notifications per project

### Granular Approval Control
Fine-tuned control over which video versions can be approved:
- **Per-Version Approval Toggle** — Each video version has an `allowApproval` checkbox to enable/disable client approval
- **Default Disabled** — New video uploads default to approval disabled, preventing accidental approvals of work-in-progress
- **Admin Override** — Admins can toggle approval permission on any video version at any time
- **Visual Indicators** — "Approvable?" checkbox in video lists shows approval status at a glance
- **Client Protection** — Clients can only approve videos where `allowApproval` is explicitly enabled
- **API Validation** — Share page approve endpoint validates `allowApproval` flag before processing approvals
- **Flexible Workflow** — Upload multiple versions for review, then selectively enable approval only on the final version
- **Backward Compatible** — Existing videos were backfilled with approval enabled to preserve behavior from previous versions
- **Multi-Video Upload** — Bulk upload modal includes per-video approval toggles for efficient batch operations
- **Status Tracking** — Disabled approval versions cannot be approved, preventing incomplete deliverables from being finalized
- **Full Control Permission** — Requires `projectsFullControl` action permission to change approval settings

### User Roles & Permissions
Granular role-based access control beyond simple admin/client:
- **Custom Roles** — Create unlimited roles with custom names (e.g., "Project Manager", "Editor", "Accountant")
- **System Admin** — Dedicated system admin role with unrestricted access to all features
- **Menu Visibility** — Control access to Projects, Clients, Sales, Settings, Users, Security, Analytics, Share Page
- **Project Status Filtering** — Limit visible project statuses per role (e.g., editors only see IN_PROGRESS)
- **Granular Actions** — Per-area permissions like "Photo & Video Uploads", "Full Control", "Manage Comments"
- **Share Page Access** — Control whether users can access client share pages to leave internal comments
- **Settings Management** — Separate permissions for changing settings vs. sending test emails
- **User Management** — Dedicated permissions for managing users and creating/editing roles
- **Client Management** — Control who can create/edit clients and manage client file storage
- **Security Dashboard** — Separate view vs. manage permissions for security events, blocklists, rate limits
- **Sales Access** — Control access to CRM, quotes, and invoices separately from projects
- **Project Assignment** — System admins can assign specific users to projects for targeted collaboration
- **Notification Control** — Per-user notification settings for assigned projects
- **Protected Roles** — System admin and built-in admin roles cannot be deleted or demoted

### Additional Security Tweaks
Multiple layers of protection beyond standard security measures:
- **Max Upload Safeguards** — Configurable maximum upload size (default 1GB) enforced at application and TUS handler levels
- **Random Slug Generation** — Cryptographically secure project share links using crypto.randomInt() (8-12 alphanumeric chars)
- **De-identification** — Generic error messages like "Not found" and "Invalid credentials" prevent user enumeration attacks
- **Constant-Time Comparison** — Password verification uses crypto.timingSafeEqual() to prevent timing attacks
- **Token Hashing** — Share access token fingerprints hashed (SHA-256) before Redis storage
- **Random Session IDs** — All session identifiers use crypto.randomBytes(16) for unpredictability
- **Rate Limit Scoping** — Rate limits scoped per admin+resource (e.g., `${auth.id}:${albumId}`) to prevent IP-based lockouts during bulk operations
- **Failed Attempt Tracking** — IP+token+email hashing (SHA-256, 16-char) for rate limiting without exposing PII
- **OTP Security** — 6-digit OTP codes use crypto.randomInt() for cryptographic randomness
- **Account Lockout** — Configurable max password attempts (default 5) with 15-minute lockout windows
- **Security Event Logging** — All authentication attempts logged with severity levels (INFO/WARNING/CRITICAL)
- **Path Traversal Prevention** — 7-layer defense including input validation, normalization, and path containment checks
- **JSON Parse Safety** — Robust error handling for corrupted Redis data with graceful degradation
- **FFmpeg Input Sanitization** — Watermark text validation (100 char limit, alphanumeric whitelist) to prevent command injection

### Detailed Status Workflow
Intelligent project lifecycle management with 8 distinct statuses (NOT_STARTED, IN_PROGRESS, IN_REVIEW, REVIEWED, ON_HOLD, SHARE_ONLY, APPROVED, CLOSED). The workflow includes:
- **Automated transitions**: Projects automatically move to IN_REVIEW when clients are notified, to APPROVED when all videos are approved (configurable), and can auto-close X days after approval
- **Auto-start on Key Dates**: Projects can automatically transition from NOT_STARTED to IN_PROGRESS on their SHOOTING key date
- **Audit trail**: Every status change is logged with timestamp, source (ADMIN/CLIENT/SYSTEM), and responsible user
- **Smart filtering**: Dashboard views can filter by multiple statuses with visual indicators

### Key Dates System
Comprehensive schedule management for production timelines:
- **Project-specific dates**: PRE_PRODUCTION, SHOOTING, DUE_DATE, and OTHER milestone types
- **Personal dates**: User-specific dates not tied to projects (e.g., equipment maintenance, studio bookings)
- **All-day or timed events**: Support for both date-only and time-specific scheduling
- **Automated reminders**: Optional email reminders sent to selected users and/or project recipients at specified times
- **Sales integration**: Quote expiry and invoice due dates appear automatically on the calendar
- **Workflow automation**: Shooting dates can trigger automatic project status transitions

### Calendar Sync
Integration with external calendar applications:
- **iCal/ICS feed**: Subscribe-once URL for Google Calendar, Apple Calendar, Outlook, etc.
- **Real-time updates**: Calendar apps automatically sync changes when dates are added/modified
- **Combined view**: Single feed containing project key dates, personal dates, and sales deadlines
- **Timezone support**: Proper handling of timezones (defaults to Australia/Brisbane, configurable via `TZ` environment variable)
- **Token rotation**: Security-focused with ability to regenerate subscription URLs

### External Communication Library
Drag-and-drop email archiving for project communications:
- **Email import**: Drop .eml files (exported from Gmail, Outlook, Apple Mail, etc.) directly into projects
- **Automatic parsing**: Extracts subject, sender details, timestamps, text/HTML body, and all attachments
- **Inline image handling**: Preserves inline images from email bodies with proper content-ID linking
- **Attachment management**: Download individual attachments or view them in context
- **Background processing**: Large email files are processed asynchronously without blocking the UI
- **Searchable archive**: All imported communications are searchable by subject, sender, and content

### Client File Storage
Centralized document repository per client:
- **File categories**: Automatically categorize uploads (contracts, branding, images, video, audio, documents)
- **Usage**: Store brand guidelines, signed contracts, logo files, style guides, and reference materials
- **Access control**: Internal-only storage (not shared with clients on public pages)
- **Organized by client**: Files are grouped by client, making it easy to reference past materials across projects
- **Similar project storage**: Projects also support internal file storage for production documents

### Internal Project Chat
Team collaboration without cluttering client-facing comments:
- **Threaded discussions**: Reply to specific comments to maintain conversation context
- **Admin-only visibility**: Comments are completely hidden from client share pages
- **Email summaries**: Internal comments trigger digest emails on the admin's notification schedule
- **Assigned user notifications**: All users assigned to a project receive comment summaries
- **Persistent history**: Full audit trail of internal team discussions per project
- **Real-time collaboration**: Team members can coordinate on revisions, discuss client feedback, and plan next steps

---

## Quick Start

### Authentication Model
- Admin and client share flows use bearer tokens in the `Authorization` header only (no cookies, no CSRF).
- Admin login/refresh return `{ tokens: { accessToken, refreshToken } }`; store refresh in sessionStorage and keep access token in memory.
- Share links issue short-lived share tokens after password/OTP/guest entry; send them in headers for all share API calls.

### Prerequisites
- Docker and Docker Compose installed
- At least 4GB RAM
- 20GB+ free disk space (more for video storage)
- **Architecture:** linux/amd64 only (ARM64 is not supported)

### Installation Method 1: Docker Hub (Recommended — 3 Minutes)

**Pull pre-built images and run immediately:**

1. **Download the configuration files**
```bash
# Create directory
mkdir vitransfer && cd vitransfer

# Download docker-compose.yml and .env.example
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/dev/docker-compose.yml
curl -O https://raw.githubusercontent.com/thinkvp/ViTransfer-TVP/dev/.env.example
```

2. **Create and configure environment file**
```bash
# Copy and edit the file
cp .env.example .env
nano .env
```

Generate **6 unique** secure values:
```bash
openssl rand -hex 32      # POSTGRES_PASSWORD (hex/URL-safe)
openssl rand -hex 32      # REDIS_PASSWORD (hex/URL-safe)
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 64   # JWT_SECRET
openssl rand -base64 64   # JWT_REFRESH_SECRET
openssl rand -base64 64   # SHARE_TOKEN_SECRET
```

Replace each placeholder in `.env`:
- `POSTGRES_PASSWORD=<<REPLACE_WITH_openssl_rand_hex_32>>`
- `REDIS_PASSWORD=<<REPLACE_WITH_openssl_rand_hex_32>>`
- `ENCRYPTION_KEY=<<REPLACE_WITH_openssl_rand_base64_32>>`
- `JWT_SECRET=<<REPLACE_WITH_openssl_rand_base64_64>>`
- `JWT_REFRESH_SECRET=<<REPLACE_WITH_openssl_rand_base64_64>>`
- `SHARE_TOKEN_SECRET=<<REPLACE_WITH_openssl_rand_base64_64>>`

**Default admin credentials** (change in production):
- `ADMIN_EMAIL=admin@example.com`
- `ADMIN_PASSWORD=Admin1234`

3. **Start the application**
```bash
docker-compose up -d
```

4. **Access ViTransfer-TVP**
- Open http://localhost:4321 (or your configured port)
- Login with your admin credentials
- Complete setup in admin settings

---

### Installation Method 2: Build from Source (Advanced)

**For developers or contributors who want to build from source:**

1. **Clone the repository**
```bash
git clone https://github.com/thinkvp/ViTransfer-TVP.git
cd ViTransfer
git checkout dev
```

2. **Follow steps 2-3 from Method 1 above** to configure your `.env` file

3. **Build and start**
```bash
docker-compose -f docker-compose.build.yml up -d --build
```

4. **Access ViTransfer-TVP** at http://localhost:4321 and login with your admin credentials

The source code will be built into Docker images locally instead of pulling from Docker Hub.

---

## Configuration

### Environment Variables

| Variable | Required | Description | Default | Example |
|----------|----------|-------------|---------|---------|
| `APP_PORT` | No | Port to expose on host | `4321` | `8080` |
| `PUID` | No | User ID for file permissions (Linux) | `1000` | `1000` |
| `PGID` | No | Group ID for file permissions (Linux) | `1000` | `1000` |
| `TZ` | No | Timezone for notification schedules | `UTC` | `Europe/Amsterdam` |
| `POSTGRES_USER` | Yes | PostgreSQL username | `vitransfer` | `vitransfer` |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password (hex only) | — | `openssl rand -hex 32` |
| `POSTGRES_DB` | Yes | PostgreSQL database name | `vitransfer` | `vitransfer` |
| `REDIS_PASSWORD` | Yes | Redis password (hex only) | — | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Yes | Data encryption key (base64) | — | `openssl rand -base64 32` |
| `JWT_SECRET` | Yes | JWT signing secret (base64) | — | `openssl rand -base64 64` |
| `JWT_REFRESH_SECRET` | Yes | JWT refresh secret (base64) | — | `openssl rand -base64 64` |
| `SHARE_TOKEN_SECRET` | Yes | Secret for signing share tokens | — | `openssl rand -base64 64` |
| `ADMIN_EMAIL` | Yes | Initial admin email | — | `admin@example.com` |
| `ADMIN_PASSWORD` | Yes | Initial admin password | — | `Admin1234` (change!) |
| `ADMIN_NAME` | No | Display name for admin user | `Admin` | `Jane Doe` |
| `HTTPS_ENABLED` | No | Enable HTTPS enforcement (HSTS) | `false` (compose default) | `true` for production |
| `CLOUDFLARE_TUNNEL` | No | Enable Cloudflare script/connect CSP | `false` | `true` |
| `NEXT_PUBLIC_TUS_ENDPOINT` | No | Custom TUS origin for connect-src | — | `https://uploads.example.com` |

**Optional Integrations:**

| Variable | Description |
|----------|-------------|
| `QBO_CLIENT_ID` | QuickBooks Online OAuth client ID |
| `QBO_CLIENT_SECRET` | QuickBooks Online OAuth client secret |
| `QBO_REALM_ID` | QuickBooks company ID (realmId) |
| `QBO_REFRESH_TOKEN` | QuickBooks OAuth2 refresh token |
| `QBO_SANDBOX` | Use Intuit sandbox environment (`false`) |
| `QBO_MINOR_VERSION` | QuickBooks API minor version (`75`) |
| `QBO_REDIRECT_URI` | OAuth redirect URI if behind proxy |
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook endpoint secret |

**Important Notes:**
- Use `openssl rand -hex 32` for database passwords (no special characters that break URLs)
- Use `openssl rand -base64 32/64` for encryption keys and JWT secrets
- Avoid special characters in `ADMIN_PASSWORD` due to JSON parsing
- `HTTPS_ENABLED` env var always takes precedence over database settings
- Set `TZ` correctly for scheduled notifications to work as expected

### Application Settings (Admin Panel)

Configure these in the admin panel under Settings:

**Company Branding:**
- Company Name — Displayed in emails and comments (default: "Studio")
- App Domain — Required for PassKey authentication (e.g., `https://yourdomain.com`)

**Email Notifications (SMTP):**
- SMTP Server, Port, Username, Password, From Address
- Security Mode — STARTTLS (default), TLS, or NONE
- Admin Notification Schedule — IMMEDIATE, HOURLY, DAILY, WEEKLY
- Email Tracking Pixels — Enable/disable open tracking globally

**Video Processing Defaults:**
- Preview Resolution — 720p (default) or 1080p
- Watermark Enabled — Apply watermark to preview videos (default: true)
- Watermark Text — Custom watermark text for previews

**Project Behavior:**
- Auto-approve Project — Automatically approve project when all videos are approved (default: true)

### Security Settings (Admin Panel)

**Access Protection:**
- Hotlink Protection — DISABLED, LOG_ONLY (default), or BLOCK_STRICT
- Session Timeout — Configurable value and unit (MINUTES, HOURS, DAYS, WEEKS)
- Password Attempts — Max failed attempts before lockout (default: 5)
- IP/Domain Blocklists — Manage blocked IPs and domains

**Rate Limiting:**
- IP Rate Limit — Requests per minute per IP (default: 1000)
- Session Rate Limit — Requests per minute per session (default: 600)

**HTTPS Enforcement:**
- HTTPS Enabled — Enable HSTS header (default: true)
- Note: `HTTPS_ENABLED` env var always overrides this setting

### Per-Project Settings

Each project can override global defaults:

**Video Processing:** Preview Resolution, Watermark Text, Watermark Enabled

**Client Access:**
- Authentication Mode — PASSWORD, OTP, BOTH, or NONE
- Guest Mode — Allow view-only access without password
- Password — Client access password (AES-256 encrypted)
- Custom URL — Memorable share link slug

**Workflow:** Revision Limit, Allow Comments, Allow Downloads, Require Approval

**Notifications:** Client Notification Schedule, Recipients with per-recipient preferences

### Reverse Proxy Setup

Tested with Cloudflare Tunnels. Set `CLOUDFLARE_TUNNEL=true` in `.env` for proper CSP headers.

---

## Usage Guide

### Creating Your First Project

1. **Login** to the admin panel
2. **Create Project** with title, description, client info, and password
3. **Upload Videos** to the project
4. **Share Link** with your client
5. **Collect Feedback** via timestamped comments
6. **Approve** when client accepts the final version

### Client Workflow

1. Receive share link from filmmaker
2. Enter password / OTP / access as guest (depending on project auth mode)
3. Watch videos and leave timestamped feedback
4. Submit approval when satisfied
5. Download approved videos (if enabled)

---

## Security

- **Password-Protected Projects** — Optional client passwords with AES-256 encryption
- **JWT Authentication** — Secure admin sessions with configurable timeout
- **WebAuthn Passkeys** — Modern passwordless admin login
- **OTP Authentication** — Email-based one-time passwords for share access
- **Rate Limiting** — Protection against brute force on all endpoints
- **Security Event Logging** — Track all access attempts with detailed event history
- **IP/Domain Blocklists** — Block malicious IPs and domains
- **Hotlink Protection** — Prevent unauthorized embedding
- **HTTPS Support** — SSL/TLS with HSTS enforcement
- **Session Monitoring** — Configurable inactivity timeout with warnings
- **Timing-Attack Prevention** — Constant-time password comparison
- **Path Traversal Protection** — 7-layer defense in file storage
- **XSS Protection** — DOMPurify with strict tag/URI allowlists
- **Command Injection Prevention** — Strict FFmpeg watermark sanitization

### Security Notice

ViTransfer-TVP uses Alpine Linux and FFmpeg which may show CVEs in vulnerability scanners. **These are indirect dependencies with minimal risk.** See [SECURITY.md](SECURITY.md) for detailed CVE analysis and risk assessment. All packages are kept at their latest available versions.

---

## Maintenance

### Backup

```bash
# Docker volumes
docker-compose down
tar -czf vitransfer-backup.tar.gz \
  /var/lib/docker/volumes/vitransfer_postgres-data \
  /var/lib/docker/volumes/vitransfer_uploads

# Or use your host paths if using bind mounts
```

### Updates

```bash
# Pull latest images from Docker Hub
docker-compose pull

# Restart with new images
docker-compose up -d

# Database migrations run automatically
```

### Publishing (Maintainers)

```bash
# Linux/macOS (buildx, pushes app + worker for linux/amd64)
./build-multiarch.sh
```

```powershell
# Windows PowerShell (buildx, pushes app + worker for linux/amd64)
./publish-docker.ps1
```

### Logs

```bash
docker-compose logs app        # Application logs
docker-compose logs worker     # Worker logs
docker-compose logs -f         # Follow all logs
```

### Database Management

```bash
# Access PostgreSQL
docker exec -it vitransfer-postgres psql -U vitransfer -d vitransfer

# Backup database
docker exec vitransfer-postgres pg_dump -U vitransfer vitransfer > backup.sql

# Restore database
docker exec -i vitransfer-postgres psql -U vitransfer vitransfer < backup.sql
```

---

## Troubleshooting

- Review logs: `docker-compose logs` (use `-f app` or `-f worker` for specific services)
- Verify `.env` matches your compose file
- Ensure disk space is available: `df -h`
- If uploads fail, confirm proxy/body size limits and retry with a small file
- If locked out with HTTPS issues, set `HTTPS_ENABLED=false` in `.env` and restart

---

---

## License

This project is licensed under the **GNU AFFERO GENERAL PUBLIC LICENSE Version 3 (AGPL-3.0)**.

**This means:**
- You can use ViTransfer-TVP for free
- You can modify the source code
- You can distribute your modifications
- Any derivative work must be open-source under AGPL-3.0
- You must include the original license and copyright notice

See the [LICENSE](LICENSE) file for full details.

---

## Links

- **GitHub Repository:** [github.com/thinkvp/ViTransfer-TVP](https://github.com/thinkvp/ViTransfer-TVP)
- **Issues & Bug Reports:** [GitHub Issues](https://github.com/thinkvp/ViTransfer-TVP/issues)
- **Discussions:** [GitHub Discussions](https://github.com/thinkvp/ViTransfer-TVP/discussions)
- **Docker Hub (app):** [thinkvp/vitransfer-tvp-app](https://hub.docker.com/r/thinkvp/vitransfer-tvp-app)
- **Docker Hub (worker):** [thinkvp/vitransfer-tvp-worker](https://hub.docker.com/r/thinkvp/vitransfer-tvp-worker)

---

## Support & Contributing

### Development Support
ViTransfer-TVP is developed primarily for our internal production needs and shared openly under the AGPL-3.0 license. **We don't accept financial support for this fork.** If you'd like to support development financially, please consider supporting the creator of the original ViTransfer project:

**Support the Original Developer:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20MansiVisuals-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/mansivisuals)

### Bug Reports & Feature Requests
- **Bug reports are welcome and encouraged!** Please open an issue on [GitHub Issues](https://github.com/thinkvp/ViTransfer-TVP/issues) with reproduction steps
- **Feature requests:** We may consider feature requests, but please understand this software is developed primarily for our production workflow. Features that benefit our specific use cases are more likely to be implemented
- **Support limitations:** We are not in a position to provide detailed technical support, troubleshooting, or consulting. The software is provided as-is

### Contributing Code
We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

**How to Contribute:**
1. **Fork the repository** — https://github.com/thinkvp/ViTransfer-TVP
2. **Create a feature branch** from `dev` — `git checkout -b feature/amazing-feature`
3. **Make your changes** — Follow the existing code style
4. **Test thoroughly** — Ensure everything works
5. **Submit a pull request** to `dev` — We'll review it as soon as possible

---

## Acknowledgments

**Original Project:** [ViTransfer by MansiVisuals](https://github.com/MansiVisuals/ViTransfer) — the original concept and foundation for this fork. Thank you for making video review accessible to all creators.

**Built with:**
- [Next.js](https://nextjs.org/) — React framework
- [Prisma](https://www.prisma.io/) — Database ORM
- [BullMQ](https://docs.bullmq.io/) — Job queue
- [FFmpeg](https://ffmpeg.org/) — Video processing
- [PostgreSQL](https://www.postgresql.org/) — Database
- [Redis](https://redis.io/) — Queue and cache
- [Tailwind CSS](https://tailwindcss.com/) — Styling

---

Made for filmmakers and video production professionals

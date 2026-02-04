import type { PushNotificationPayload } from '../src/lib/push-notifications'
import { buildAdminWebPushNotification } from '../src/lib/admin-web-push-templates'

type Preview = {
  type: PushNotificationPayload['type']
  samplePayload: PushNotificationPayload
  rendered: { title: string; body: string; url: string }
}

function makePayloads(): PushNotificationPayload[] {
  const projectId = 'c0123456789abcdefghijklmn'
  const projectName = 'Acme – Spring Campaign'

  return [
    {
      type: 'CLIENT_COMMENT',
      projectId,
      projectName,
      title: 'New Client Comment',
      message: 'New comment on project',
      details: {
        Project: projectName,
        Video: 'TV Spot (v3)',
        Timecode: '00:00:12:10',
        Author: 'Jamie (Client)',
        Comment: 'Can we make the logo 10% bigger and shift it a little left? Also the music feels a touch loud here.',
      },
    },
    {
      type: 'VIDEO_APPROVAL',
      projectId,
      projectName,
      title: 'Video Approved',
      message: 'Client approved video',
      details: {
        Project: projectName,
        'Video(s)': 'TV Spot, Cutdown',
        Author: 'Jamie (Client)',
        Status: 'Partial Approval',
      },
    },
    {
      type: 'SHARE_ACCESS',
      projectId,
      projectName,
      title: 'Share Page Accessed',
      message: 'A client accessed the share page',
      details: {
        Project: projectName,
        'Access Method': 'OTP (jamie@example.com)',
        'IP Address': '203.0.113.42',
      },
    },
    {
      type: 'FAILED_SHARE_PASSWORD',
      projectId,
      projectName,
      title: 'Failed Share Password Attempt',
      message: 'Incorrect share password entered',
      details: {
        'Share Token': 'share_abcdef',
        Attempt: 3,
        'Max Attempts': 5,
        'IP Address': '203.0.113.42',
      },
    },
    {
      type: 'UNAUTHORIZED_OTP',
      projectId,
      projectName,
      title: 'Unauthorized OTP Request',
      message: 'Unauthorized OTP request attempt detected',
      details: {
        Project: projectName,
        'Email Attempted': 'unknown.person@example.com',
        'IP Address': '203.0.113.55',
      },
    },
    {
      type: 'GUEST_VIDEO_LINK_ACCESS',
      projectId,
      projectName,
      title: 'Guest Video Link Access',
      message: 'A guest opened a video-only guest link.',
      details: {
        Project: projectName,
        Video: 'TV Spot (Client Preview)',
        IP: '203.0.113.88',
      },
    },
    {
      type: 'FAILED_LOGIN',
      title: 'Failed Admin Login Attempt',
      message: 'Failed login attempt to admin dashboard',
      details: {
        'Email/Username': 'admin@example.com',
        'IP Address': '198.51.100.10',
      },
    },
    {
      type: 'SUCCESSFUL_ADMIN_LOGIN',
      title: 'Successful Admin Login',
      message: 'Admin logged in successfully',
      details: {
        Email: 'admin@example.com',
        Role: 'System Admin',
        'IP Address': '198.51.100.10',
      },
    },
    {
      type: 'PASSWORD_RESET_REQUESTED',
      title: 'Password Reset Requested',
      message: 'A password reset link was requested',
      details: {
        Email: 'ad***@example.com',
        'IP Address': '198.51.100.23',
      },
    },
    {
      type: 'PASSWORD_RESET_SUCCESS',
      title: 'Password Changed',
      message: 'An admin user password was successfully reset',
      details: {
        Email: 'ad***@example.com',
        'IP Address': '198.51.100.23',
      },
    },
    {
      type: 'SALES_QUOTE_VIEWED',
      title: 'Quote Viewed',
      message: 'A client viewed the quote link',
      details: {
        Number: 'Q-1042',
        Client: 'Acme Co',
        Project: projectName,
        __link: { href: '/admin/sales/quotes/quote_123' },
      },
    },
    {
      type: 'SALES_QUOTE_ACCEPTED',
      title: 'Quote accepted: Q-1042',
      message: 'Acme Co accepted a quote.',
      details: {
        quoteNumber: 'Q-1042',
        clientName: 'Acme Co',
        __link: { href: '/admin/sales/quotes/quote_123' },
      },
    },
    {
      type: 'SALES_INVOICE_VIEWED',
      title: 'Invoice Viewed',
      message: 'A client viewed the invoice link',
      details: {
        Number: 'INV-9007',
        Client: 'Acme Co',
        Project: projectName,
        __link: { href: '/admin/sales/invoices/inv_456' },
      },
    },
    {
      type: 'SALES_INVOICE_PAID',
      projectId,
      projectName,
      title: 'Invoice Paid',
      message: 'INV-9007 was paid via Stripe',
      details: {
        Invoice: 'INV-9007',
        Client: 'Acme Co',
        Project: projectName,
        'Amount (total)': '$1,500.00',
        __link: { href: '/admin/sales/invoices/inv_456' },
      },
    },
  ]
}

function main() {
  const payloads = makePayloads()
  const previews: Preview[] = payloads.map((p) => ({
    type: p.type,
    samplePayload: p,
    rendered: buildAdminWebPushNotification(p),
  }))

  const out = {
    generatedAt: new Date().toISOString(),
    count: previews.length,
    previews,
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

main()

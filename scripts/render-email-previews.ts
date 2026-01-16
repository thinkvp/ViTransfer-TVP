import fs from 'node:fs/promises'
import path from 'node:path'

import {
	EMAIL_THEME,
	emailCardStyle,
	emailPrimaryButtonStyle,
	escapeHtml,
	renderAdminCommentNotificationEmail,
	renderAdminInvoicePaidEmail,
	renderAdminProjectApprovedEmail,
	renderAdminQuoteAcceptedEmail,
	renderCommentNotificationEmail,
	renderProjectKeyDateReminderEmail,
	renderNewVersionEmail,
	renderPasswordEmail,
	renderProjectApprovedEmail,
	renderProjectGeneralNotificationEmail,
	renderEmailShell,
} from '../src/lib/email'

import {
	generateAdminSummaryEmail,
	generateNotificationSummaryEmail,
	generateProjectInviteInternalUsersEmail,
} from '../src/lib/email-templates'
import { renderOTPEmail } from '../src/lib/otp'

async function writeHtml(outDir: string, fileName: string, html: string) {
	await fs.writeFile(path.join(outDir, fileName), html, 'utf-8')
}

async function main() {
	const root = process.cwd()
	const outDir = path.join(root, '.email-previews')
	await fs.mkdir(outDir, { recursive: true })

	const branding = {
		companyName: 'ViTransfer',
		companyLogoUrl: null as string | null,
		trackingPixelsEnabled: false,
		appDomain: 'http://localhost:3000',
	}

	await writeHtml(
		outDir,
		'01-new-version.html',
		(await renderNewVersionEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			videoName: 'Cut A',
			versionLabel: 'v3',
			videoNotes: 'Please focus on pacing in the first 30s.',
			shareUrl: 'http://localhost:3000/share/demo',
			isPasswordProtected: true,
			trackingToken: undefined,
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'02-project-approved.html',
		(await renderProjectApprovedEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			shareUrl: 'http://localhost:3000/share/demo',
			approvedVideos: [{ id: 'vid1', name: 'Cut A' }],
			isComplete: true,
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'03-comment-notification-client.html',
		(await renderCommentNotificationEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			videoName: 'Cut A',
			versionLabel: 'v3',
			authorName: 'Studio Team',
			commentContent: 'Looks great overall. Consider tightening the intro a bit.',
			timecode: '00:00:12:00',
			shareUrl: 'http://localhost:3000/share/demo',
			unsubscribeUrl: 'http://localhost:3000/unsubscribe/demo',
			trackingToken: undefined,
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'04-comment-notification-admin.html',
		(await renderAdminCommentNotificationEmail({
			clientName: 'Alex',
			clientEmail: 'alex@example.com',
			projectTitle: 'Winter Campaign',
			videoName: 'Cut A',
			versionLabel: 'v3',
			commentContent: 'Can we swap the music at 00:45?',
			timecode: '00:00:45:00',
			shareUrl: 'http://localhost:3000/admin/projects/demo',
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'05-admin-approval.html',
		(await renderAdminProjectApprovedEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			approvedVideos: [{ id: 'vid1', name: 'Cut A' }],
			isComplete: false,
			isApproval: true,
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'06-project-ready-for-review.html',
		(await renderProjectGeneralNotificationEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			shareUrl: 'http://localhost:3000/share/demo',
			readyVideos: [
				{ name: 'Cut A', versionLabel: 'v3' },
				{ name: 'Cut B', versionLabel: 'v1' },
			],
			isPasswordProtected: false,
			trackingToken: undefined,
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'07-password.html',
		(await renderPasswordEmail({
			clientName: 'Alex',
			projectTitle: 'Winter Campaign',
			password: 'ABCD-1234',
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'08-otp.html',
		(await renderOTPEmail({
			projectTitle: 'Winter Campaign',
			code: '123456',
			branding: { companyName: branding.companyName, companyLogoUrl: branding.companyLogoUrl },
		})).html
	)

	await writeHtml(
		outDir,
		'09-notification-summary.html',
		generateNotificationSummaryEmail({
			companyName: branding.companyName,
			projectTitle: 'Winter Campaign',
			useFullTimecode: false,
			shareUrl: 'http://localhost:3000/share/demo',
			unsubscribeUrl: 'http://localhost:3000/unsubscribe/demo',
			recipientName: 'Alex',
			recipientEmail: 'alex@example.com',
			period: '(last 24 hours)',
			notifications: [
				{
					type: 'CLIENT_COMMENT',
					videoName: 'Cut A',
					videoLabel: 'v3',
					authorName: 'Studio Team',
					content: 'Please review the updated audio mix.',
					timecode: '00:00:12:00',
					createdAt: new Date().toISOString(),
				},
				{
					type: 'VIDEO_APPROVED',
					videoName: 'Cut A',
					videoLabel: 'v3',
					authorName: 'Alex',
					createdAt: new Date().toISOString(),
				},
			],
			trackingToken: undefined,
			trackingPixelsEnabled: false,
			appDomain: branding.appDomain,
			companyLogoUrl: branding.companyLogoUrl ?? undefined,
		})
	)

	await writeHtml(
		outDir,
		'10-admin-summary.html',
		generateAdminSummaryEmail({
			companyName: branding.companyName,
			adminName: 'Morgan',
			period: '(last 24 hours)',
			companyLogoUrl: branding.companyLogoUrl ?? undefined,
			projects: [
				{
					projectTitle: 'Winter Campaign',
					useFullTimecode: false,
					shareUrl: 'http://localhost:3000/share/demo',
					notifications: [
						{
							type: 'CLIENT_COMMENT',
							videoName: 'Cut A',
							videoLabel: 'v3',
							authorName: 'Alex',
							authorEmail: 'alex@example.com',
							content: 'Looks good, just one tweak at 01:10.',
							timecode: '00:01:10:00',
							createdAt: new Date().toISOString(),
						},
					],
				},
			],
		})
	)

	await writeHtml(
		outDir,
		'11-project-invite-internal.html',
		generateProjectInviteInternalUsersEmail({
			companyName: branding.companyName,
			companyLogoUrl: branding.companyLogoUrl ?? undefined,
			recipientName: 'Morgan',
			projectTitle: 'Winter Campaign',
			projectAdminUrl: 'http://localhost:3000/admin/projects/demo',
			notes: 'Hey team — this project is ready for internal review.\n\nPlease check timeline previews + watermark behavior before we send to the client.',
			attachments: [
				{ fileName: 'Brief.pdf', fileSizeBytes: 2_345_678 },
				{ fileName: 'Shotlist.xlsx', fileSizeBytes: 345_678 },
			],
		})
	)

	await writeHtml(
		outDir,
		'12-admin-invoice-paid.html',
		(await renderAdminInvoicePaidEmail({
			greetingName: 'Morgan',
			projectTitle: 'Winter Campaign',
			invoiceNumber: 'INV-2026-0007',
			clientName: 'Alex',
			currency: 'AUD',
			invoiceAmountCents: 125_00,
			feeAmountCents: 2_13,
			totalAmountCents: 127_13,
			paidAtYmd: '2026-01-14',
			publicInvoiceUrl: 'http://localhost:3000/sales/view/demo-invoice',
			projectAdminUrl: 'http://localhost:3000/admin/projects/demo',
			branding,
		})).html
	)

	await writeHtml(
		outDir,
		'13-admin-quote-accepted.html',
		(await renderAdminQuoteAcceptedEmail({
			greetingName: 'Morgan',
			quoteNumber: 'Q-2026-0012',
			clientName: 'Alex',
			projectTitle: null,
			acceptedAtYmd: '2026-01-14',
			publicQuoteUrl: 'http://localhost:3000/sales/view/demo-quote',
			adminQuoteUrl: 'http://localhost:3000/admin/sales/quotes/demo',
			branding,
		})).html
	)

	// Sales emails to clients (Quote / Invoice) - mirrors the HTML built in /api/admin/sales/send-email
	const renderSalesDocClientEmail = ({
		isQuote,
		docNumber,
		recipientName,
		clientName,
		projectTitle,
		notes,
		shareUrl,
	}: {
		isQuote: boolean
		docNumber: string
		recipientName: string
		clientName?: string | null
		projectTitle?: string | null
		notes?: string | null
		shareUrl: string
	}): string => {
		const docLabel = isQuote ? 'Quote' : 'Invoice'
		const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
		const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
		const introLine = isQuote
			? 'Please find the attached Quote. You can also view and accept the quote using the link below.'
			: 'Please find the attached Invoice. You can also view and pay the invoice using the link below.'

		return renderEmailShell({
			companyName: branding.companyName,
			companyLogoUrl: branding.companyLogoUrl,
			headerGradient: EMAIL_THEME.headerBackground,
			title: `${docLabel} ready`,
			subtitle: clientName ? `For ${escapeHtml(clientName)}` : undefined,
			trackingPixelsEnabled: false,
			appDomain: branding.appDomain,
			bodyContent: `
			<p style="margin: 0 0 16px 0; font-size: 15px; color: #111827; line-height: 1.6;">
				Hi <strong>${escapeHtml(recipientName)}</strong>,
			</p>

			<p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
				${escapeHtml(introLine)}
			</p>

			<p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
				If you have any questions, please don't hesitate to get in touch.
			</p>

			<div style="${cardStyle}">
				<div style="font-size: 15px; color: #111827; padding: 4px 0;">
					<strong>${escapeHtml(docLabel)} ${escapeHtml(docNumber)}</strong>
				</div>
				${projectTitle ? `
					<div style="font-size: 14px; color: #374151; padding: 2px 0;">
						Project: ${escapeHtml(projectTitle)}
					</div>
				` : ''}
			</div>

			${notes ? `
				<div style="${cardStyle}">
					<div style="font-size: 14px; color: #111827; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(notes)}</div>
				</div>
			` : ''}

			<div style="text-align: center; margin: 28px 0;">
				<a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
					View ${escapeHtml(docLabel)}
				</a>
			</div>

			<p style="margin: 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
				If the button doesn’t work, copy and paste this link into your browser:<br />
				<a href="${escapeHtml(shareUrl)}" style="color: ${EMAIL_THEME.accent}; text-decoration: none;">${escapeHtml(shareUrl)}</a>
			</p>
			`,
		})
	}

	await writeHtml(
		outDir,
		'14-client-send-quote.html',
		renderSalesDocClientEmail({
			isQuote: true,
			docNumber: 'Q-2026-0012',
			recipientName: 'SimbaMcSimba',
			clientName: 'SimbaMcSimba Industries',
			projectTitle: 'Winter Campaign',
			notes: 'Optional note from the studio goes here.',
			shareUrl: 'http://localhost:3000/sales/view/demo-quote',
		})
	)

	await writeHtml(
		outDir,
		'15-client-send-invoice.html',
		renderSalesDocClientEmail({
			isQuote: false,
			docNumber: 'INV-2026-0007',
			recipientName: 'SimbaMcSimba',
			clientName: 'SimbaMcSimba Industries',
			projectTitle: 'Winter Campaign',
			notes: 'Payment is due within 7 days.',
			shareUrl: 'http://localhost:3000/sales/view/demo-invoice',
		})
	)

	await writeHtml(
		outDir,
		'16-project-key-date-reminder.html',
		(await renderProjectKeyDateReminderEmail({
			projectTitle: 'Winter Campaign',
			projectCompanyName: 'SimbaMcSimba Industries',
			shareUrl: 'http://localhost:3000/admin/projects/demo',
			keyDate: {
				date: '2026-02-03',
				allDay: false,
				startTime: '09:00',
				finishTime: '11:00',
				type: 'SHOOTING',
				notes: 'Call time 08:30. Bring ND filters and a backup lav.',
			},
			branding,
		})).html
	)

	console.log(`Wrote email previews to: ${outDir}`)
	console.log('Open the .html files in a browser (or drag them into an email client).')
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
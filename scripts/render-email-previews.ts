import fs from 'node:fs/promises'
import path from 'node:path'

import {
	renderAdminCommentNotificationEmail,
	renderAdminProjectApprovedEmail,
	renderCommentNotificationEmail,
	renderNewVersionEmail,
	renderPasswordEmail,
	renderProjectApprovedEmail,
	renderProjectGeneralNotificationEmail,
} from '../src/lib/email'

import { generateAdminSummaryEmail, generateNotificationSummaryEmail } from '../src/lib/email-templates'
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

	console.log(`Wrote email previews to: ${outDir}`)
	console.log('Open the .html files in a browser (or drag them into an email client).')
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
/**
 * Demo data seed script for screenshot purposes.
 * Run with: npx tsx scripts/seed-demo-data.ts
 * Safe to run on a local/test instance — does NOT wipe existing data.
 */

import { PrismaClient, ProjectStatus, SalesQuoteStatus, SalesInvoiceStatus, AccountType, AccountTaxCode, ProjectKeyDateType } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL || '') })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Return a date string YYYY-MM-DD by adding `days` to a base date */
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Interpolate a date between start and end by fraction 0..1 */
function interpolateDate(start: Date, end: Date, fraction: number): Date {
  const ms = start.getTime() + (end.getTime() - start.getTime()) * fraction
  return new Date(ms)
}

const START_DATE = new Date('2025-07-01')
const END_DATE = new Date('2026-06-20')

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

const CLIENT_DATA = [
  { name: 'Apex Productions', address: '12 Harbour St, Sydney NSW 2000', phone: '02 9123 4567', website: 'https://apexproductions.com.au' },
  { name: 'BlueSky Media Group', address: '88 Collins St, Melbourne VIC 3000', phone: '03 8765 4321', website: 'https://blueskymedia.com.au' },
  { name: 'Coastal Creative Agency', address: '45 Surfers Paradise Blvd, Gold Coast QLD 4217', phone: '07 5512 3456', website: 'https://coastalcreative.com.au' },
  { name: 'Dynamic Vision Studios', address: '300 Murray St, Perth WA 6000', phone: '08 9234 5678', website: 'https://dynamicvision.com.au' },
  { name: 'Elevation Films', address: '22 Rundle Mall, Adelaide SA 5000', phone: '08 8123 4567', website: 'https://elevationfilms.com.au' },
  { name: 'Frontier Content Co.', address: '7 Darwin St, Darwin NT 0800', phone: '08 8923 4561', website: 'https://frontiercontentco.com.au' },
]

const RECIPIENT_DATA: Record<string, { name: string; email: string; isPrimary: boolean }[]> = {
  'Apex Productions': [
    { name: 'Sarah Mitchell', email: 'sarah.mitchell@apexproductions.com.au', isPrimary: true },
    { name: 'James Thornton', email: 'james.thornton@apexproductions.com.au', isPrimary: false },
  ],
  'BlueSky Media Group': [
    { name: 'Olivia Chen', email: 'olivia.chen@blueskymedia.com.au', isPrimary: true },
    { name: 'Marcus Webb', email: 'marcus.webb@blueskymedia.com.au', isPrimary: false },
  ],
  'Coastal Creative Agency': [
    { name: 'Emma Nguyen', email: 'emma.nguyen@coastalcreative.com.au', isPrimary: true },
    { name: 'Tom Bradley', email: 'tom.bradley@coastalcreative.com.au', isPrimary: false },
  ],
  'Dynamic Vision Studios': [
    { name: 'Lisa Park', email: 'lisa.park@dynamicvision.com.au', isPrimary: true },
    { name: 'Ryan O\'Connor', email: 'ryan.oconnor@dynamicvision.com.au', isPrimary: false },
  ],
  'Elevation Films': [
    { name: 'Hannah Rose', email: 'hannah.rose@elevationfilms.com.au', isPrimary: true },
    { name: 'Daniel Kwan', email: 'daniel.kwan@elevationfilms.com.au', isPrimary: false },
  ],
  'Frontier Content Co.': [
    { name: 'Jessica Harlow', email: 'jessica.harlow@frontiercontentco.com.au', isPrimary: true },
    { name: 'Chris Adebayo', email: 'chris.adebayo@frontiercontentco.com.au', isPrimary: false },
  ],
}

const DISPLAY_COLORS = ['#4F46E5', '#059669', '#DC2626', '#D97706', '#7C3AED', '#0891B2', '#BE185D', '#65A30D']

const PROJECT_TITLES = [
  'Brand Identity Campaign',
  'Product Launch Video',
  'Corporate Overview Film',
  'Social Media Content Pack',
  'Annual Report Showcase',
  'Training & Onboarding Series',
  'Event Highlight Reel',
  'Behind the Scenes Documentary',
  'Client Testimonial Videos',
  'Website Hero Video',
  'Recruitment Campaign',
  'Q4 Marketing Campaign',
  'Executive Interview Series',
  'Conference Coverage',
  'New Office Reveal',
  'Safety & Compliance Film',
  'Investment Pitch Video',
  'Culture & Values Documentary',
  'Product Demo Reel',
  'End of Year Review',
]

// 12 open projects with varying statuses, 8 closed
const OPEN_STATUSES: ProjectStatus[] = [
  'NOT_STARTED', 'IN_PROGRESS', 'IN_PROGRESS', 'IN_REVIEW', 'IN_REVIEW',
  'IN_REVIEW', 'ON_HOLD', 'REVIEWED', 'IN_PROGRESS', 'SHARE_ONLY',
  'NOT_STARTED', 'IN_PROGRESS',
]
const CLOSED_STATUSES: ProjectStatus[] = [
  'APPROVED', 'CLOSED', 'APPROVED', 'CLOSED', 'APPROVED', 'CLOSED', 'APPROVED', 'CLOSED',
]
const ALL_PROJECT_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES]

// Key date types for open projects
const KEY_DATE_TYPES: ProjectKeyDateType[] = ['SHOOTING', 'DUE_DATE', 'PRE_PRODUCTION', 'OTHER']

// ---------------------------------------------------------------------------
// Accounting helpers — produce realistic-ish $180k income / $50k expenses
// ---------------------------------------------------------------------------

const EXPENSE_CATEGORIES = [
  { name: 'Adobe Creative Cloud', account: '6100', amountCents: 6499, freq: 'monthly' },
  { name: 'Frame.io Subscription', account: '6100', amountCents: 4500, freq: 'monthly' },
  { name: 'AWS Storage', account: '6200', amountCents: 8750, freq: 'monthly' },
  { name: 'Office Rent', account: '6300', amountCents: 280000, freq: 'monthly' },
  { name: 'Equipment Purchase - DJI Drone', account: '6400', amountCents: 289900, freq: 'once' },
  { name: 'Equipment Purchase - Gimbal Stabiliser', account: '6400', amountCents: 89500, freq: 'once' },
  { name: 'Vehicle Fuel & Maintenance', account: '6500', amountCents: 18500, freq: 'monthly' },
  { name: 'Hard Drive Storage Media', account: '6400', amountCents: 24900, freq: 'quarterly' },
  { name: 'Colour Grading Software License', account: '6100', amountCents: 39900, freq: 'once' },
  { name: 'Professional Insurance', account: '6600', amountCents: 185000, freq: 'once' },
  { name: 'Accountant Fees', account: '6700', amountCents: 165000, freq: 'once' },
  { name: 'Marketing & Advertising', account: '6800', amountCents: 55000, freq: 'quarterly' },
  { name: 'Bank Fees', account: '6900', amountCents: 1200, freq: 'monthly' },
  { name: 'Internet & Phone', account: '6200', amountCents: 18900, freq: 'monthly' },
]

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function main() {
  console.log('🌱 Seeding demo data...\n')

  // ------------------------------------------------------------------
  // 1. Find or create the admin user to use as createdBy
  // ------------------------------------------------------------------
  let adminUser = await prisma.user.findFirst({ where: { active: true } })

  if (!adminUser) {
    throw new Error('No active user found — ensure you have run the app at least once to seed the default admin.')
  }
  console.log(`✓ Using existing user "${adminUser.name ?? adminUser.email}" as project creator`)

  // ------------------------------------------------------------------
  // 2. Create 3 Roles (Videographer, Editor, Photographer)
  // ------------------------------------------------------------------
  console.log('\n→ Creating roles...')

  const basicPermissions = {
    menuVisibility: {
      projects: true, sharePage: true, clients: false, sales: false,
      accounting: false, settings: false, users: false, security: false, analytics: false,
    },
    projectVisibility: {
      statuses: ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'ON_HOLD', 'REVIEWED', 'APPROVED', 'CLOSED', 'SHARE_ONLY'],
    },
    actions: {
      projectsPhotoVideoUploads: true,
      projectsFullControl: false,
      projectExternalCommunication: false,
      accessSharePage: true,
      manageSharePageComments: true,
      manageClients: false,
      manageClientFiles: false,
      changeSettings: false,
      sendTestEmail: false,
      manageUsers: false,
      manageRoles: false,
      viewSecurityEvents: false,
      manageSecurityEvents: false,
      viewSecurityBlocklists: false,
      manageSecurityBlocklists: false,
      viewSecurityRateLimits: false,
      manageSecurityRateLimits: false,
      manageProjectAlbums: true,
      accessProjectSettings: true,
      changeProjectSettings: false,
      uploadFilesToProjectInternal: true,
      uploadVideosOnProjects: true,
      sendNotificationsToRecipients: true,
      makeCommentsOnProjects: true,
      changeProjectStatuses: true,
      deleteProjects: false,
      viewAnalytics: false,
    },
  }

  const roles: { name: string; id: string }[] = []
  for (const roleName of ['Videographer', 'Editor', 'Photographer']) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      create: { name: roleName, permissions: basicPermissions },
      update: {},
    })
    roles.push({ name: roleName, id: role.id })
    console.log(`  ✓ Role: ${roleName}`)
  }

  // ------------------------------------------------------------------
  // 3. Create 5 Users
  // ------------------------------------------------------------------
  console.log('\n→ Creating users...')

  const USER_DATA = [
    { name: 'Alex Rivera', email: 'alex.rivera@thinktvp.com.au', roleName: 'Videographer' },
    { name: 'Jordan Blake', email: 'jordan.blake@thinktvp.com.au', roleName: 'Videographer' },
    { name: 'Morgan Lee', email: 'morgan.lee@thinktvp.com.au', roleName: 'Editor' },
    { name: 'Casey Nguyen', email: 'casey.nguyen@thinktvp.com.au', roleName: 'Editor' },
    { name: 'Taylor Smith', email: 'taylor.smith@thinktvp.com.au', roleName: 'Photographer' },
  ]

  const hashedPassword = await bcrypt.hash('Demo1234!', 12)
  const createdUsers: { id: string; name: string }[] = []

  for (let i = 0; i < USER_DATA.length; i++) {
    const u = USER_DATA[i]
    const role = roles.find(r => r.name === u.roleName)!
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        name: u.name,
        password: hashedPassword,
        appRoleId: role.id,
        displayColor: DISPLAY_COLORS[i % DISPLAY_COLORS.length],
        active: true,
      },
      update: {},
    })
    createdUsers.push({ id: user.id, name: u.name })
    console.log(`  ✓ User: ${u.name} (${u.roleName})`)
  }

  // Include the admin user in project assignments
  const allUserIds = [adminUser.id, ...createdUsers.map(u => u.id)]

  // ------------------------------------------------------------------
  // 4. Create 6 Clients with 2 recipients each
  // ------------------------------------------------------------------
  console.log('\n→ Creating clients...')

  const clientMap: Record<string, string> = {} // name → id

  for (const c of CLIENT_DATA) {
    const client = await prisma.client.upsert({
      where: { name: c.name },
      create: {
        name: c.name,
        address: c.address,
        phone: c.phone,
        website: c.website,
        active: true,
      },
      update: {},
    })
    clientMap[c.name] = client.id
    console.log(`  ✓ Client: ${c.name}`)

    // Recipients
    const recipients = RECIPIENT_DATA[c.name] ?? []
    for (const r of recipients) {
      const existing = await prisma.clientRecipient.findFirst({
        where: { clientId: client.id, email: r.email },
      })
      if (!existing) {
        await prisma.clientRecipient.create({
          data: {
            clientId: client.id,
            name: r.name,
            email: r.email,
            isPrimary: r.isPrimary,
            displayColor: DISPLAY_COLORS[Math.floor(Math.random() * DISPLAY_COLORS.length)],
            receiveNotifications: true,
            receiveSalesReminders: true,
          },
        })
      }
      console.log(`    ✓ Recipient: ${r.name}`)
    }
  }

  const clientNames = Object.keys(clientMap)

  // ------------------------------------------------------------------
  // 5. Create 20 Projects
  // ------------------------------------------------------------------
  console.log('\n→ Creating projects...')

  // Check for accounting accounts we'll need
  let incomeAccount = await prisma.account.findFirst({ where: { type: 'INCOME', isActive: true } })
  let expenseAccount = await prisma.account.findFirst({ where: { type: 'EXPENSE', isActive: true } })

  // Distribute projects evenly-ish across clients (20 / 6 ≈ 3-4 per client)
  const projectClientAssignments: string[] = []
  for (let i = 0; i < 20; i++) {
    projectClientAssignments.push(clientNames[i % clientNames.length])
  }
  // Shuffle to avoid perfectly sequential grouping
  for (let i = projectClientAssignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [projectClientAssignments[i], projectClientAssignments[j]] = [projectClientAssignments[j], projectClientAssignments[i]]
  }

  const createdProjects: { id: string; title: string; clientId: string; clientName: string; createdAt: Date; status: ProjectStatus; isClosed: boolean }[] = []

  for (let i = 0; i < 20; i++) {
    const fraction = i / 19 // 0..1 spread across the year
    const projectDate = interpolateDate(START_DATE, END_DATE, fraction)
    const clientName = projectClientAssignments[i]
    const clientId = clientMap[clientName]
    const title = PROJECT_TITLES[i]
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + (i + 1)
    const status = ALL_PROJECT_STATUSES[i]
    const isClosed = i >= 12 // last 8 are closed

    const existingProject = await prisma.project.findUnique({ where: { slug } })
    if (existingProject) {
      console.log(`  ⚠ Project slug "${slug}" already exists, skipping`)
      createdProjects.push({ id: existingProject.id, title, clientId, clientName, createdAt: existingProject.createdAt, status: existingProject.status, isClosed })
      continue
    }

    const project = await prisma.project.create({
      data: {
        title,
        slug,
        clientId,
        companyName: clientName,
        status,
        startDate: projectDate,
        createdAt: projectDate,
        updatedAt: projectDate,
        approvedAt: isClosed ? addDays(projectDate, randomBetween(30, 60)) : undefined,
        createdById: adminUser.id,
        authMode: 'PASSWORD',
        enableVideos: true,
        enablePhotos: Math.random() > 0.5,
      },
    })

    // Assign all users
    for (const userId of allUserIds) {
      await prisma.projectUser.upsert({
        where: { projectId_userId: { projectId: project.id, userId } },
        create: { projectId: project.id, userId, receiveNotifications: true },
        update: {},
      })
    }

    createdProjects.push({ id: project.id, title, clientId, clientName, createdAt: projectDate, status, isClosed })
    console.log(`  ✓ Project [${i + 1}/20]: "${title}" → ${clientName} (${status})`)
  }

  // ------------------------------------------------------------------
  // 6. Add Key Dates to open projects (roughly half of them, next 1-2 months)
  // ------------------------------------------------------------------
  console.log('\n→ Adding key dates to open projects...')

  const openProjects = createdProjects.filter(p => !p.isClosed)
  const projectsWithKeyDates = openProjects.slice(0, 7)
  const futureBase = new Date('2026-06-20')

  for (let i = 0; i < projectsWithKeyDates.length; i++) {
    const p = projectsWithKeyDates[i]
    const daysAhead = randomBetween(7, 60)
    const keyDate = addDays(futureBase, daysAhead)
    const type = KEY_DATE_TYPES[i % KEY_DATE_TYPES.length]

    const typeLabel: Record<ProjectKeyDateType, string> = {
      SHOOTING: 'Shoot Day',
      DUE_DATE: 'Final Delivery Due',
      PRE_PRODUCTION: 'Pre-Production Meeting',
      OTHER: 'Client Review Call',
    }

    await prisma.projectKeyDate.create({
      data: {
        projectId: p.id,
        date: toYmd(keyDate),
        allDay: type !== 'SHOOTING',
        startTime: type === 'SHOOTING' ? '08:00' : undefined,
        finishTime: type === 'SHOOTING' ? '17:00' : undefined,
        type,
        notes: `${typeLabel[type]} for ${p.title}`,
      },
    })
    console.log(`  ✓ Key date for "${p.title}": ${toYmd(keyDate)} (${type})`)
  }

  // ------------------------------------------------------------------
  // 7. Quotes, Invoices & Payments for each project
  // ------------------------------------------------------------------
  console.log('\n→ Creating quotes, invoices & payments for projects...')

  // We'll spread $180k revenue across 20 projects
  // Average $9k per project, range $3k - $18k
  const projectRevenues = [
    18000, 15000, 12500, 14000, 9500, 8000, 11000, 16000, 7500, 9000,
    13000, 6500, 17500, 10000, 8500, 12000, 7000, 9500, 11500, 4500,
  ] // total = ~230k, but some are open so invoices won't all be paid — that's fine

  let quoteCounter = 1
  let invoiceCounter = 1

  for (let i = 0; i < createdProjects.length; i++) {
    const p = createdProjects[i]
    const totalCents = projectRevenues[i] * 100
    const inv1Cents = Math.round(totalCents * 0.5) // 50% deposit
    const inv2Cents = totalCents - inv1Cents // remainder

    // Quote date: project creation date
    const quoteDate = p.createdAt
    const quoteNumber = `EST-${String(quoteCounter).padStart(4, '0')}`
    quoteCounter++

    const serviceDescription = `${p.title} — Full Production Package`

    const quoteItemsJson = [
      {
        id: `item-${i}-1`,
        description: serviceDescription,
        quantity: 1,
        unitPriceCents: Math.round(totalCents * 0.85),
        taxable: true,
      },
      {
        id: `item-${i}-2`,
        description: 'Travel & Location Expenses',
        quantity: 1,
        unitPriceCents: Math.round(totalCents * 0.15),
        taxable: true,
      },
    ]

    const quote = await prisma.salesQuote.create({
      data: {
        quoteNumber,
        status: 'ACCEPTED',
        acceptedFromStatus: 'SENT',
        clientId: p.clientId,
        projectId: p.id,
        issueDate: toYmd(quoteDate),
        validUntil: toYmd(addDays(quoteDate, 30)),
        notes: `Thank you for choosing ThinkTVP for your ${p.title} project.`,
        terms: 'Payment due within 14 days of invoice date. 50% deposit required to commence production.',
        itemsJson: quoteItemsJson,
        sentAt: addDays(quoteDate, 1),
        taxEnabled: true,
        createdAt: quoteDate,
        updatedAt: quoteDate,
      },
    })

    // Invoice 1 — deposit, ~2 weeks after quote
    const inv1Date = addDays(quoteDate, 14)
    const inv1DueDate = addDays(inv1Date, 14)
    const inv1Number = `INV-${String(invoiceCounter).padStart(4, '0')}`
    invoiceCounter++

    const invoice1 = await prisma.salesInvoice.create({
      data: {
        invoiceNumber: inv1Number,
        status: 'PAID',
        clientId: p.clientId,
        projectId: p.id,
        issueDate: toYmd(inv1Date),
        dueDate: toYmd(inv1DueDate),
        notes: `Deposit invoice for ${p.title}.`,
        terms: 'Payment due within 14 days.',
        itemsJson: [
          {
            id: `inv1-${i}-1`,
            description: `${serviceDescription} — 50% Deposit`,
            quantity: 1,
            unitPriceCents: inv1Cents,
            taxable: true,
          },
        ],
        sentAt: addDays(inv1Date, 1),
        taxEnabled: true,
        createdAt: inv1Date,
        updatedAt: inv1Date,
      },
    })

    // Payment 1
    const pay1Date = addDays(inv1DueDate, randomBetween(-5, 3))
    await prisma.salesPayment.create({
      data: {
        source: 'MANUAL',
        paymentDate: toYmd(pay1Date),
        amountCents: inv1Cents,
        method: 'Bank Transfer',
        reference: `REF-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        clientId: p.clientId,
        invoiceId: invoice1.id,
        createdAt: pay1Date,
        updatedAt: pay1Date,
      },
    })

    // Invoice 2 — final, 60% through project lifecycle (or near delivery)
    const inv2Date = p.isClosed
      ? addDays(quoteDate, randomBetween(45, 80))
      : addDays(quoteDate, randomBetween(30, 60))
    const inv2DueDate = addDays(inv2Date, 14)
    const inv2Number = `INV-${String(invoiceCounter).padStart(4, '0')}`
    invoiceCounter++

    const inv2Status: SalesInvoiceStatus = p.isClosed ? 'PAID' : (Math.random() > 0.4 ? 'PAID' : 'SENT')

    const invoice2 = await prisma.salesInvoice.create({
      data: {
        invoiceNumber: inv2Number,
        status: inv2Status,
        clientId: p.clientId,
        projectId: p.id,
        issueDate: toYmd(inv2Date),
        dueDate: toYmd(inv2DueDate),
        notes: `Final invoice for ${p.title}.`,
        terms: 'Payment due within 14 days.',
        itemsJson: [
          {
            id: `inv2-${i}-1`,
            description: `${serviceDescription} — Final Balance`,
            quantity: 1,
            unitPriceCents: inv2Cents,
            taxable: true,
          },
        ],
        sentAt: addDays(inv2Date, 1),
        taxEnabled: true,
        createdAt: inv2Date,
        updatedAt: inv2Date,
      },
    })

    // Payment 2 (only if invoice is paid)
    if (inv2Status === 'PAID') {
      const pay2Date = addDays(inv2DueDate, randomBetween(-5, 5))
      await prisma.salesPayment.create({
        data: {
          source: 'MANUAL',
          paymentDate: toYmd(pay2Date),
          amountCents: inv2Cents,
          method: Math.random() > 0.3 ? 'Bank Transfer' : 'Credit Card',
          reference: `REF-${String(Math.floor(Math.random() * 900000) + 100000)}`,
          clientId: p.clientId,
          invoiceId: invoice2.id,
          createdAt: pay2Date,
          updatedAt: pay2Date,
        },
      })
    }

    console.log(`  ✓ Quote ${quoteNumber} + INV ${inv1Number} + ${inv2Number} for "${p.title}"`)
  }

  // ------------------------------------------------------------------
  // 8. 5 unaccepted standalone quotes
  // ------------------------------------------------------------------
  console.log('\n→ Creating 5 unaccepted standalone quotes...')

  const standaloneTitles = [
    'Wedding Videography Package',
    'Real Estate Showcase Film',
    'Non-Profit Annual Campaign',
    'Sports Event Coverage',
    'Restaurant Brand Story',
  ]
  const standaloneStatuses: SalesQuoteStatus[] = ['SENT', 'OPEN', 'CLOSED', 'SENT', 'OPEN']
  const standaloneAmounts = [450000, 320000, 185000, 580000, 265000] // cents

  for (let i = 0; i < 5; i++) {
    const clientName = clientNames[i % clientNames.length]
    const clientId = clientMap[clientName]
    const qDate = interpolateDate(START_DATE, END_DATE, (i + 1) / 6)
    const qNumber = `EST-${String(quoteCounter).padStart(4, '0')}`
    quoteCounter++

    await prisma.salesQuote.create({
      data: {
        quoteNumber: qNumber,
        status: standaloneStatuses[i],
        clientId,
        projectId: null,
        issueDate: toYmd(qDate),
        validUntil: toYmd(addDays(qDate, 30)),
        notes: `Quote for ${standaloneTitles[i]}.`,
        terms: 'Valid for 30 days from issue date.',
        itemsJson: [
          {
            id: `sq-${i}-1`,
            description: standaloneTitles[i],
            quantity: 1,
            unitPriceCents: Math.round(standaloneAmounts[i] * 0.9),
            taxable: true,
          },
          {
            id: `sq-${i}-2`,
            description: 'Equipment & Logistics',
            quantity: 1,
            unitPriceCents: Math.round(standaloneAmounts[i] * 0.1),
            taxable: true,
          },
        ],
        sentAt: standaloneStatuses[i] !== 'OPEN' ? addDays(qDate, 1) : null,
        taxEnabled: true,
        createdAt: qDate,
        updatedAt: qDate,
      },
    })
    console.log(`  ✓ Standalone quote ${qNumber}: "${standaloneTitles[i]}" (${standaloneStatuses[i]})`)
  }

  // ------------------------------------------------------------------
  // 9. Accounting data — chart of accounts + journal entries
  // ------------------------------------------------------------------
  console.log('\n→ Setting up accounting data...')

  // Ensure basic accounts exist
  const accountDefs = [
    { code: '1000', name: 'Business Cheque Account', type: 'ASSET' as AccountType, taxCode: 'BAS_EXCLUDED' as AccountTaxCode },
    { code: '2000', name: 'GST Payable', type: 'LIABILITY' as AccountType, taxCode: 'BAS_EXCLUDED' as AccountTaxCode },
    { code: '4000', name: 'Video Production Revenue', type: 'INCOME' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '4010', name: 'Photography Revenue', type: 'INCOME' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6100', name: 'Software Subscriptions', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6200', name: 'Cloud & Hosting', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6300', name: 'Rent & Facilities', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6400', name: 'Equipment & Hardware', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6500', name: 'Vehicle Expenses', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6600', name: 'Insurance', type: 'EXPENSE' as AccountType, taxCode: 'GST_FREE' as AccountTaxCode },
    { code: '6700', name: 'Professional Services', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6800', name: 'Marketing & Advertising', type: 'EXPENSE' as AccountType, taxCode: 'GST' as AccountTaxCode },
    { code: '6900', name: 'Bank Charges', type: 'EXPENSE' as AccountType, taxCode: 'BAS_EXCLUDED' as AccountTaxCode },
  ]

  const accountCodeMap: Record<string, string> = {}

  for (const acc of accountDefs) {
    const account = await prisma.account.upsert({
      where: { code: acc.code },
      create: {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        taxCode: acc.taxCode,
        isActive: true,
        isSystem: false,
      },
      update: {},
    })
    accountCodeMap[acc.code] = account.id
  }
  console.log(`  ✓ Chart of accounts: ${accountDefs.length} accounts created/verified`)

  // Income journal entries — spread $180k across the year as monthly income
  const monthlyIncome = [
    12000, 14000, 18000, 11000, 16000, 9000, 20000, 15000, 13000, 17000, 22000, 13000,
  ] // total = 180000
  const incomeAccountId = accountCodeMap['4000']

  for (let month = 0; month < 12; month++) {
    const entryDate = new Date(2025, 6 + month, 15) // July 2025 = month 6
    if (entryDate > END_DATE) break

    await prisma.journalEntry.create({
      data: {
        date: toYmd(entryDate),
        accountId: incomeAccountId,
        description: `Video production revenue — ${entryDate.toLocaleString('en-AU', { month: 'long', year: 'numeric' })}`,
        amountCents: monthlyIncome[month] * 100,
        taxCode: 'GST',
        reference: `REV-${2025 + Math.floor((6 + month) / 12)}-${String((6 + month) % 12 + 1).padStart(2, '0')}`,
        enteredByName: adminUser.name ?? 'Admin',
        createdAt: entryDate,
        updatedAt: entryDate,
      },
    })
  }
  console.log(`  ✓ Income journal entries: $180,000 spread across Jul 2025 – Jun 2026`)

  // Expense journal entries
  let totalExpenseCents = 0
  const expenseEntries: { date: string; accountCode: string; description: string; amountCents: number }[] = []

  for (const exp of EXPENSE_CATEGORIES) {
    if (exp.freq === 'monthly') {
      for (let month = 0; month < 12; month++) {
        const d = new Date(2025, 6 + month, randomBetween(1, 28))
        if (d > END_DATE) break
        expenseEntries.push({ date: toYmd(d), accountCode: exp.account, description: exp.name, amountCents: exp.amountCents })
        totalExpenseCents += exp.amountCents
      }
    } else if (exp.freq === 'quarterly') {
      for (let q = 0; q < 4; q++) {
        const d = new Date(2025, 6 + q * 3, randomBetween(1, 28))
        if (d > END_DATE) break
        expenseEntries.push({ date: toYmd(d), accountCode: exp.account, description: exp.name, amountCents: exp.amountCents })
        totalExpenseCents += exp.amountCents
      }
    } else {
      // once
      const d = interpolateDate(START_DATE, END_DATE, Math.random())
      expenseEntries.push({ date: toYmd(d), accountCode: exp.account, description: exp.name, amountCents: exp.amountCents })
      totalExpenseCents += exp.amountCents
    }
  }

  for (const entry of expenseEntries) {
    const accountId = accountCodeMap[entry.accountCode]
    if (!accountId) continue
    await prisma.journalEntry.create({
      data: {
        date: entry.date,
        accountId,
        description: entry.description,
        amountCents: -Math.abs(entry.amountCents), // expenses are negative
        taxCode: 'GST',
        enteredByName: adminUser.name ?? 'Admin',
      },
    })
  }
  console.log(`  ✓ Expense journal entries: ~$${Math.round(totalExpenseCents / 100).toLocaleString()} across ${expenseEntries.length} entries`)

  // ------------------------------------------------------------------
  // Done!
  // ------------------------------------------------------------------
  console.log('\n✅ Demo data seed complete!\n')
  console.log('Summary:')
  console.log(`  • 6 clients with 2 recipients each`)
  console.log(`  • 3 roles: Videographer, Editor, Photographer`)
  console.log(`  • 5 staff users (password: Demo1234!)`)
  console.log(`  • 20 projects (12 open, 8 closed), each assigned to all users`)
  console.log(`  • 7 open projects with key dates in the next 1-2 months`)
  console.log(`  • 20 accepted quotes + 40 invoices + payments per project`)
  console.log(`  • 5 standalone unaccepted quotes`)
  console.log(`  • Accounting: ~$180k income + ~$${Math.round(totalExpenseCents / 100).toLocaleString()} expenses`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())

import { prisma } from '@/lib/db'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'
import {
  VEHICLE_ODOMETER_REMINDER_NOTIFICATION_TYPE,
  BAS_DUE_REMINDER_NOTIFICATION_TYPE,
} from '@/lib/pinned-system-notifications'

/**
 * Run all accounting reminder checks.
 * Called daily by the worker scheduler.
 */
export async function processAccountingReminders(now: Date): Promise<void> {
  await checkVehicleOdometerReminder(now)
  await checkBasDueReminders(now)
}

// ─── Vehicle Annual Odometer Reminder ────────────────────────────────────────
//
// Fires on 1 July each year when at least one active vehicle with a logbook
// exists. The notification is pinned and manually clearable. It will not
// re-appear until the following 1 July.

async function checkVehicleOdometerReminder(now: Date): Promise<void> {
  const month = now.getMonth() + 1 // 1-indexed
  const day = now.getDate()

  // Only trigger on 1 July
  if (month !== 7 || day !== 1) return

  // FY label for the year that just started (1 July 2026 → FY2027)
  const fyLabel = `FY${now.getFullYear() + 1}`

  // Check if any active vehicle with at least one logbook exists
  const vehicle = await prisma.vehicle.findFirst({
    where: {
      isActive: true,
      logbooks: { some: {} },
    },
    select: { id: true },
  })

  if (!vehicle) return

  // Skip if notification for this financial year was already created
  const existing = await prisma.pushNotificationLog.findFirst({
    where: {
      type: VEHICLE_ODOMETER_REMINDER_NOTIFICATION_TYPE,
      details: { path: ['financialYear'], equals: fyLabel },
    },
    select: { id: true },
  })

  if (existing) return

  // Remove any leftover notifications from prior years before creating the new one
  await prisma.pushNotificationLog.deleteMany({
    where: { type: VEHICLE_ODOMETER_REMINDER_NOTIFICATION_TYPE },
  })

  const fyStart = now.getFullYear()
  const fyEnd = fyStart + 1

  const title = 'Annual Odometer Reading required'
  const message = `A ${fyLabel} annual odometer entry is required for your vehicle(s).`

  const details = {
    __payload: { title, message },
    __link: { href: '/admin/accounting/vehicles' },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    financialYear: fyLabel,
    Period: `1 July ${fyStart} – 30 June ${fyEnd}`,
    Action: 'Record the opening odometer reading for each vehicle on the Vehicles page.',
  }

  await prisma.pushNotificationLog.create({
    data: {
      type: VEHICLE_ODOMETER_REMINDER_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt: now,
    },
  })

  sendBrowserPushToEligibleUsers({
    type: 'VEHICLE_ODOMETER_REMINDER',
    title,
    message,
    details: { __link: { href: '/admin/accounting/vehicles' } },
  }).catch(() => {})
}

// ─── BAS Quarterly Due Date Reminders ────────────────────────────────────────
//
// Australian BAS due dates (28th of the due month):
//   Q1 (Jul–Sep): due 28 October  — reminder starts 15 October
//   Q2 (Oct–Dec): due 28 February — reminder starts 15 February
//   Q3 (Jan–Mar): due 28 April   — reminder starts 15 April
//   Q4 (Apr–Jun): due 28 July    — reminder starts 15 July
//
// The reminder is suppressed when a LODGED BasPeriod exists for the quarter.
// Existing reminders are cleared automatically when BAS is lodged (daily sweep).

type BasReminderPeriod = {
  /** Plain 4-digit year as stored in BasPeriod.financialYear, e.g. "2027" */
  financialYear: string
  quarter: number
  /** Human-readable description, e.g. "Q1 FY2027 (Jul–Sep 2026)" */
  label: string
  /** Formatted due date string for display */
  dueDate: string
  /** Unique dedup key stored in notification details, e.g. "2027-Q1" */
  periodKey: string
}

/** Returns the BAS period that needs a reminder today, or null if not a reminder day. */
function getCurrentBasReminderPeriod(now: Date): BasReminderPeriod | null {
  const month = now.getMonth() + 1
  const day = now.getDate()
  const year = now.getFullYear()

  // Reminder only starts on the 15th of the trigger month
  if (day < 15) return null

  if (month === 10) {
    // Q1 of FY(year+1): covers Jul–Sep of current calendar year
    const fy = year + 1
    return {
      financialYear: String(fy),
      quarter: 1,
      label: `Q1 FY${fy} (Jul–Sep ${year})`,
      dueDate: `28 October ${year}`,
      periodKey: `${fy}-Q1`,
    }
  }

  if (month === 2) {
    // Q2 of FY(year): covers Oct–Dec of previous calendar year
    return {
      financialYear: String(year),
      quarter: 2,
      label: `Q2 FY${year} (Oct–Dec ${year - 1})`,
      dueDate: `28 February ${year}`,
      periodKey: `${year}-Q2`,
    }
  }

  if (month === 4) {
    // Q3 of FY(year): covers Jan–Mar of current calendar year
    return {
      financialYear: String(year),
      quarter: 3,
      label: `Q3 FY${year} (Jan–Mar ${year})`,
      dueDate: `28 April ${year}`,
      periodKey: `${year}-Q3`,
    }
  }

  if (month === 7) {
    // Q4 of FY(year): covers Apr–Jun of current calendar year
    return {
      financialYear: String(year),
      quarter: 4,
      label: `Q4 FY${year} (Apr–Jun ${year})`,
      dueDate: `28 July ${year}`,
      periodKey: `${year}-Q4`,
    }
  }

  return null
}

async function checkBasDueReminders(now: Date): Promise<void> {
  // Daily sweep: clear any reminders where the BAS has since been lodged
  await clearLodgedBasReminders()

  const period = getCurrentBasReminderPeriod(now)
  if (!period) return

  // No reminder needed if BAS for this period is already lodged
  const lodged = await prisma.basPeriod.findFirst({
    where: {
      financialYear: period.financialYear,
      quarter: period.quarter,
      status: 'LODGED',
    },
    select: { id: true },
  })
  if (lodged) return

  // Skip if a reminder for this exact period already exists
  const existing = await prisma.pushNotificationLog.findFirst({
    where: {
      type: BAS_DUE_REMINDER_NOTIFICATION_TYPE,
      details: { path: ['periodKey'], equals: period.periodKey },
    },
    select: { id: true },
  })
  if (existing) return

  // Remove any stale reminders from prior periods (only one BAS reminder active at a time)
  await prisma.pushNotificationLog.deleteMany({
    where: { type: BAS_DUE_REMINDER_NOTIFICATION_TYPE },
  })

  const title = 'BAS due soon'
  const message = `${period.label} BAS is due ${period.dueDate}.`

  const details = {
    __payload: { title, message },
    __link: { href: '/admin/accounting/bas' },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    periodKey: period.periodKey,
    Period: period.label,
    'Due date': period.dueDate,
    Status: 'Not yet lodged',
  }

  await prisma.pushNotificationLog.create({
    data: {
      type: BAS_DUE_REMINDER_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt: now,
    },
  })

  sendBrowserPushToEligibleUsers({
    type: 'BAS_DUE_REMINDER',
    title,
    message,
    details: { __link: { href: '/admin/accounting/bas' } },
  }).catch(() => {})
}

/**
 * Find all existing BAS due reminder notifications and delete any where the
 * corresponding BAS period has since been lodged.
 */
async function clearLodgedBasReminders(): Promise<void> {
  const rows = await prisma.pushNotificationLog.findMany({
    where: { type: BAS_DUE_REMINDER_NOTIFICATION_TYPE },
    select: { id: true, details: true },
  })

  for (const row of rows) {
    const periodKey = typeof (row.details as any)?.periodKey === 'string'
      ? (row.details as any).periodKey as string
      : null

    if (!periodKey) {
      // Malformed entry — remove it
      await prisma.pushNotificationLog.delete({ where: { id: row.id } })
      continue
    }

    // periodKey format: "{year}-Q{quarter}", e.g. "2027-Q1"
    const match = /^(\d+)-Q(\d+)$/.exec(periodKey)
    if (!match) {
      await prisma.pushNotificationLog.delete({ where: { id: row.id } })
      continue
    }

    const financialYear = match[1]
    const quarter = parseInt(match[2], 10)

    const lodged = await prisma.basPeriod.findFirst({
      where: { financialYear, quarter, status: 'LODGED' },
      select: { id: true },
    })

    if (lodged) {
      await prisma.pushNotificationLog.delete({ where: { id: row.id } })
    }
  }
}

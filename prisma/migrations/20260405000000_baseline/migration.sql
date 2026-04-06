-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProjectKeyDateType" AS ENUM ('PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectEmailStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "AlbumStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "AlbumPhotoStatus" AS ENUM ('UPLOADING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "AlbumPhotoSocialStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "ProjectStatusChangeSource" AS ENUM ('ADMIN', 'CLIENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('IN_REVIEW', 'ON_HOLD', 'APPROVED', 'SHARE_ONLY', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEWED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('UPLOADING', 'QUEUED', 'PROCESSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationQueueType" AS ENUM ('CLIENT_COMMENT', 'ADMIN_REPLY', 'INTERNAL_COMMENT', 'TASK_COMMENT');

-- CreateEnum
CREATE TYPE "CompanyLogoMode" AS ENUM ('NONE', 'UPLOAD', 'LINK');

-- CreateEnum
CREATE TYPE "SalesDocShareType" AS ENUM ('QUOTE', 'INVOICE');

-- CreateEnum
CREATE TYPE "SalesQuoteStatus" AS ENUM ('OPEN', 'SENT', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SalesInvoiceStatus" AS ENUM ('OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "SalesPaymentSource" AS ENUM ('MANUAL', 'STRIPE', 'QUICKBOOKS');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "notes" TEXT,
    "phone" TEXT,
    "avatarPath" TEXT,
    "displayColor" VARCHAR(7),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "appRoleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "calendarFeedToken" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystemAdmin" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quickbooksCustomerId" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientRecipient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "displayColor" VARCHAR(7),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "receiveNotifications" BOOLEAN NOT NULL DEFAULT true,
    "receiveSalesReminders" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReminderSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "overdueInvoiceRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "overdueInvoiceBusinessDaysAfterDue" INTEGER NOT NULL DEFAULT 3,
    "quoteExpiryRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quoteExpiryBusinessDaysBeforeValidUntil" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesReminderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientFile" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "companyName" TEXT,
    "clientId" TEXT,
    "storagePath" TEXT,
    "sharePassword" TEXT,
    "authMode" TEXT NOT NULL DEFAULT 'PASSWORD',
    "guestMode" BOOLEAN NOT NULL DEFAULT false,
    "guestLatestOnly" BOOLEAN NOT NULL DEFAULT true,
    "allowAuthenticatedProjectSwitching" BOOLEAN NOT NULL DEFAULT true,
    "enableVideos" BOOLEAN NOT NULL DEFAULT true,
    "enablePhotos" BOOLEAN NOT NULL DEFAULT false,
    "enableRevisions" BOOLEAN NOT NULL DEFAULT false,
    "maxRevisions" INTEGER NOT NULL DEFAULT 3,
    "status" "ProjectStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "startDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastAccessedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedVideoId" TEXT,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "diskBytes" BIGINT,
    "restrictCommentsToLatestVersion" BOOLEAN NOT NULL DEFAULT false,
    "hideFeedback" BOOLEAN NOT NULL DEFAULT false,
    "useFullTimecode" BOOLEAN NOT NULL DEFAULT false,
    "allowClientDeleteComments" BOOLEAN NOT NULL DEFAULT false,
    "allowClientUploadFiles" BOOLEAN NOT NULL DEFAULT false,
    "maxClientUploadAllocationMB" INTEGER NOT NULL DEFAULT 1000,
    "previewResolutions" TEXT NOT NULL DEFAULT '["720p"]',
    "watermarkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "watermarkText" TEXT,
    "timelinePreviewsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowAssetDownload" BOOLEAN NOT NULL DEFAULT true,
    "clientNotificationSchedule" TEXT NOT NULL DEFAULT 'HOURLY',
    "clientNotificationTime" TEXT,
    "clientNotificationDay" INTEGER,
    "lastClientNotificationSent" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectKeyDate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT,
    "finishTime" TEXT,
    "type" "ProjectKeyDateType" NOT NULL,
    "notes" TEXT,
    "reminderAt" TIMESTAMP(3),
    "reminderTargets" JSONB,
    "reminderSentAt" TIMESTAMP(3),
    "reminderLastAttemptAt" TIMESTAMP(3),
    "reminderAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "reminderLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectKeyDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserKeyDate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT,
    "finishTime" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "reminderAt" TIMESTAMP(3),
    "reminderTargets" JSONB,
    "reminderSentAt" TIMESTAMP(3),
    "reminderLastAttemptAt" TIMESTAMP(3),
    "reminderAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "reminderLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserKeyDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectEmail" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "rawFileName" TEXT NOT NULL,
    "rawFileSize" BIGINT NOT NULL,
    "rawFileType" TEXT NOT NULL,
    "rawStoragePath" TEXT NOT NULL,
    "rawSha256" VARCHAR(64),
    "subject" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "sentAt" TIMESTAMP(3),
    "textBody" TEXT,
    "htmlBody" TEXT,
    "attachmentsCount" INTEGER NOT NULL DEFAULT 0,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProjectEmailStatus" NOT NULL DEFAULT 'UPLOADING',
    "errorMessage" TEXT,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectEmailAttachment" (
    "id" TEXT NOT NULL,
    "projectEmailId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "isInline" BOOLEAN NOT NULL DEFAULT false,
    "contentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectEmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Album" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageFolderName" TEXT,
    "notes" VARCHAR(500),
    "status" "AlbumStatus" NOT NULL DEFAULT 'READY',
    "fullZipFileSize" BIGINT NOT NULL DEFAULT 0,
    "socialZipFileSize" BIGINT NOT NULL DEFAULT 0,
    "socialCopiesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fullZipDropboxStatus" TEXT,
    "fullZipDropboxProgress" INTEGER NOT NULL DEFAULT 0,
    "fullZipDropboxError" TEXT,
    "fullZipDropboxPath" TEXT,
    "socialZipDropboxStatus" TEXT,
    "socialZipDropboxProgress" INTEGER NOT NULL DEFAULT 0,
    "socialZipDropboxError" TEXT,
    "socialZipDropboxPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumPhoto" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "AlbumPhotoStatus" NOT NULL DEFAULT 'UPLOADING',
    "error" TEXT,
    "socialStoragePath" TEXT,
    "socialStatus" "AlbumPhotoSocialStatus" NOT NULL DEFAULT 'PENDING',
    "socialError" TEXT,
    "socialGeneratedAt" TIMESTAMP(3),
    "socialFileSize" BIGINT NOT NULL DEFAULT 0,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlbumPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectUser" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "receiveNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectUser_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "ProjectStatusChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "previousStatus" "ProjectStatus" NOT NULL,
    "currentStatus" "ProjectStatus" NOT NULL,
    "source" "ProjectStatusChangeSource" NOT NULL DEFAULT 'SYSTEM',
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRecipient" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientRecipientId" TEXT,
    "email" TEXT,
    "name" TEXT,
    "displayColor" VARCHAR(7),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "receiveNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageFolderName" TEXT,
    "version" INTEGER NOT NULL,
    "versionLabel" TEXT NOT NULL,
    "videoNotes" VARCHAR(500),
    "originalFileName" TEXT NOT NULL,
    "originalFileSize" BIGINT NOT NULL,
    "originalStoragePath" TEXT NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" DOUBLE PRECISION,
    "codec" TEXT,
    "status" "VideoStatus" NOT NULL DEFAULT 'UPLOADING',
    "uploadProgress" INTEGER NOT NULL DEFAULT 0,
    "processingProgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "processingPhase" TEXT,
    "processingError" TEXT,
    "preview1080Path" TEXT,
    "preview720Path" TEXT,
    "preview480Path" TEXT,
    "thumbnailPath" TEXT,
    "timelinePreviewsReady" BOOLEAN NOT NULL DEFAULT false,
    "timelinePreviewVttPath" TEXT,
    "timelinePreviewSpritesPath" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "allowApproval" BOOLEAN NOT NULL DEFAULT false,
    "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dropboxPath" TEXT,
    "dropboxUploadStatus" TEXT,
    "dropboxUploadProgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dropboxUploadError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dropboxPath" TEXT,
    "dropboxUploadStatus" TEXT,
    "dropboxUploadProgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dropboxUploadError" TEXT,
    "expiresAt" TIMESTAMP(3),
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "videoVersion" INTEGER,
    "timecode" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorName" TEXT,
    "authorEmail" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "displayColorSnapshot" VARCHAR(7),
    "recipientId" TEXT,
    "userId" TEXT,
    "parentId" TEXT,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectInternalComment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "authorNameSnapshot" TEXT,
    "displayColorSnapshot" VARCHAR(7),
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "ProjectInternalComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationQueue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "NotificationQueueType" NOT NULL,
    "kanbanCardId" TEXT,
    "sentToClients" BOOLEAN NOT NULL DEFAULT false,
    "sentToAdmins" BOOLEAN NOT NULL DEFAULT false,
    "clientSentAt" TIMESTAMP(3),
    "adminSentAt" TIMESTAMP(3),
    "clientAttempts" INTEGER NOT NULL DEFAULT 0,
    "adminAttempts" INTEGER NOT NULL DEFAULT 0,
    "clientFailed" BOOLEAN NOT NULL DEFAULT false,
    "adminFailed" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "companyName" TEXT DEFAULT 'Studio',
    "companyLogoMode" "CompanyLogoMode" NOT NULL DEFAULT 'NONE',
    "companyLogoPath" TEXT,
    "companyLogoUrl" TEXT,
    "darkLogoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "darkLogoMode" "CompanyLogoMode" NOT NULL DEFAULT 'NONE',
    "darkLogoPath" TEXT,
    "darkLogoUrl" TEXT,
    "accentColor" TEXT,
    "accentTextMode" TEXT NOT NULL DEFAULT 'LIGHT',
    "defaultTheme" TEXT NOT NULL DEFAULT 'DARK',
    "allowThemeToggle" BOOLEAN NOT NULL DEFAULT true,
    "emailHeaderColor" TEXT,
    "emailHeaderTextMode" TEXT NOT NULL DEFAULT 'LIGHT',
    "companyFaviconMode" "CompanyLogoMode" NOT NULL DEFAULT 'NONE',
    "companyFaviconPath" TEXT,
    "companyFaviconUrl" TEXT,
    "smtpServer" TEXT,
    "smtpPort" INTEGER DEFAULT 587,
    "smtpUsername" TEXT,
    "smtpPassword" TEXT,
    "smtpFromAddress" TEXT,
    "smtpSecure" TEXT DEFAULT 'STARTTLS',
    "emailTrackingPixelsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailCustomFooterText" TEXT,
    "appDomain" TEXT,
    "mainCompanyDomain" TEXT,
    "webPushVapidPublicKey" TEXT,
    "webPushVapidPrivateKeyEncrypted" TEXT,
    "maxUploadSizeGB" INTEGER NOT NULL DEFAULT 1,
    "uploadChunkSizeMB" INTEGER NOT NULL DEFAULT 200,
    "downloadChunkSizeMB" INTEGER NOT NULL DEFAULT 16,
    "defaultPreviewResolutions" TEXT DEFAULT '["720p"]',
    "defaultWatermarkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultTimelinePreviewsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultWatermarkText" TEXT,
    "defaultAllowClientDeleteComments" BOOLEAN NOT NULL DEFAULT false,
    "defaultAllowClientUploadFiles" BOOLEAN NOT NULL DEFAULT false,
    "defaultAllowAuthenticatedProjectSwitching" BOOLEAN NOT NULL DEFAULT true,
    "defaultMaxClientUploadAllocationMB" INTEGER NOT NULL DEFAULT 1000,
    "autoApproveProject" BOOLEAN NOT NULL DEFAULT true,
    "autoDeletePreviewsOnClose" BOOLEAN NOT NULL DEFAULT false,
    "excludeInternalIpsFromAnalytics" BOOLEAN NOT NULL DEFAULT true,
    "lastInternalCommentNotificationSent" TIMESTAMP(3),
    "lastTaskCommentNotificationSent" TIMESTAMP(3),
    "autoCloseApprovedProjectsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCloseApprovedProjectsAfterDays" INTEGER NOT NULL DEFAULT 7,
    "adminNotificationSchedule" TEXT NOT NULL DEFAULT 'HOURLY',
    "adminNotificationTime" TEXT,
    "adminNotificationDay" INTEGER,
    "lastAdminNotificationSent" TIMESTAMP(3),
    "adminEmailProjectApproved" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailInternalComments" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailTaskComments" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailInvoicePaid" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailQuoteAccepted" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailProjectKeyDates" BOOLEAN NOT NULL DEFAULT true,
    "adminEmailUserKeyDates" BOOLEAN NOT NULL DEFAULT true,
    "defaultClientNotificationSchedule" TEXT NOT NULL DEFAULT 'HOURLY',
    "defaultClientNotificationTime" TEXT,
    "defaultClientNotificationDay" INTEGER,
    "clientEmailProjectApproved" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksIntegration" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "refreshTokenEncrypted" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "dailyPullEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dailyPullTime" TEXT NOT NULL DEFAULT '21:00',
    "pullLookbackDays" INTEGER NOT NULL DEFAULT 7,
    "lastDailyPullAttemptAt" TIMESTAMP(3),
    "lastDailyPullSucceeded" BOOLEAN,
    "lastDailyPullMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksEstimateImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "docNumber" TEXT,
    "txnDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksEstimateImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksInvoiceImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "docNumber" TEXT,
    "txnDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "balance" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksInvoiceImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksPaymentImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "paymentRefNum" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksPaymentImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksPaymentAppliedInvoice" (
    "id" TEXT NOT NULL,
    "paymentImportId" TEXT NOT NULL,
    "invoiceQboId" TEXT NOT NULL,
    "invoiceImportId" TEXT,
    "amount" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickBooksPaymentAppliedInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentShare" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "type" "SalesDocShareType" NOT NULL,
    "docId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "docJson" JSONB NOT NULL,
    "settingsJson" JSONB NOT NULL,
    "clientName" TEXT,
    "projectTitle" TEXT,
    "lastAccessedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDocumentShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentViewEvent" (
    "id" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "type" "SalesDocShareType" NOT NULL,
    "docId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentViewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesEmailTracking" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "type" "SalesDocShareType" NOT NULL,
    "docId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "SalesEmailTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesStripeGatewaySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL DEFAULT 'Pay by Credit Card (card processing fee applies)',
    "feePercent" DOUBLE PRECISION NOT NULL DEFAULT 1.7,
    "feeFixedCents" INTEGER NOT NULL DEFAULT 30,
    "publishableKey" TEXT,
    "secretKeyEncrypted" TEXT,
    "dashboardPaymentDescription" TEXT NOT NULL DEFAULT 'Payment for Invoice {invoice_number}',
    "currencies" TEXT NOT NULL DEFAULT 'AUD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesStripeGatewaySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "businessName" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "abn" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "businessRegistrationLabel" TEXT NOT NULL DEFAULT 'ABN',
    "currencyCode" TEXT NOT NULL DEFAULT 'AUD',
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 7,
    "quoteLabel" TEXT NOT NULL DEFAULT 'QUOTE',
    "invoiceLabel" TEXT NOT NULL DEFAULT 'INVOICE',
    "taxLabel" TEXT NOT NULL DEFAULT '',
    "taxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "taxRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "defaultQuoteValidDays" INTEGER NOT NULL DEFAULT 14,
    "defaultInvoiceDueDays" INTEGER NOT NULL DEFAULT 7,
    "defaultTerms" TEXT NOT NULL DEFAULT 'Payment due within 7 days unless otherwise agreed.',
    "paymentDetails" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTaxRate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSequence" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "quote" INTEGER NOT NULL DEFAULT 0,
    "invoice" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesQuote" (
    "id" TEXT NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "status" "SalesQuoteStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedFromStatus" "SalesQuoteStatus",
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "issueDate" TEXT NOT NULL,
    "validUntil" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "itemsJson" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastExpiryReminderSentYmd" TEXT,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "qboId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesQuoteRevision" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "docJson" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesQuoteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "status" "SalesInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "issueDate" TEXT NOT NULL,
    "dueDate" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "itemsJson" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastOverdueReminderSentYmd" TEXT,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "qboId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoiceRevision" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "docJson" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesInvoiceRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPayment" (
    "id" TEXT NOT NULL,
    "source" "SalesPaymentSource" NOT NULL DEFAULT 'MANUAL',
    "excludeFromInvoiceBalance" BOOLEAN NOT NULL DEFAULT false,
    "paymentDate" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "clientId" TEXT,
    "invoiceId" TEXT,
    "qboId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesNativeStore" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesNativeStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoiceStripePayment" (
    "id" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "invoiceDocId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceAmountCents" INTEGER NOT NULL,
    "feeAmountCents" INTEGER NOT NULL,
    "totalAmountCents" INTEGER NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesInvoiceStripePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KanbanColumn" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "color" VARCHAR(7),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KanbanColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KanbanCard" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "columnId" TEXT NOT NULL,
    "projectId" TEXT,
    "clientId" TEXT,
    "createdById" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KanbanCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KanbanCardMember" (
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "receiveNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KanbanCardMember_pkey" PRIMARY KEY ("cardId","userId")
);

-- CreateTable
CREATE TABLE "KanbanCardComment" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT,
    "authorNameSnapshot" TEXT,
    "displayColorSnapshot" VARCHAR(7),
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "KanbanCardComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KanbanCardHistory" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorNameSnapshot" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KanbanCardHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushNotificationSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyUnauthorizedOTP" BOOLEAN NOT NULL DEFAULT true,
    "notifyFailedAdminLogin" BOOLEAN NOT NULL DEFAULT true,
    "notifySuccessfulAdminLogin" BOOLEAN NOT NULL DEFAULT true,
    "notifyFailedSharePasswordAttempt" BOOLEAN NOT NULL DEFAULT true,
    "notifySuccessfulShareAccess" BOOLEAN NOT NULL DEFAULT true,
    "notifyGuestVideoLinkAccess" BOOLEAN NOT NULL DEFAULT true,
    "notifyClientComments" BOOLEAN NOT NULL DEFAULT true,
    "notifyInternalComments" BOOLEAN NOT NULL DEFAULT true,
    "notifyTaskComments" BOOLEAN NOT NULL DEFAULT true,
    "notifyVideoApproval" BOOLEAN NOT NULL DEFAULT true,
    "notifyUserAssignments" BOOLEAN NOT NULL DEFAULT true,
    "notifySalesQuoteViewed" BOOLEAN NOT NULL DEFAULT true,
    "notifySalesQuoteAccepted" BOOLEAN NOT NULL DEFAULT true,
    "notifySalesInvoiceViewed" BOOLEAN NOT NULL DEFAULT true,
    "notifySalesInvoicePaid" BOOLEAN NOT NULL DEFAULT true,
    "notifySalesReminders" BOOLEAN NOT NULL DEFAULT true,
    "notifyPasswordResetRequested" BOOLEAN NOT NULL DEFAULT true,
    "notifyPasswordResetSuccess" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushNotificationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushNotificationLog" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "projectId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "statusCode" INTEGER,
    "message" TEXT,
    "details" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationReadState" (
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationReadState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SecuritySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "hotlinkProtection" TEXT NOT NULL DEFAULT 'LOG_ONLY',
    "ipRateLimit" INTEGER NOT NULL DEFAULT 1000,
    "sessionRateLimit" INTEGER NOT NULL DEFAULT 600,
    "shareSessionRateLimit" INTEGER NOT NULL DEFAULT 300,
    "passwordAttempts" INTEGER NOT NULL DEFAULT 5,
    "shareTokenTtlSeconds" INTEGER,
    "sessionTimeoutValue" INTEGER NOT NULL DEFAULT 15,
    "sessionTimeoutUnit" TEXT NOT NULL DEFAULT 'MINUTES',
    "httpsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trackAnalytics" BOOLEAN NOT NULL DEFAULT true,
    "trackSecurityLogs" BOOLEAN NOT NULL DEFAULT true,
    "viewSecurityEvents" BOOLEAN NOT NULL DEFAULT false,
    "maxInternalCommentsPerProject" INTEGER NOT NULL DEFAULT 250,
    "maxCommentsPerVideoVersion" INTEGER NOT NULL DEFAULT 100,
    "maxProjectRecipients" INTEGER NOT NULL DEFAULT 30,
    "maxProjectFilesPerProject" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecuritySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "projectId" TEXT,
    "videoId" TEXT,
    "sessionId" TEXT,
    "ipAddress" TEXT,
    "referer" TEXT,
    "details" JSONB,
    "wasBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedIP" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BlockedIP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedDomain" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BlockedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAnalytics" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "assetId" TEXT,
    "assetIds" TEXT,
    "ipAddress" TEXT,
    "sessionId" TEXT,
    "accessMethod" TEXT,
    "email" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumAnalytics" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "photoId" TEXT,
    "eventType" TEXT NOT NULL,
    "variant" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectEmailEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "videoId" TEXT,
    "recipientEmails" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectEmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTracking" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "videoId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "EmailTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharePageAccess" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accessMethod" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'ACCESS',
    "email" TEXT,
    "originProjectTitle" TEXT,
    "targetProjectTitle" TEXT,
    "sessionId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharePageAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestVideoShareLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestVideoShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" BYTEA NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL,
    "transports" TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "userAgent" TEXT,
    "credentialName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedIP" TEXT,

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentFile" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProjectViewSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "visibleSections" JSONB NOT NULL DEFAULT '{"sales":true,"keyDates":true,"externalCommunication":true,"users":true,"projectFiles":true,"projectData":true}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProjectViewSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesItem" (
    "id" TEXT NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "taxRatePercent" DOUBLE PRECISION NOT NULL,
    "taxRateName" VARCHAR(200),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPreset" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPresetItem" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesPresetItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_calendarFeedToken_key" ON "User"("calendarFeedToken");

-- CreateIndex
CREATE INDEX "User_active_idx" ON "User"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Client_quickbooksCustomerId_key" ON "Client"("quickbooksCustomerId");

-- CreateIndex
CREATE INDEX "Client_deletedAt_idx" ON "Client"("deletedAt");

-- CreateIndex
CREATE INDEX "Client_active_idx" ON "Client"("active");

-- CreateIndex
CREATE INDEX "Client_name_idx" ON "Client"("name");

-- CreateIndex
CREATE INDEX "Client_quickbooksCustomerId_idx" ON "Client"("quickbooksCustomerId");

-- CreateIndex
CREATE INDEX "ClientRecipient_clientId_idx" ON "ClientRecipient"("clientId");

-- CreateIndex
CREATE INDEX "ClientRecipient_clientId_email_idx" ON "ClientRecipient"("clientId", "email");

-- CreateIndex
CREATE INDEX "ClientFile_clientId_idx" ON "ClientFile"("clientId");

-- CreateIndex
CREATE INDEX "ClientFile_clientId_category_idx" ON "ClientFile"("clientId", "category");

-- CreateIndex
CREATE INDEX "UserFile_userId_idx" ON "UserFile"("userId");

-- CreateIndex
CREATE INDEX "UserFile_userId_category_idx" ON "UserFile"("userId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "ProjectKeyDate_projectId_idx" ON "ProjectKeyDate"("projectId");

-- CreateIndex
CREATE INDEX "ProjectKeyDate_projectId_date_idx" ON "ProjectKeyDate"("projectId", "date");

-- CreateIndex
CREATE INDEX "ProjectKeyDate_reminderAt_idx" ON "ProjectKeyDate"("reminderAt");

-- CreateIndex
CREATE INDEX "ProjectKeyDate_reminderSentAt_idx" ON "ProjectKeyDate"("reminderSentAt");

-- CreateIndex
CREATE INDEX "UserKeyDate_userId_idx" ON "UserKeyDate"("userId");

-- CreateIndex
CREATE INDEX "UserKeyDate_userId_date_idx" ON "UserKeyDate"("userId", "date");

-- CreateIndex
CREATE INDEX "UserKeyDate_reminderAt_idx" ON "UserKeyDate"("reminderAt");

-- CreateIndex
CREATE INDEX "UserKeyDate_reminderSentAt_idx" ON "UserKeyDate"("reminderSentAt");

-- CreateIndex
CREATE INDEX "ProjectEmail_projectId_idx" ON "ProjectEmail"("projectId");

-- CreateIndex
CREATE INDEX "ProjectEmail_projectId_sentAt_idx" ON "ProjectEmail"("projectId", "sentAt");

-- CreateIndex
CREATE INDEX "ProjectEmail_projectId_createdAt_idx" ON "ProjectEmail"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectEmail_projectId_rawSha256_key" ON "ProjectEmail"("projectId", "rawSha256");

-- CreateIndex
CREATE INDEX "ProjectEmailAttachment_projectEmailId_idx" ON "ProjectEmailAttachment"("projectEmailId");

-- CreateIndex
CREATE INDEX "Album_projectId_idx" ON "Album"("projectId");

-- CreateIndex
CREATE INDEX "Album_projectId_createdAt_idx" ON "Album"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AlbumPhoto_albumId_idx" ON "AlbumPhoto"("albumId");

-- CreateIndex
CREATE INDEX "AlbumPhoto_albumId_status_idx" ON "AlbumPhoto"("albumId", "status");

-- CreateIndex
CREATE INDEX "AlbumPhoto_albumId_socialStatus_idx" ON "AlbumPhoto"("albumId", "socialStatus");

-- CreateIndex
CREATE INDEX "ProjectFile_projectId_idx" ON "ProjectFile"("projectId");

-- CreateIndex
CREATE INDEX "ProjectFile_projectId_category_idx" ON "ProjectFile"("projectId", "category");

-- CreateIndex
CREATE INDEX "ProjectUser_userId_idx" ON "ProjectUser"("userId");

-- CreateIndex
CREATE INDEX "ProjectStatusChange_projectId_createdAt_idx" ON "ProjectStatusChange"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectRecipient_projectId_idx" ON "ProjectRecipient"("projectId");

-- CreateIndex
CREATE INDEX "ProjectRecipient_clientRecipientId_idx" ON "ProjectRecipient"("clientRecipientId");

-- CreateIndex
CREATE INDEX "ProjectRecipient_projectId_email_idx" ON "ProjectRecipient"("projectId", "email");

-- CreateIndex
CREATE INDEX "Video_projectId_version_idx" ON "Video"("projectId", "version");

-- CreateIndex
CREATE INDEX "Video_projectId_name_idx" ON "Video"("projectId", "name");

-- CreateIndex
CREATE INDEX "Video_status_idx" ON "Video"("status");

-- CreateIndex
CREATE INDEX "Video_projectId_status_idx" ON "Video"("projectId", "status");

-- CreateIndex
CREATE INDEX "VideoAsset_videoId_idx" ON "VideoAsset"("videoId");

-- CreateIndex
CREATE INDEX "VideoAsset_videoId_category_idx" ON "VideoAsset"("videoId", "category");

-- CreateIndex
CREATE INDEX "Comment_projectId_idx" ON "Comment"("projectId");

-- CreateIndex
CREATE INDEX "Comment_videoId_idx" ON "Comment"("videoId");

-- CreateIndex
CREATE INDEX "Comment_projectId_videoId_idx" ON "Comment"("projectId", "videoId");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");

-- CreateIndex
CREATE INDEX "Comment_recipientId_idx" ON "Comment"("recipientId");

-- CreateIndex
CREATE INDEX "ProjectInternalComment_projectId_idx" ON "ProjectInternalComment"("projectId");

-- CreateIndex
CREATE INDEX "ProjectInternalComment_projectId_createdAt_idx" ON "ProjectInternalComment"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectInternalComment_parentId_idx" ON "ProjectInternalComment"("parentId");

-- CreateIndex
CREATE INDEX "ProjectInternalComment_userId_idx" ON "ProjectInternalComment"("userId");

-- CreateIndex
CREATE INDEX "NotificationQueue_projectId_sentToClients_idx" ON "NotificationQueue"("projectId", "sentToClients");

-- CreateIndex
CREATE INDEX "NotificationQueue_projectId_sentToAdmins_idx" ON "NotificationQueue"("projectId", "sentToAdmins");

-- CreateIndex
CREATE INDEX "NotificationQueue_sentToAdmins_createdAt_idx" ON "NotificationQueue"("sentToAdmins", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationQueue_clientFailed_adminFailed_idx" ON "NotificationQueue"("clientFailed", "adminFailed");

-- CreateIndex
CREATE INDEX "NotificationQueue_kanbanCardId_idx" ON "NotificationQueue"("kanbanCardId");

-- CreateIndex
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "WebPushSubscription_userId_idx" ON "WebPushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksEstimateImport_qboId_key" ON "QuickBooksEstimateImport"("qboId");

-- CreateIndex
CREATE INDEX "QuickBooksEstimateImport_lastUpdatedTime_idx" ON "QuickBooksEstimateImport"("lastUpdatedTime");

-- CreateIndex
CREATE INDEX "QuickBooksEstimateImport_customerQboId_idx" ON "QuickBooksEstimateImport"("customerQboId");

-- CreateIndex
CREATE INDEX "QuickBooksEstimateImport_docNumber_idx" ON "QuickBooksEstimateImport"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksInvoiceImport_qboId_key" ON "QuickBooksInvoiceImport"("qboId");

-- CreateIndex
CREATE INDEX "QuickBooksInvoiceImport_lastUpdatedTime_idx" ON "QuickBooksInvoiceImport"("lastUpdatedTime");

-- CreateIndex
CREATE INDEX "QuickBooksInvoiceImport_customerQboId_idx" ON "QuickBooksInvoiceImport"("customerQboId");

-- CreateIndex
CREATE INDEX "QuickBooksInvoiceImport_docNumber_idx" ON "QuickBooksInvoiceImport"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksPaymentImport_qboId_key" ON "QuickBooksPaymentImport"("qboId");

-- CreateIndex
CREATE INDEX "QuickBooksPaymentImport_lastUpdatedTime_idx" ON "QuickBooksPaymentImport"("lastUpdatedTime");

-- CreateIndex
CREATE INDEX "QuickBooksPaymentImport_customerQboId_idx" ON "QuickBooksPaymentImport"("customerQboId");

-- CreateIndex
CREATE INDEX "QuickBooksPaymentImport_paymentRefNum_idx" ON "QuickBooksPaymentImport"("paymentRefNum");

-- CreateIndex
CREATE INDEX "QuickBooksPaymentAppliedInvoice_invoiceQboId_idx" ON "QuickBooksPaymentAppliedInvoice"("invoiceQboId");

-- CreateIndex
CREATE INDEX "QuickBooksPaymentAppliedInvoice_invoiceImportId_idx" ON "QuickBooksPaymentAppliedInvoice"("invoiceImportId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksPaymentAppliedInvoice_paymentImportId_invoiceQboI_key" ON "QuickBooksPaymentAppliedInvoice"("paymentImportId", "invoiceQboId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDocumentShare_token_key" ON "SalesDocumentShare"("token");

-- CreateIndex
CREATE INDEX "SalesDocumentShare_type_docNumber_idx" ON "SalesDocumentShare"("type", "docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDocumentShare_type_docId_key" ON "SalesDocumentShare"("type", "docId");

-- CreateIndex
CREATE INDEX "SalesDocumentViewEvent_shareToken_createdAt_idx" ON "SalesDocumentViewEvent"("shareToken", "createdAt");

-- CreateIndex
CREATE INDEX "SalesDocumentViewEvent_type_docId_createdAt_idx" ON "SalesDocumentViewEvent"("type", "docId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesEmailTracking_token_key" ON "SalesEmailTracking"("token");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_type_docId_sentAt_idx" ON "SalesEmailTracking"("type", "docId", "sentAt");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_token_idx" ON "SalesEmailTracking"("token");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_recipientEmail_idx" ON "SalesEmailTracking"("recipientEmail");

-- CreateIndex
CREATE INDEX "SalesTaxRate_sortOrder_idx" ON "SalesTaxRate"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SalesQuote_quoteNumber_key" ON "SalesQuote"("quoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SalesQuote_qboId_key" ON "SalesQuote"("qboId");

-- CreateIndex
CREATE INDEX "SalesQuote_clientId_idx" ON "SalesQuote"("clientId");

-- CreateIndex
CREATE INDEX "SalesQuote_projectId_idx" ON "SalesQuote"("projectId");

-- CreateIndex
CREATE INDEX "SalesQuote_status_idx" ON "SalesQuote"("status");

-- CreateIndex
CREATE INDEX "SalesQuote_issueDate_idx" ON "SalesQuote"("issueDate");

-- CreateIndex
CREATE INDEX "SalesQuoteRevision_quoteId_idx" ON "SalesQuoteRevision"("quoteId");

-- CreateIndex
CREATE INDEX "SalesQuoteRevision_createdByUserId_idx" ON "SalesQuoteRevision"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesQuoteRevision_quoteId_version_key" ON "SalesQuoteRevision"("quoteId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_invoiceNumber_key" ON "SalesInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_qboId_key" ON "SalesInvoice"("qboId");

-- CreateIndex
CREATE INDEX "SalesInvoice_clientId_idx" ON "SalesInvoice"("clientId");

-- CreateIndex
CREATE INDEX "SalesInvoice_projectId_idx" ON "SalesInvoice"("projectId");

-- CreateIndex
CREATE INDEX "SalesInvoice_status_idx" ON "SalesInvoice"("status");

-- CreateIndex
CREATE INDEX "SalesInvoice_issueDate_idx" ON "SalesInvoice"("issueDate");

-- CreateIndex
CREATE INDEX "SalesInvoice_dueDate_idx" ON "SalesInvoice"("dueDate");

-- CreateIndex
CREATE INDEX "SalesInvoiceRevision_invoiceId_idx" ON "SalesInvoiceRevision"("invoiceId");

-- CreateIndex
CREATE INDEX "SalesInvoiceRevision_createdByUserId_idx" ON "SalesInvoiceRevision"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoiceRevision_invoiceId_version_key" ON "SalesInvoiceRevision"("invoiceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPayment_qboId_key" ON "SalesPayment"("qboId");

-- CreateIndex
CREATE INDEX "SalesPayment_paymentDate_idx" ON "SalesPayment"("paymentDate");

-- CreateIndex
CREATE INDEX "SalesPayment_clientId_idx" ON "SalesPayment"("clientId");

-- CreateIndex
CREATE INDEX "SalesPayment_invoiceId_idx" ON "SalesPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "SalesPayment_source_idx" ON "SalesPayment"("source");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoiceStripePayment_stripeCheckoutSessionId_key" ON "SalesInvoiceStripePayment"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "SalesInvoiceStripePayment_invoiceDocId_idx" ON "SalesInvoiceStripePayment"("invoiceDocId");

-- CreateIndex
CREATE INDEX "SalesInvoiceStripePayment_invoiceNumber_idx" ON "SalesInvoiceStripePayment"("invoiceNumber");

-- CreateIndex
CREATE INDEX "SalesInvoiceStripePayment_shareToken_createdAt_idx" ON "SalesInvoiceStripePayment"("shareToken", "createdAt");

-- CreateIndex
CREATE INDEX "SalesInvoiceStripePayment_stripePaymentIntentId_idx" ON "SalesInvoiceStripePayment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "KanbanColumn_position_idx" ON "KanbanColumn"("position");

-- CreateIndex
CREATE INDEX "KanbanCard_columnId_position_idx" ON "KanbanCard"("columnId", "position");

-- CreateIndex
CREATE INDEX "KanbanCard_projectId_idx" ON "KanbanCard"("projectId");

-- CreateIndex
CREATE INDEX "KanbanCard_clientId_idx" ON "KanbanCard"("clientId");

-- CreateIndex
CREATE INDEX "KanbanCard_dueDate_idx" ON "KanbanCard"("dueDate");

-- CreateIndex
CREATE INDEX "KanbanCard_archivedAt_idx" ON "KanbanCard"("archivedAt");

-- CreateIndex
CREATE INDEX "KanbanCardMember_userId_idx" ON "KanbanCardMember"("userId");

-- CreateIndex
CREATE INDEX "KanbanCardComment_cardId_idx" ON "KanbanCardComment"("cardId");

-- CreateIndex
CREATE INDEX "KanbanCardComment_cardId_createdAt_idx" ON "KanbanCardComment"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "KanbanCardComment_parentId_idx" ON "KanbanCardComment"("parentId");

-- CreateIndex
CREATE INDEX "KanbanCardComment_userId_idx" ON "KanbanCardComment"("userId");

-- CreateIndex
CREATE INDEX "KanbanCardHistory_cardId_createdAt_idx" ON "KanbanCardHistory"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "KanbanCardHistory_actorId_idx" ON "KanbanCardHistory"("actorId");

-- CreateIndex
CREATE INDEX "PushNotificationLog_projectId_idx" ON "PushNotificationLog"("projectId");

-- CreateIndex
CREATE INDEX "PushNotificationLog_type_idx" ON "PushNotificationLog"("type");

-- CreateIndex
CREATE INDEX "PushNotificationLog_sentAt_idx" ON "PushNotificationLog"("sentAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_projectId_createdAt_idx" ON "SecurityEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_idx" ON "SecurityEvent"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedIP_ipAddress_key" ON "BlockedIP"("ipAddress");

-- CreateIndex
CREATE INDEX "BlockedIP_ipAddress_idx" ON "BlockedIP"("ipAddress");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedDomain_domain_key" ON "BlockedDomain"("domain");

-- CreateIndex
CREATE INDEX "BlockedDomain_domain_idx" ON "BlockedDomain"("domain");

-- CreateIndex
CREATE INDEX "VideoAnalytics_projectId_createdAt_idx" ON "VideoAnalytics"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoAnalytics_videoId_createdAt_idx" ON "VideoAnalytics"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoAnalytics_eventType_idx" ON "VideoAnalytics"("eventType");

-- CreateIndex
CREATE INDEX "VideoAnalytics_assetId_idx" ON "VideoAnalytics"("assetId");

-- CreateIndex
CREATE INDEX "VideoAnalytics_ipAddress_idx" ON "VideoAnalytics"("ipAddress");

-- CreateIndex
CREATE INDEX "VideoAnalytics_sessionId_idx" ON "VideoAnalytics"("sessionId");

-- CreateIndex
CREATE INDEX "AlbumAnalytics_projectId_createdAt_idx" ON "AlbumAnalytics"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AlbumAnalytics_albumId_createdAt_idx" ON "AlbumAnalytics"("albumId", "createdAt");

-- CreateIndex
CREATE INDEX "AlbumAnalytics_photoId_idx" ON "AlbumAnalytics"("photoId");

-- CreateIndex
CREATE INDEX "AlbumAnalytics_eventType_idx" ON "AlbumAnalytics"("eventType");

-- CreateIndex
CREATE INDEX "AlbumAnalytics_sessionId_idx" ON "AlbumAnalytics"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectEmailEvent_dedupeKey_key" ON "ProjectEmailEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProjectEmailEvent_projectId_createdAt_idx" ON "ProjectEmailEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectEmailEvent_videoId_idx" ON "ProjectEmailEvent"("videoId");

-- CreateIndex
CREATE INDEX "ProjectEmailEvent_type_idx" ON "ProjectEmailEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTracking_token_key" ON "EmailTracking"("token");

-- CreateIndex
CREATE INDEX "EmailTracking_projectId_openedAt_idx" ON "EmailTracking"("projectId", "openedAt");

-- CreateIndex
CREATE INDEX "EmailTracking_token_idx" ON "EmailTracking"("token");

-- CreateIndex
CREATE INDEX "EmailTracking_recipientEmail_idx" ON "EmailTracking"("recipientEmail");

-- CreateIndex
CREATE INDEX "SharePageAccess_projectId_createdAt_idx" ON "SharePageAccess"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SharePageAccess_projectId_accessMethod_idx" ON "SharePageAccess"("projectId", "accessMethod");

-- CreateIndex
CREATE INDEX "SharePageAccess_projectId_eventType_idx" ON "SharePageAccess"("projectId", "eventType");

-- CreateIndex
CREATE INDEX "SharePageAccess_sessionId_idx" ON "SharePageAccess"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestVideoShareLink_token_key" ON "GuestVideoShareLink"("token");

-- CreateIndex
CREATE INDEX "GuestVideoShareLink_expiresAt_idx" ON "GuestVideoShareLink"("expiresAt");

-- CreateIndex
CREATE INDEX "GuestVideoShareLink_projectId_idx" ON "GuestVideoShareLink"("projectId");

-- CreateIndex
CREATE INDEX "GuestVideoShareLink_videoId_idx" ON "GuestVideoShareLink"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestVideoShareLink_projectId_videoId_key" ON "GuestVideoShareLink"("projectId", "videoId");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialID_key" ON "PasskeyCredential"("credentialID");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_lastUsedAt_idx" ON "PasskeyCredential"("userId", "lastUsedAt");

-- CreateIndex
CREATE INDEX "CommentFile_commentId_idx" ON "CommentFile"("commentId");

-- CreateIndex
CREATE INDEX "CommentFile_projectId_idx" ON "CommentFile"("projectId");

-- CreateIndex
CREATE INDEX "CommentFile_projectId_createdAt_idx" ON "CommentFile"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "UserProjectViewSettings_userId_idx" ON "UserProjectViewSettings"("userId");

-- CreateIndex
CREATE INDEX "UserProjectViewSettings_projectId_idx" ON "UserProjectViewSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProjectViewSettings_userId_projectId_key" ON "UserProjectViewSettings"("userId", "projectId");

-- CreateIndex
CREATE INDEX "SalesItem_sortOrder_idx" ON "SalesItem"("sortOrder");

-- CreateIndex
CREATE INDEX "SalesItem_createdAt_idx" ON "SalesItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPreset_name_key" ON "SalesPreset"("name");

-- CreateIndex
CREATE INDEX "SalesPreset_name_idx" ON "SalesPreset"("name");

-- CreateIndex
CREATE INDEX "SalesPresetItem_presetId_idx" ON "SalesPresetItem"("presetId");

-- CreateIndex
CREATE INDEX "SalesPresetItem_itemId_idx" ON "SalesPresetItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPresetItem_presetId_itemId_key" ON "SalesPresetItem"("presetId", "itemId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_appRoleId_fkey" FOREIGN KEY ("appRoleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRecipient" ADD CONSTRAINT "ClientRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientFile" ADD CONSTRAINT "ClientFile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFile" ADD CONSTRAINT "UserFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectKeyDate" ADD CONSTRAINT "ProjectKeyDate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserKeyDate" ADD CONSTRAINT "UserKeyDate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectEmail" ADD CONSTRAINT "ProjectEmail_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectEmailAttachment" ADD CONSTRAINT "ProjectEmailAttachment_projectEmailId_fkey" FOREIGN KEY ("projectEmailId") REFERENCES "ProjectEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectUser" ADD CONSTRAINT "ProjectUser_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectUser" ADD CONSTRAINT "ProjectUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectStatusChange" ADD CONSTRAINT "ProjectStatusChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectStatusChange" ADD CONSTRAINT "ProjectStatusChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRecipient" ADD CONSTRAINT "ProjectRecipient_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRecipient" ADD CONSTRAINT "ProjectRecipient_clientRecipientId_fkey" FOREIGN KEY ("clientRecipientId") REFERENCES "ClientRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "ProjectRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInternalComment" ADD CONSTRAINT "ProjectInternalComment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInternalComment" ADD CONSTRAINT "ProjectInternalComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInternalComment" ADD CONSTRAINT "ProjectInternalComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProjectInternalComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_kanbanCardId_fkey" FOREIGN KEY ("kanbanCardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksPaymentAppliedInvoice" ADD CONSTRAINT "QuickBooksPaymentAppliedInvoice_paymentImportId_fkey" FOREIGN KEY ("paymentImportId") REFERENCES "QuickBooksPaymentImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksPaymentAppliedInvoice" ADD CONSTRAINT "QuickBooksPaymentAppliedInvoice_invoiceImportId_fkey" FOREIGN KEY ("invoiceImportId") REFERENCES "QuickBooksInvoiceImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentViewEvent" ADD CONSTRAINT "SalesDocumentViewEvent_shareToken_fkey" FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEmailTracking" ADD CONSTRAINT "SalesEmailTracking_shareToken_fkey" FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQuote" ADD CONSTRAINT "SalesQuote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQuote" ADD CONSTRAINT "SalesQuote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQuoteRevision" ADD CONSTRAINT "SalesQuoteRevision_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "SalesQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQuoteRevision" ADD CONSTRAINT "SalesQuoteRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceRevision" ADD CONSTRAINT "SalesInvoiceRevision_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceRevision" ADD CONSTRAINT "SalesInvoiceRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPayment" ADD CONSTRAINT "SalesPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPayment" ADD CONSTRAINT "SalesPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceStripePayment" ADD CONSTRAINT "SalesInvoiceStripePayment_shareToken_fkey" FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "KanbanColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardMember" ADD CONSTRAINT "KanbanCardMember_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardMember" ADD CONSTRAINT "KanbanCardMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "KanbanCardComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardHistory" ADD CONSTRAINT "KanbanCardHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardHistory" ADD CONSTRAINT "KanbanCardHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationReadState" ADD CONSTRAINT "NotificationReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalytics" ADD CONSTRAINT "VideoAnalytics_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalytics" ADD CONSTRAINT "VideoAnalytics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAnalytics" ADD CONSTRAINT "AlbumAnalytics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAnalytics" ADD CONSTRAINT "AlbumAnalytics_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAnalytics" ADD CONSTRAINT "AlbumAnalytics_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectEmailEvent" ADD CONSTRAINT "ProjectEmailEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectEmailEvent" ADD CONSTRAINT "ProjectEmailEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTracking" ADD CONSTRAINT "EmailTracking_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTracking" ADD CONSTRAINT "EmailTracking_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharePageAccess" ADD CONSTRAINT "SharePageAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestVideoShareLink" ADD CONSTRAINT "GuestVideoShareLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestVideoShareLink" ADD CONSTRAINT "GuestVideoShareLink_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentFile" ADD CONSTRAINT "CommentFile_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentFile" ADD CONSTRAINT "CommentFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProjectViewSettings" ADD CONSTRAINT "UserProjectViewSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProjectViewSettings" ADD CONSTRAINT "UserProjectViewSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPresetItem" ADD CONSTRAINT "SalesPresetItem_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "SalesPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPresetItem" ADD CONSTRAINT "SalesPresetItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SalesItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;


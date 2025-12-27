-- AddTable PushNotificationSettings
CREATE TABLE "PushNotificationSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT, -- 'GOTIFY' or others
    "webhookUrl" TEXT,
    "title" TEXT, -- Optional custom notification title prefix
    
    -- Event toggles
    "notifyUnauthorizedOTP" BOOLEAN NOT NULL DEFAULT true,
    "notifyFailedAdminLogin" BOOLEAN NOT NULL DEFAULT true,
    "notifySuccessfulShareAccess" BOOLEAN NOT NULL DEFAULT true,
    "notifyClientComments" BOOLEAN NOT NULL DEFAULT true,
    "notifyVideoApproval" BOOLEAN NOT NULL DEFAULT true,
    
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushNotificationSettings_pkey" PRIMARY KEY ("id")
);

-- AddTable PushNotificationLog
CREATE TABLE "PushNotificationLog" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL, -- UNAUTHORIZED_OTP, FAILED_LOGIN, SHARE_ACCESS, CLIENT_COMMENT, VIDEO_APPROVAL
    "projectId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "statusCode" INTEGER,
    "message" TEXT,
    "details" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushNotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PushNotificationLog_projectId_idx" ON "PushNotificationLog"("projectId");
CREATE INDEX "PushNotificationLog_type_idx" ON "PushNotificationLog"("type");
CREATE INDEX "PushNotificationLog_sentAt_idx" ON "PushNotificationLog"("sentAt");

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface PushNotificationsSectionProps {
  enabled: boolean
  setEnabled: (value: boolean) => void
  provider: string
  setProvider: (value: string) => void
  webhookUrl: string
  setWebhookUrl: (value: string) => void
  titlePrefix: string
  setTitlePrefix: (value: string) => void
  notifyUnauthorizedOTP: boolean
  setNotifyUnauthorizedOTP: (value: boolean) => void
  notifyFailedAdminLogin: boolean
  setNotifyFailedAdminLogin: (value: boolean) => void
  notifySuccessfulAdminLogin: boolean
  setNotifySuccessfulAdminLogin: (value: boolean) => void
  notifyFailedSharePasswordAttempt: boolean
  setNotifyFailedSharePasswordAttempt: (value: boolean) => void
  notifySuccessfulShareAccess: boolean
  setNotifySuccessfulShareAccess: (value: boolean) => void
  notifyClientComments: boolean
  setNotifyClientComments: (value: boolean) => void
  notifyVideoApproval: boolean
  setNotifyVideoApproval: (value: boolean) => void
  notifySalesQuoteViewed: boolean
  setNotifySalesQuoteViewed: (value: boolean) => void
  notifySalesQuoteAccepted: boolean
  setNotifySalesQuoteAccepted: (value: boolean) => void
  notifySalesInvoiceViewed: boolean
  setNotifySalesInvoiceViewed: (value: boolean) => void
  show: boolean
  setShow: (value: boolean) => void
}

export function PushNotificationsSection({
  enabled,
  setEnabled,
  provider,
  setProvider,
  webhookUrl,
  setWebhookUrl,
  titlePrefix,
  setTitlePrefix,
  notifyUnauthorizedOTP,
  setNotifyUnauthorizedOTP,
  notifyFailedAdminLogin,
  setNotifyFailedAdminLogin,
  notifySuccessfulAdminLogin,
  setNotifySuccessfulAdminLogin,
  notifyFailedSharePasswordAttempt,
  setNotifyFailedSharePasswordAttempt,
  notifySuccessfulShareAccess,
  setNotifySuccessfulShareAccess,
  notifyClientComments,
  setNotifyClientComments,
  notifyVideoApproval,
  setNotifyVideoApproval,
  notifySalesQuoteViewed,
  setNotifySalesQuoteViewed,
  notifySalesQuoteAccepted,
  setNotifySalesQuoteAccepted,
  notifySalesInvoiceViewed,
  setNotifySalesInvoiceViewed,
  show,
  setShow,
}: PushNotificationsSectionProps) {
  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Push Notifications</CardTitle>
            <CardDescription>
              Configure push notifications to Gotify or other services
            </CardDescription>
          </div>
          {show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>

      {show && (
        <CardContent className="space-y-4 border-t pt-4">
          {/* Enable/Disable Toggle */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="enablePushNotifications">Enable Push Notifications</Label>
                <p className="text-xs text-muted-foreground">
                  Send real-time push notifications for important events
                </p>
              </div>
              <Switch
                id="enablePushNotifications"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
          </div>

          {enabled && (
            <>
              {/* Provider Selection */}
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <Label htmlFor="provider">Provider</Label>
                <select
                  id="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full px-3 py-2 bg-card border border-border rounded-md"
                >
                  <option value="">-- Select a provider --</option>
                  <option value="GOTIFY">Gotify</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Choose the service to receive push notifications
                </p>
              </div>

              {provider && (
                <>
                  {/* Webhook URL */}
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <Label htmlFor="webhookUrl">Webhook URL</Label>
                    <Input
                      id="webhookUrl"
                      type="url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder={
                        provider === 'GOTIFY'
                          ? 'https://your-gotify-instance.com/message?token=YOUR_TOKEN'
                          : 'https://...'
                      }
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {provider === 'GOTIFY' &&
                        'Full webhook URL including your app token. Get this from your Gotify instance.'}
                    </p>
                  </div>

                  {/* Title Prefix */}
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <Label htmlFor="titlePrefix">Notification Title Prefix (Optional)</Label>
                    <Input
                      id="titlePrefix"
                      type="text"
                      value={titlePrefix}
                      onChange={(e) => setTitlePrefix(e.target.value)}
                      placeholder="e.g., ViTransfer"
                      maxLength={50}
                    />
                    <p className="text-xs text-muted-foreground">
                      Custom prefix for notification titles. Leave empty to use default formatting.
                    </p>
                  </div>

                  {/* Event Toggles */}
                  <div className="space-y-3 border-2 border-border p-4 rounded-lg bg-accent/5">
                    <h4 className="font-semibold text-sm">Enable Notifications For:</h4>
                    <div className="space-y-3">
                      {/* Failed Admin Login */}
                        <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifyFailedAdminLogin" className="text-sm font-normal">
                            Failed Admin Login Attempts
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When someone fails to log in to admin dashboard
                          </p>
                        </div>
                        <Switch
                          id="notifyFailedAdminLogin"
                          checked={notifyFailedAdminLogin}
                          onCheckedChange={setNotifyFailedAdminLogin}
                        />
                      </div>

                        {/* Successful Admin Login */}
                        <div className="flex items-center justify-between pt-3 border-t">
                          <div className="space-y-0.5">
                            <Label htmlFor="notifySuccessfulAdminLogin" className="text-sm font-normal">
                              Successful Admin Login
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              When an administrator logs in successfully
                            </p>
                          </div>
                          <Switch
                            id="notifySuccessfulAdminLogin"
                            checked={notifySuccessfulAdminLogin}
                            onCheckedChange={setNotifySuccessfulAdminLogin}
                          />
                        </div>

                        {/* Unauthorized OTP Request */}
                        <div className="flex items-center justify-between pt-3 border-t">
                          <div className="space-y-0.5">
                            <Label htmlFor="notifyUnauthorizedOTP" className="text-sm font-normal">
                              Unauthorized OTP Requests
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              When someone requests OTP with invalid email
                            </p>
                          </div>
                          <Switch
                            id="notifyUnauthorizedOTP"
                            checked={notifyUnauthorizedOTP}
                            onCheckedChange={setNotifyUnauthorizedOTP}
                          />
                        </div>

                        {/* Failed Share Password Attempt */}
                        <div className="flex items-center justify-between pt-3 border-t">
                          <div className="space-y-0.5">
                            <Label htmlFor="notifyFailedSharePasswordAttempt" className="text-sm font-normal">
                              Failed Client Share page password attempt
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              When a client enters an incorrect share password
                            </p>
                          </div>
                          <Switch
                            id="notifyFailedSharePasswordAttempt"
                            checked={notifyFailedSharePasswordAttempt}
                            onCheckedChange={setNotifyFailedSharePasswordAttempt}
                          />
                        </div>

                      {/* Successful Share Access */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifySuccessfulShareAccess" className="text-sm font-normal">
                            Successful Share Page Access
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client accesses a project (password, OTP, or guest)
                          </p>
                        </div>
                        <Switch
                          id="notifySuccessfulShareAccess"
                          checked={notifySuccessfulShareAccess}
                          onCheckedChange={setNotifySuccessfulShareAccess}
                        />
                      </div>

                      {/* Client Comments */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifyClientComments" className="text-sm font-normal">
                            Client Comments
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client leaves a comment on a video
                          </p>
                        </div>
                        <Switch
                          id="notifyClientComments"
                          checked={notifyClientComments}
                          onCheckedChange={setNotifyClientComments}
                        />
                      </div>

                      {/* Video Approval */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifyVideoApproval" className="text-sm font-normal">
                            Video Version Approvals
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client approves a video version
                          </p>
                        </div>
                        <Switch
                          id="notifyVideoApproval"
                          checked={notifyVideoApproval}
                          onCheckedChange={setNotifyVideoApproval}
                        />
                      </div>

                      {/* Sales Quote Viewed */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifySalesQuoteViewed" className="text-sm font-normal">
                            Sales Quote Viewed
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client views the public quote link
                          </p>
                        </div>
                        <Switch
                          id="notifySalesQuoteViewed"
                          checked={notifySalesQuoteViewed}
                          onCheckedChange={setNotifySalesQuoteViewed}
                        />
                      </div>

                      {/* Sales Quote Accepted */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifySalesQuoteAccepted" className="text-sm font-normal">
                            Sales Quote Accepted
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client accepts a quote from the public link
                          </p>
                        </div>
                        <Switch
                          id="notifySalesQuoteAccepted"
                          checked={notifySalesQuoteAccepted}
                          onCheckedChange={setNotifySalesQuoteAccepted}
                        />
                      </div>

                      {/* Sales Invoice Viewed */}
                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="space-y-0.5">
                          <Label htmlFor="notifySalesInvoiceViewed" className="text-sm font-normal">
                            Sales Invoice Viewed
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            When a client views the public invoice link
                          </p>
                        </div>
                        <Switch
                          id="notifySalesInvoiceViewed"
                          checked={notifySalesInvoiceViewed}
                          onCheckedChange={setNotifySalesInvoiceViewed}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { AdminBrowserPushSection } from './AdminBrowserPushSection'

interface PushNotificationsSectionProps {
  enabled: boolean
  setEnabled: (value: boolean) => void
  webhookEnabled: boolean
  setWebhookEnabled: (value: boolean) => void
  webhookUrl: string
  setWebhookUrl: (value: string) => void
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
  notifyGuestVideoLinkAccess: boolean
  setNotifyGuestVideoLinkAccess: (value: boolean) => void
  notifyClientComments: boolean
  setNotifyClientComments: (value: boolean) => void
  notifyInternalComments: boolean
  setNotifyInternalComments: (value: boolean) => void
  notifyTaskComments: boolean
  setNotifyTaskComments: (value: boolean) => void
  notifyVideoApproval: boolean
  setNotifyVideoApproval: (value: boolean) => void
  notifyUserAssignments: boolean
  setNotifyUserAssignments: (value: boolean) => void
  notifySalesQuoteViewed: boolean
  setNotifySalesQuoteViewed: (value: boolean) => void
  notifySalesQuoteAccepted: boolean
  setNotifySalesQuoteAccepted: (value: boolean) => void
  notifySalesInvoiceViewed: boolean
  setNotifySalesInvoiceViewed: (value: boolean) => void
  notifySalesInvoicePaid: boolean
  setNotifySalesInvoicePaid: (value: boolean) => void
  notifySalesReminders: boolean
  setNotifySalesReminders: (value: boolean) => void
  notifyPasswordResetRequested: boolean
  setNotifyPasswordResetRequested: (value: boolean) => void
  notifyPasswordResetSuccess: boolean
  setNotifyPasswordResetSuccess: (value: boolean) => void
  show: boolean
  setShow: (value: boolean) => void
  hideCollapse?: boolean
}

export function PushNotificationsSection({
  enabled,
  setEnabled,
  webhookEnabled,
  setWebhookEnabled,
  webhookUrl,
  setWebhookUrl,
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
  notifyGuestVideoLinkAccess,
  setNotifyGuestVideoLinkAccess,
  notifyClientComments,
  setNotifyClientComments,
  notifyInternalComments,
  setNotifyInternalComments,
  notifyTaskComments,
  setNotifyTaskComments,
  notifyVideoApproval,
  setNotifyVideoApproval,
  notifyUserAssignments,
  setNotifyUserAssignments,
  notifySalesQuoteViewed,
  setNotifySalesQuoteViewed,
  notifySalesQuoteAccepted,
  setNotifySalesQuoteAccepted,
  notifySalesInvoiceViewed,
  setNotifySalesInvoiceViewed,
  notifySalesInvoicePaid,
  setNotifySalesInvoicePaid,
  notifySalesReminders,
  setNotifySalesReminders,
  notifyPasswordResetRequested,
  setNotifyPasswordResetRequested,
  notifyPasswordResetSuccess,
  setNotifyPasswordResetSuccess,
  show,
  setShow,
  hideCollapse,
}: PushNotificationsSectionProps) {
  return (
    <Card className="border-border">
      <CardHeader
        className={hideCollapse ? undefined : "cursor-pointer hover:bg-accent/50 transition-colors"}
        onClick={hideCollapse ? undefined : () => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Push Notifications</CardTitle>
            <CardDescription>
              Configure push notifications via Browser Push, Gotify, or Ntfy
            </CardDescription>
          </div>
          {!hideCollapse && (show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ))}
        </div>
      </CardHeader>

      {(show || hideCollapse) && (
        <CardContent className="space-y-4 border-t pt-4">
          {/* Master Toggle */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="enablePushNotifications">Enable Push Notifications</Label>
                <p className="text-xs text-muted-foreground">
                  Send real-time push notifications for important events via browser push, Gotify, or Ntfy
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
              {/* Gotify / Ntfy sub-section */}
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="enableWebhookNotifications">Enable Gotify or Ntfy Notifications</Label>
                    <p className="text-xs text-muted-foreground">
                      Deliver notifications to a self-hosted Gotify or Ntfy instance via webhook
                    </p>
                  </div>
                  <Switch
                    id="enableWebhookNotifications"
                    checked={webhookEnabled}
                    onCheckedChange={setWebhookEnabled}
                  />
                </div>

                {webhookEnabled && (
                  <div className="pt-3 border-t mt-3">
                    <Label htmlFor="webhookUrl">Webhook URL</Label>
                    <Input
                      id="webhookUrl"
                      type="url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://gotify.example.com/message?token=TOKEN  or  https://ntfy.example.com/topic"
                      className="font-mono text-sm mt-1.5"
                    />
                    <p className="text-xs text-muted-foreground mt-1.5">
                      For Gotify: include the app token in the URL. For Ntfy: use the full topic URL.
                    </p>
                  </div>
                )}
              </div>

              {/* Browser Push (Admin) sub-section */}
              <AdminBrowserPushSection show={true} setShow={() => {}} embedded />

              {/* Event Toggles */}
              <div className="space-y-3 border-2 border-border p-4 rounded-lg bg-accent/5">
                <h4 className="font-semibold text-sm">Enable Notifications For:</h4>
                <p className="text-xs text-muted-foreground">
                  These toggles apply to all push channels (Browser Push, Gotify, and Ntfy).
                </p>
                <div className="space-y-3">
                  {/* Security Events */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyFailedAdminLogin" className="text-sm font-normal">
                        Failed Admin Login Attempts
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When someone fails to log in to the admin dashboard
                      </p>
                    </div>
                    <Switch
                      id="notifyFailedAdminLogin"
                      checked={notifyFailedAdminLogin}
                      onCheckedChange={setNotifyFailedAdminLogin}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySuccessfulAdminLogin" className="text-sm font-normal">
                        Successful Admin Login
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When an admin user logs in successfully
                      </p>
                    </div>
                    <Switch
                      id="notifySuccessfulAdminLogin"
                      checked={notifySuccessfulAdminLogin}
                      onCheckedChange={setNotifySuccessfulAdminLogin}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyUnauthorizedOTP" className="text-sm font-normal">
                        Unauthorized OTP Requests
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When an OTP is requested for an unregistered email
                      </p>
                    </div>
                    <Switch
                      id="notifyUnauthorizedOTP"
                      checked={notifyUnauthorizedOTP}
                      onCheckedChange={setNotifyUnauthorizedOTP}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyFailedSharePasswordAttempt" className="text-sm font-normal">
                        Failed Share Page Password Attempts
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client enters an incorrect share page password
                      </p>
                    </div>
                    <Switch
                      id="notifyFailedSharePasswordAttempt"
                      checked={notifyFailedSharePasswordAttempt}
                      onCheckedChange={setNotifyFailedSharePasswordAttempt}
                    />
                  </div>

                  {/* Share & Access Events */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySuccessfulShareAccess" className="text-sm font-normal">
                        Share Page Accessed
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client accesses a share page (via OTP, password, or guest link)
                      </p>
                    </div>
                    <Switch
                      id="notifySuccessfulShareAccess"
                      checked={notifySuccessfulShareAccess}
                      onCheckedChange={setNotifySuccessfulShareAccess}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyGuestVideoLinkAccess" className="text-sm font-normal">
                        Guest Video Link Accessed
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a guest opens a direct video link
                      </p>
                    </div>
                    <Switch
                      id="notifyGuestVideoLinkAccess"
                      checked={notifyGuestVideoLinkAccess}
                      onCheckedChange={setNotifyGuestVideoLinkAccess}
                    />
                  </div>

                  {/* Comment Events */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyClientComments" className="text-sm font-normal">
                        Client &amp; Share Comments
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client or admin posts a comment visible on the share page
                      </p>
                    </div>
                    <Switch
                      id="notifyClientComments"
                      checked={notifyClientComments}
                      onCheckedChange={setNotifyClientComments}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyInternalComments" className="text-sm font-normal">
                        Internal Comments
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When an admin posts an internal project comment (not visible to clients)
                      </p>
                    </div>
                    <Switch
                      id="notifyInternalComments"
                      checked={notifyInternalComments}
                      onCheckedChange={setNotifyInternalComments}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyTaskComments" className="text-sm font-normal">
                        Task Comments
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When someone comments on a Kanban board task
                      </p>
                    </div>
                    <Switch
                      id="notifyTaskComments"
                      checked={notifyTaskComments}
                      onCheckedChange={setNotifyTaskComments}
                    />
                  </div>

                  {/* Project Events */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyVideoApproval" className="text-sm font-normal">
                        Video Approvals
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client approves or un-approves a video
                      </p>
                    </div>
                    <Switch
                      id="notifyVideoApproval"
                      checked={notifyVideoApproval}
                      onCheckedChange={setNotifyVideoApproval}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyUserAssignments" className="text-sm font-normal">
                        User Assignments
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a user is assigned to a project or Kanban task
                      </p>
                    </div>
                    <Switch
                      id="notifyUserAssignments"
                      checked={notifyUserAssignments}
                      onCheckedChange={setNotifyUserAssignments}
                    />
                  </div>

                  {/* Sales Events */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySalesQuoteViewed" className="text-sm font-normal">
                        Sales Quote Viewed
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client views a quote via the public link
                      </p>
                    </div>
                    <Switch
                      id="notifySalesQuoteViewed"
                      checked={notifySalesQuoteViewed}
                      onCheckedChange={setNotifySalesQuoteViewed}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySalesQuoteAccepted" className="text-sm font-normal">
                        Sales Quote Accepted
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client accepts a quote
                      </p>
                    </div>
                    <Switch
                      id="notifySalesQuoteAccepted"
                      checked={notifySalesQuoteAccepted}
                      onCheckedChange={setNotifySalesQuoteAccepted}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySalesInvoiceViewed" className="text-sm font-normal">
                        Sales Invoice Viewed
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a client views an invoice via the public link
                      </p>
                    </div>
                    <Switch
                      id="notifySalesInvoiceViewed"
                      checked={notifySalesInvoiceViewed}
                      onCheckedChange={setNotifySalesInvoiceViewed}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySalesInvoicePaid" className="text-sm font-normal">
                        Sales Invoice Paid
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When an invoice is paid via Stripe
                      </p>
                    </div>
                    <Switch
                      id="notifySalesInvoicePaid"
                      checked={notifySalesInvoicePaid}
                      onCheckedChange={setNotifySalesInvoicePaid}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifySalesReminders" className="text-sm font-normal">
                        Sales Reminders
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When overdue invoice or expiring quote reminders are sent
                      </p>
                    </div>
                    <Switch
                      id="notifySalesReminders"
                      checked={notifySalesReminders}
                      onCheckedChange={setNotifySalesReminders}
                    />
                  </div>

                  {/* Password Events */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyPasswordResetRequested" className="text-sm font-normal">
                        Password Reset Requested
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When someone requests a password reset link
                      </p>
                    </div>
                    <Switch
                      id="notifyPasswordResetRequested"
                      checked={notifyPasswordResetRequested}
                      onCheckedChange={setNotifyPasswordResetRequested}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="space-y-0.5">
                      <Label htmlFor="notifyPasswordResetSuccess" className="text-sm font-normal">
                        Password Changed
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When a user successfully resets their password
                      </p>
                    </div>
                    <Switch
                      id="notifyPasswordResetSuccess"
                      checked={notifyPasswordResetSuccess}
                      onCheckedChange={setNotifyPasswordResetSuccess}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

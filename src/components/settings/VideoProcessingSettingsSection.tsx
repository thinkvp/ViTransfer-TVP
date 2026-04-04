import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { ScheduleSelector } from '@/components/ScheduleSelector'

const RESOLUTION_OPTIONS = [
  { value: '480p', label: '480p (854×480 or 480×854 for vertical)' },
  { value: '720p', label: '720p (1280×720 or 720×1280 for vertical)' },
  { value: '1080p', label: '1080p (1920×1080 or 1080×1920 for vertical)' },
] as const

interface VideoProcessingSettingsSectionProps {
  defaultPreviewResolutions: string[]
  setDefaultPreviewResolutions: (value: string[]) => void
  defaultWatermarkEnabled: boolean
  setDefaultWatermarkEnabled: (value: boolean) => void
  defaultTimelinePreviewsEnabled: boolean
  setDefaultTimelinePreviewsEnabled: (value: boolean) => void
  defaultWatermarkText: string
  setDefaultWatermarkText: (value: string) => void
  defaultAllowClientDeleteComments: boolean
  setDefaultAllowClientDeleteComments: (value: boolean) => void
  defaultAllowClientUploadFiles: boolean
  setDefaultAllowClientUploadFiles: (value: boolean) => void
  defaultAllowAuthenticatedProjectSwitching: boolean
  setDefaultAllowAuthenticatedProjectSwitching: (value: boolean) => void
  defaultMaxClientUploadAllocationMB: number | ''
  setDefaultMaxClientUploadAllocationMB: (value: number | '') => void

  // Default client notification schedule for new projects
  defaultClientNotificationSchedule: string
  setDefaultClientNotificationSchedule: (value: string) => void
  defaultClientNotificationTime: string
  setDefaultClientNotificationTime: (value: string) => void
  defaultClientNotificationDay: number
  setDefaultClientNotificationDay: (value: number) => void

  // Client system email toggles
  clientEmailProjectApproved: boolean
  setClientEmailProjectApproved: (value: boolean) => void

  show: boolean
  setShow: (value: boolean) => void
  hideCollapse?: boolean
}

export function VideoProcessingSettingsSection({
  defaultPreviewResolutions,
  setDefaultPreviewResolutions,
  defaultWatermarkEnabled,
  setDefaultWatermarkEnabled,
  defaultTimelinePreviewsEnabled,
  setDefaultTimelinePreviewsEnabled,
  defaultWatermarkText,
  setDefaultWatermarkText,
  defaultAllowClientDeleteComments,
  setDefaultAllowClientDeleteComments,
  defaultAllowClientUploadFiles,
  setDefaultAllowClientUploadFiles,
  defaultAllowAuthenticatedProjectSwitching,
  setDefaultAllowAuthenticatedProjectSwitching,
  defaultMaxClientUploadAllocationMB,
  setDefaultMaxClientUploadAllocationMB,
  defaultClientNotificationSchedule,
  setDefaultClientNotificationSchedule,
  defaultClientNotificationTime,
  setDefaultClientNotificationTime,
  defaultClientNotificationDay,
  setDefaultClientNotificationDay,
  clientEmailProjectApproved,
  setClientEmailProjectApproved,
  show,
  setShow,
  hideCollapse,
}: VideoProcessingSettingsSectionProps) {

  function toggleResolution(resolution: string) {
    if (defaultPreviewResolutions.includes(resolution)) {
      // Don't allow removing the last resolution
      if (defaultPreviewResolutions.length <= 1) return
      setDefaultPreviewResolutions(defaultPreviewResolutions.filter(r => r !== resolution))
    } else {
      setDefaultPreviewResolutions([...defaultPreviewResolutions, resolution])
    }
  }
  return (
    <Card className="border-border">
      <CardHeader
        className={hideCollapse ? undefined : "cursor-pointer hover:bg-accent/50 transition-colors"}
        onClick={hideCollapse ? undefined : () => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Default Project Settings</CardTitle>
            <CardDescription>
              Set default video processing and other settings for new projects
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
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="space-y-2">
              <Label>Default Preview Resolutions</Label>
              <div className="space-y-2">
                {RESOLUTION_OPTIONS.map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={defaultPreviewResolutions.includes(opt.value)}
                      onChange={() => toggleResolution(opt.value)}
                      disabled={defaultPreviewResolutions.includes(opt.value) && defaultPreviewResolutions.length <= 1}
                      className="rounded border-border accent-primary"
                    />
                    <span className="text-sm">{opt.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                New projects will generate previews for these resolutions. Multiple resolutions enable a quality selector in the video player. Can be overridden per project.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="watermarkEnabled">Enable Watermarks</Label>
                <p className="text-xs text-muted-foreground">
                  Add watermarks to processed videos
                </p>
              </div>
              <Switch
                id="watermarkEnabled"
                checked={defaultWatermarkEnabled}
                onCheckedChange={setDefaultWatermarkEnabled}
              />
            </div>

            <div className="flex items-center justify-between pt-2 mt-2 border-t border-border">
              <div className="space-y-0.5">
                <Label htmlFor="defaultTimelinePreviewsEnabled">Enable Timeline Previews</Label>
                <p className="text-xs text-muted-foreground">
                  Show preview thumbnails when hovering or scrubbing the timeline
                </p>
              </div>
              <Switch
                id="defaultTimelinePreviewsEnabled"
                checked={defaultTimelinePreviewsEnabled}
                onCheckedChange={setDefaultTimelinePreviewsEnabled}
              />
            </div>

            {defaultWatermarkEnabled && (
              <div className="space-y-2 pt-2 mt-2 border-t border-border">
                <Label htmlFor="watermark">Custom Watermark Text</Label>
                <Input
                  id="watermark"
                  value={defaultWatermarkText}
                  onChange={(e) => setDefaultWatermarkText(e.target.value)}
                  placeholder="e.g., PREVIEW, CONFIDENTIAL"
                  maxLength={100}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use project-specific format. New projects will use this as default.
                  <br />
                  <span className="text-warning">Only letters, numbers, spaces, and these characters: - _ . ( )</span>
                </p>
              </div>
            )}
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="defaultAllowClientDeleteComments">Allow clients to delete client comments</Label>
                <p className="text-xs text-muted-foreground">
                  All clients will be able to delete any comment left by a client.
                </p>
              </div>
              <Switch
                id="defaultAllowClientDeleteComments"
                checked={defaultAllowClientDeleteComments}
                onCheckedChange={setDefaultAllowClientDeleteComments}
              />
            </div>

            <div className="flex items-center justify-between pt-3 mt-3 border-t border-border">
              <div className="space-y-0.5">
                <Label htmlFor="defaultAllowClientUploadFiles">Allow clients to upload files while commenting</Label>
                <p className="text-xs text-muted-foreground">
                  Clients can attach files to comments (up to 5 per comment). Supported types: Images (JPG, PNG, GIF, WebP, TIFF, SVG, PSD, PSB, AI) • Videos (MP4, MOV, M4V, WEBM, MKV, AVI) • Documents (PDF, Word, Excel, PowerPoint) • Fonts (TTF, OTF, WOFF, WOFF2) • Archives (ZIP, RAR, 7Z, GZ, TAR).
                </p>
              </div>
              <Switch
                id="defaultAllowClientUploadFiles"
                checked={defaultAllowClientUploadFiles}
                onCheckedChange={setDefaultAllowClientUploadFiles}
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-3 mt-3 border-t border-border">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="defaultMaxClientUploadAllocationMB">Default max allowed data allocation for client uploads</Label>
                <p className="text-xs text-muted-foreground">
                  Clients will not be allowed to upload more than this amount for the entire project. Zero = no limit.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Input
                  id="defaultMaxClientUploadAllocationMB"
                  type="number"
                  min={0}
                  value={defaultMaxClientUploadAllocationMB}
                  onChange={(e) => {
                    const val = e.target.value
                    setDefaultMaxClientUploadAllocationMB(val === '' ? '' : Math.max(0, parseInt(val, 10) || 0))
                  }}
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">MB</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 pt-3 mt-3 border-t border-border">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="defaultAllowAuthenticatedProjectSwitching">Allow authenticated clients to switch between other current projects</Label>
                <p className="text-xs text-muted-foreground">
                  Password and OTP recipients can switch between this client&apos;s other current projects when both projects allow it.
                </p>
              </div>
              <Switch
                id="defaultAllowAuthenticatedProjectSwitching"
                checked={defaultAllowAuthenticatedProjectSwitching}
                onCheckedChange={setDefaultAllowAuthenticatedProjectSwitching}
              />
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <ScheduleSelector
              schedule={defaultClientNotificationSchedule}
              time={defaultClientNotificationTime}
              day={defaultClientNotificationDay}
              onScheduleChange={setDefaultClientNotificationSchedule}
              onTimeChange={setDefaultClientNotificationTime}
              onDayChange={setDefaultClientNotificationDay}
              label="Default Client Notification Schedule"
              description="Default schedule for client comment notifications on newly created projects. Can be overridden per project. Note: Approval emails are always sent immediately."
            />
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <Label className="text-base">Client System Emails</Label>
            <p className="text-xs text-muted-foreground">
              Toggle automated emails sent to project clients globally. Disabling these stops them from being sent across all projects.
            </p>
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5 flex-1">
                  <Label htmlFor="clientEmailProjectApproved">Project approval confirmation</Label>
                  <p className="text-xs text-muted-foreground">Notify clients automatically when their entire project is marked as approved.</p>
                </div>
                <Switch id="clientEmailProjectApproved" checked={clientEmailProjectApproved} onCheckedChange={setClientEmailProjectApproved} />
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

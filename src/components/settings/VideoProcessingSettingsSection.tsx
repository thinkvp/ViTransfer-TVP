import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface VideoProcessingSettingsSectionProps {
  defaultPreviewResolution: string
  setDefaultPreviewResolution: (value: string) => void
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
  defaultMaxClientUploadAllocationMB: number | ''
  setDefaultMaxClientUploadAllocationMB: (value: number | '') => void
  show: boolean
  setShow: (value: boolean) => void
}

export function VideoProcessingSettingsSection({
  defaultPreviewResolution,
  setDefaultPreviewResolution,
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
  defaultMaxClientUploadAllocationMB,
  setDefaultMaxClientUploadAllocationMB,
  show,
  setShow,
}: VideoProcessingSettingsSectionProps) {
  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Default Project Settings</CardTitle>
            <CardDescription>
              Set default video processing and other settings for new projects
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
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <Label htmlFor="resolution">Default Preview Resolution</Label>
            <select
              id="resolution"
              value={defaultPreviewResolution}
              onChange={(e) => setDefaultPreviewResolution(e.target.value)}
              className="w-full px-3 py-2 text-sm sm:text-base bg-background text-foreground border border-border rounded-md"
            >
              <option value="720p">720p (1280x720 or 720x1280 for vertical)</option>
              <option value="1080p">1080p (1920x1080 or 1080x1920 for vertical)</option>
            </select>
            <p className="text-xs text-muted-foreground">
              New projects will use this resolution by default. Can be overridden per project.
            </p>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
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
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="defaultAllowClientUploadFiles">Allow clients to upload files while commenting</Label>
                <p className="text-xs text-muted-foreground">
                  Clients can attach files to comments (up to 5 per comment). Supported types: Images (JPG, PNG, GIF, WebP, TIFF, SVG, PSD, PSB, AI) • Videos (MP4, MOV, M4V, WEBM, MKV, AVI) • Documents (PDF, Word, Excel, PowerPoint) • Fonts (TTF, OTF, WOFF, WOFF2) • Archives (ZIP, RAR, 7Z, GZ, TAR). Max 200MB per file.
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
          </div>
        </CardContent>
      )}
    </Card>
  )
}

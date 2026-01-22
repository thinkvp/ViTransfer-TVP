import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface ProjectBehaviorSectionProps {
  autoApproveProject: boolean
  setAutoApproveProject: (value: boolean) => void
  autoCloseApprovedProjectsEnabled: boolean
  setAutoCloseApprovedProjectsEnabled: (value: boolean) => void
  autoCloseApprovedProjectsAfterDays: number | ''
  setAutoCloseApprovedProjectsAfterDays: (value: number | '') => void
  onRecalculateProjectDataTotals?: () => void
  recalculateProjectDataTotalsLoading?: boolean
  recalculateProjectDataTotalsResult?: string | null
  show: boolean
  setShow: (value: boolean) => void
}

export function ProjectBehaviorSection({
  autoApproveProject,
  setAutoApproveProject,
  autoCloseApprovedProjectsEnabled,
  setAutoCloseApprovedProjectsEnabled,
  autoCloseApprovedProjectsAfterDays,
  setAutoCloseApprovedProjectsAfterDays,
  onRecalculateProjectDataTotals,
  recalculateProjectDataTotalsLoading,
  recalculateProjectDataTotalsResult,
  show,
  setShow,
}: ProjectBehaviorSectionProps) {
  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Project Behavior</CardTitle>
            <CardDescription>
              Configure how projects behave when videos are approved
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
          <div className="space-y-4 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="autoApproveProject">Auto-approve project when all videos are approved</Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, the project will automatically be marked as APPROVED when all unique videos have at least one approved version.
                  <br />
                  <span className="text-warning">Disable this if you upload videos one-by-one and don&apos;t want the project to auto-approve until you&apos;re ready.</span>
                </p>
              </div>
              <Switch
                id="autoApproveProject"
                checked={autoApproveProject}
                onCheckedChange={setAutoApproveProject}
              />
            </div>

            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="autoCloseApprovedProjectsEnabled">Auto-close Approved projects</Label>
                <p className="text-xs text-muted-foreground">
                  The Project Approved email will warn recipients they have {typeof autoCloseApprovedProjectsAfterDays === 'number' ? autoCloseApprovedProjectsAfterDays : 7} days to download their video/s. Afterwards the project status will be set Closed and no longer be accessible on their Share link.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Input
                  id="autoCloseApprovedProjectsAfterDays"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  step={1}
                  className="w-14"
                  disabled={!autoCloseApprovedProjectsEnabled}
                  value={autoCloseApprovedProjectsAfterDays}
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      setAutoCloseApprovedProjectsAfterDays('')
                      return
                    }

                    const num = parseInt(raw, 10)
                    if (Number.isNaN(num)) return
                    setAutoCloseApprovedProjectsAfterDays(Math.max(1, Math.min(99, num)))
                  }}
                  onBlur={() => {
                    if (autoCloseApprovedProjectsAfterDays === '' || autoCloseApprovedProjectsAfterDays < 1) {
                      setAutoCloseApprovedProjectsAfterDays(7)
                    }
                  }}
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>

              <Switch
                id="autoCloseApprovedProjectsEnabled"
                checked={autoCloseApprovedProjectsEnabled}
                onCheckedChange={setAutoCloseApprovedProjectsEnabled}
              />
            </div>
          </div>

          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label>Project Data totals</Label>
                <p className="text-xs text-muted-foreground">
                  Recalculate the stored “Data” value for every project (includes videos, photos, and ZIP artifacts).
                  Use this after upgrades or if totals look incorrect.
                </p>
                {recalculateProjectDataTotalsResult ? (
                  <p className="text-xs text-muted-foreground">{recalculateProjectDataTotalsResult}</p>
                ) : null}
              </div>

              <Button
                type="button"
                variant="secondary"
                className="flex-shrink-0"
                disabled={!onRecalculateProjectDataTotals || recalculateProjectDataTotalsLoading}
                onClick={() => onRecalculateProjectDataTotals?.()}
              >
                {recalculateProjectDataTotalsLoading ? 'Queuing…' : 'Recalculate now'}
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

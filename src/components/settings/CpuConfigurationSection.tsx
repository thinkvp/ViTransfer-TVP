import React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronUp, AlertTriangle, Info } from 'lucide-react'

interface CpuConfigurationSectionProps {
  show: boolean
  setShow: (value: boolean) => void
  detectedThreads: number
  budgetThreads: number
  reservedSystemThreads: number
  maxFfmpegThreadsPerJob: number
  ffmpegThreadsPerJob: string
  setFfmpegThreadsPerJob: (value: string) => void
  videoWorkerConcurrency: string
  setVideoWorkerConcurrency: (value: string) => void
  dynamicThreadAllocation: boolean
  setDynamicThreadAllocation: (value: boolean) => void
  defaultFfmpegThreadsPerJob: number
  defaultVideoWorkerConcurrency: number
}

export function CpuConfigurationSection({
  show,
  setShow,
  detectedThreads,
  budgetThreads,
  reservedSystemThreads,
  maxFfmpegThreadsPerJob,
  ffmpegThreadsPerJob,
  setFfmpegThreadsPerJob,
  videoWorkerConcurrency,
  setVideoWorkerConcurrency,
  dynamicThreadAllocation,
  setDynamicThreadAllocation,
  defaultFfmpegThreadsPerJob,
  defaultVideoWorkerConcurrency,
}: CpuConfigurationSectionProps) {
  const parsedThreads = parseInt(ffmpegThreadsPerJob, 10) || defaultFfmpegThreadsPerJob
  const parsedConcurrency = parseInt(videoWorkerConcurrency, 10) || defaultVideoWorkerConcurrency
  const estimatedMaxThreads = parsedThreads * parsedConcurrency
  const allocatedFfmpegThreads = estimatedMaxThreads
  const displayedReservedThreads = Math.max(0, detectedThreads - allocatedFfmpegThreads)
  const exceedsSystemCapacity = estimatedMaxThreads > detectedThreads
  const fullUtilization = estimatedMaxThreads === detectedThreads
  const highAllocation = estimatedMaxThreads > (detectedThreads * 0.5) && estimatedMaxThreads < detectedThreads

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>CPU Configuration</CardTitle>
            <CardDescription>
              Configure FFmpeg thread allocation and concurrent video processing jobs
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
          {/* System Info */}
          <div className="p-3 bg-muted/30 border rounded-lg">
            <div className="text-sm font-medium mb-2">System Resources</div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Detected Threads:</span>{' '}
                <span className="font-medium">{detectedThreads}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Reserved (OS/App):</span>{' '}
                <span className="font-medium">{displayedReservedThreads}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Available for FFmpeg:</span>{' '}
                <span className="font-medium">{allocatedFfmpegThreads}</span>
              </div>
            </div>
          </div>

          {/* Thread Allocation */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <Label className="text-base">Thread Allocation</Label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ffmpegThreadsPerJob">FFmpeg Threads per Job</Label>
                <Input
                  id="ffmpegThreadsPerJob"
                  type="number"
                  min={1}
                  max={maxFfmpegThreadsPerJob}
                  value={ffmpegThreadsPerJob}
                  onChange={(e) => setFfmpegThreadsPerJob(e.target.value)}
                  placeholder={String(defaultFfmpegThreadsPerJob)}
                />
                <p className="text-xs text-muted-foreground">
                  Threads allocated to each FFmpeg transcode (1–{maxFfmpegThreadsPerJob}). Default: {defaultFfmpegThreadsPerJob}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="videoWorkerConcurrency">Concurrent Jobs</Label>
                <Input
                  id="videoWorkerConcurrency"
                  type="number"
                  min={1}
                  max={20}
                  value={videoWorkerConcurrency}
                  onChange={(e) => setVideoWorkerConcurrency(e.target.value)}
                  placeholder={String(defaultVideoWorkerConcurrency)}
                />
                <p className="text-xs text-muted-foreground">
                  Number of videos processed simultaneously (1–20). Default: {defaultVideoWorkerConcurrency}
                </p>
              </div>
            </div>

            {/* Utilization Summary */}
            <div className={`p-3 rounded-md ${exceedsSystemCapacity ? 'bg-destructive/10 border-2 border-destructive/30' : fullUtilization ? 'bg-warning-visible border-2 border-warning-visible' : highAllocation ? 'bg-orange-50 border-2 border-orange-100 dark:bg-orange-950 dark:border-orange-900' : 'bg-muted'}`}>
              <div className="text-sm">
                <span className="font-medium">Estimated peak usage:</span>{' '}
                <span className={`font-medium tabular-nums ${exceedsSystemCapacity ? 'text-destructive' : fullUtilization ? 'text-warning' : ''}`}>
                  {estimatedMaxThreads} / {detectedThreads} threads
                </span>
                <span className="text-muted-foreground ml-1">
                  ({Math.round((estimatedMaxThreads / detectedThreads) * 100)}%)
                </span>
              </div>
              {exceedsSystemCapacity && (
                <div className="flex items-start gap-2 mt-2 text-xs text-destructive font-medium">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    This configuration exceeds system capacity and cannot be saved. Reduce threads per job or concurrent jobs.
                  </span>
                </div>
              )}
              {fullUtilization && (
                <div className="flex items-start gap-2 mt-2 text-xs text-warning font-medium">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    This configuration uses all available system threads, leaving no headroom for the OS, database, or web server. Consider reducing threads per job or concurrent jobs.
                  </span>
                </div>
              )}
              {!exceedsSystemCapacity && !fullUtilization && highAllocation && (
                <div className="flex items-start gap-2 mt-2 text-xs text-orange-600 dark:text-orange-400 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Peak usage may cause contention with system resources. Ensure enough headroom is left for your OS and any other running apps.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Dynamic Thread Allocation */}
          <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="dynamicThreadAllocation" className="text-base">
                  Dynamic Thread Allocation
                </Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, a single running job automatically scales up to use more threads if no other jobs are active. When disabled, every job uses exactly the configured thread count.
                </p>
              </div>
              <Switch
                id="dynamicThreadAllocation"
                checked={dynamicThreadAllocation}
                onCheckedChange={setDynamicThreadAllocation}
              />
            </div>
          </div>

          {/* Info */}
          <div className="flex items-start gap-2 text-xs text-muted-foreground p-3 bg-muted/30 rounded-lg border">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              Thread allocation changes take effect on the next job. Concurrency changes require a container restart.
              Environment variables (<code className="bg-background px-1 py-0.5 rounded text-[11px]">CPU_THREADS</code>,{' '}
              <code className="bg-background px-1 py-0.5 rounded text-[11px]">FFMPEG_THREADS_PER_JOB</code>,{' '}
              <code className="bg-background px-1 py-0.5 rounded text-[11px]">VIDEO_WORKER_CONCURRENCY</code>) are overridden by these settings when set.
            </span>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

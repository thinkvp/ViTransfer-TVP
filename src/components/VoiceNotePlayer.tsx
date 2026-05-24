'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface VoiceNotePlayerProps {
  src: string
  className?: string
}

function formatAudioTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function computePeaks(channelData: Float32Array, bars: number): number[] {
  if (channelData.length === 0 || bars <= 0) return []

  const blockSize = Math.max(1, Math.floor(channelData.length / bars))
  const output: number[] = []

  for (let i = 0; i < bars; i += 1) {
    const start = i * blockSize
    const end = Math.min(channelData.length, start + blockSize)

    let peak = 0
    for (let j = start; j < end; j += 1) {
      const amp = Math.abs(channelData[j])
      if (amp > peak) peak = amp
    }

    output.push(peak)
  }

  const maxPeak = output.reduce((max, value) => (value > max ? value : max), 0)
  if (maxPeak <= 0) return output.map(() => 0.1)
  return output.map((value) => Math.max(0.1, value / maxPeak))
}

export default function VoiceNotePlayer({ src, className }: VoiceNotePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [peaks, setPeaks] = useState<number[]>([])

  const getDurationFromAudio = (audio: HTMLAudioElement): number => {
    const directDuration = audio.duration
    if (Number.isFinite(directDuration) && directDuration > 0) {
      return directDuration
    }

    const seekable = audio.seekable
    if (seekable && seekable.length > 0) {
      const end = seekable.end(seekable.length - 1)
      if (Number.isFinite(end) && end > 0) return end
    }

    return 0
  }

  const resolveInfiniteDuration = (audio: HTMLAudioElement) => {
    const maybeDuration = getDurationFromAudio(audio)
    if (maybeDuration > 0) {
      setDuration(maybeDuration)
      return
    }

    // Some MediaRecorder blobs report duration as Infinity/0 until a forced seek.
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      const originalTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0

      const onTimeUpdate = () => {
        const resolved = getDurationFromAudio(audio)
        if (resolved > 0) {
          setDuration(resolved)
          try {
            audio.currentTime = Math.min(originalTime, resolved)
          } catch {
            // ignore
          }
        }
        audio.removeEventListener('timeupdate', onTimeUpdate)
      }

      audio.addEventListener('timeupdate', onTimeUpdate)
      try {
        audio.currentTime = 1e9
      } catch {
        audio.removeEventListener('timeupdate', onTimeUpdate)
      }
    }
  }

  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [src])

  useEffect(() => {
    let cancelled = false

    async function buildWaveform() {
      try {
        const response = await fetch(src)
        if (!response.ok) {
          if (!cancelled) setPeaks([])
          return
        }

        const buffer = await response.arrayBuffer()
        const audioContext = new AudioContext()
        try {
          const decoded = await audioContext.decodeAudioData(buffer)
          if (cancelled) return
          const channelData = decoded.getChannelData(0)
          setPeaks(computePeaks(channelData, 56))
          setDuration((prev) => (prev > 0 ? prev : decoded.duration || 0))
        } finally {
          await audioContext.close().catch(() => undefined)
        }
      } catch {
        if (!cancelled) setPeaks([])
      }
    }

    void buildWaveform()

    return () => {
      cancelled = true
    }
  }, [src])

  const effectiveDuration = useMemo(() => {
    if (duration > 0) return duration
    const audio = audioRef.current
    if (!audio) return 0
    return getDurationFromAudio(audio)
  }, [duration, currentTime])

  const progressPercent = useMemo(() => {
    if (!effectiveDuration || effectiveDuration <= 0) return 0
    return Math.max(0, Math.min(100, (currentTime / effectiveDuration) * 100))
  }, [currentTime, effectiveDuration])

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio) return

    if (audio.paused) {
      try {
        await audio.play()
        setIsPlaying(true)
      } catch {
        setIsPlaying(false)
      }
      return
    }

    audio.pause()
    setIsPlaying(false)
  }

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current
    if (!audio) return

    const seekDuration = effectiveDuration > 0 ? effectiveDuration : getDurationFromAudio(audio)
    if (!seekDuration || seekDuration <= 0) return

    const safeRatio = Math.max(0, Math.min(1, ratio))
    const targetTime = Math.max(0, Math.min(seekDuration, safeRatio * seekDuration))
    audio.currentTime = targetTime
    setCurrentTime(targetTime)
  }

  const handleWaveformSeek = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    seekToRatio(ratio)
  }

  const handleWaveformPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    setIsScrubbing(true)
    event.currentTarget.setPointerCapture(event.pointerId)

    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    seekToRatio(ratio)
  }

  const handleWaveformPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    seekToRatio(ratio)
  }

  const endScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (isScrubbing) {
      const rect = event.currentTarget.getBoundingClientRect()
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
      seekToRatio(ratio)
    }
    setIsScrubbing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className={cn('rounded-lg border border-border bg-muted/20 p-3', className)}>
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget
          const nextDuration = getDurationFromAudio(audio)
          if (nextDuration > 0) {
            setDuration(nextDuration)
          } else {
            resolveInfiniteDuration(audio)
          }
        }}
        onDurationChange={(event) => {
          const nextDuration = getDurationFromAudio(event.currentTarget)
          if (nextDuration > 0) {
            setDuration(nextDuration)
          }
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget
          setCurrentTime(audio.currentTime || 0)
          if (duration <= 0) {
            const nextDuration = getDurationFromAudio(audio)
            if (nextDuration > 0) {
              setDuration(nextDuration)
            }
          }
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false)
          setCurrentTime(0)
        }}
      />

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => void togglePlayback()}
          aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
          title={isPlaying ? 'Pause voice note' : 'Play voice note'}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>

        <div className="min-w-0 flex-1">
          <div
            className="relative h-10 w-full cursor-pointer rounded-md border border-border/70 bg-background px-2 py-1"
            onClick={handleWaveformSeek}
            onPointerDown={handleWaveformPointerDown}
            onPointerMove={handleWaveformPointerMove}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            aria-label="Seek voice note"
            title="Seek voice note"
          >
            <div className="flex h-full items-end gap-[2px]">
              {(peaks.length > 0 ? peaks : new Array(56).fill(0.15)).map((peak, index) => {
                const barProgress = peaks.length > 0 ? (index + 1) / peaks.length : 0
                const isPassed = barProgress <= progressPercent / 100
                return (
                  <span
                    key={`bar-${index}`}
                    className={cn('w-full rounded-[2px] transition-colors', isPassed ? 'bg-primary' : 'bg-muted-foreground/35')}
                    style={{ height: `${Math.max(10, Math.round(peak * 100))}%` }}
                  />
                )
              })}
            </div>

            <div
              className="pointer-events-none absolute inset-y-1"
              style={{ left: `${progressPercent}%`, transform: 'translateX(-50%)' }}
            >
              <div className="h-full w-[2px] rounded bg-primary/80" />
              <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/80 bg-background shadow-sm" />
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground tabular-nums">
            <span>{formatAudioTime(currentTime)}</span>
            <span>{formatAudioTime(effectiveDuration)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

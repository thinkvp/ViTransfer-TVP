import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getCpuAllocation, getDynamicThreadsPerJob } from './cpu-config'

// Debug mode - outputs verbose FFmpeg logs
// Enable with: DEBUG_WORKER=true environment variable
const DEBUG = process.env.DEBUG_WORKER === 'true'

// Use system-installed ffmpeg (installed via apk in Dockerfile)
const ffmpegPath = 'ffmpeg'
const ffprobePath = 'ffprobe'

// Forced keyframe interval (seconds) for HLS-aligned transcodes. Every rendition gets an
// IDR frame at the same timestamps (0, 2, 4, … via `-force_key_frames` + scenecut disabled),
// so the `-c copy` HLS segments share identical boundaries across resolutions — the
// prerequisite for seamless adaptive-bitrate switching. 2 s divides the 4 s segment length.
export const HLS_KEYFRAME_INTERVAL_SECONDS = 2

export interface VideoMetadata {
  duration: number
  width: number
  height: number
  fps?: number
  codec?: string
}

export async function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    // Remove '-v quiet' to capture detailed error messages
    const args = [
      '-v', 'verbose', // Enable verbose logging for debug
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ]

    if (DEBUG) {
      console.log('[FFPROBE DEBUG] Executing:', ffprobePath, args.join(' '))
      console.log('[FFPROBE DEBUG] Input file:', inputPath)
    }

    const ffprobe = spawn(ffprobePath, args)
    let stdout = ''
    let stderr = ''

    ffprobe.stdout.on('data', (data) => {
      const text = data.toString()
      stdout += text
      if (DEBUG) {
        console.log('[FFPROBE STDOUT]', text.trim())
      }
    })

    ffprobe.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      if (DEBUG) {
        console.log('[FFPROBE STDERR]', text.trim())
      }
    })

    ffprobe.on('close', (code) => {
      if (DEBUG) {
        console.log('[FFPROBE DEBUG] Process exited with code:', code)
      }

      if (code !== 0) {
        // Extract useful error information from stderr
        const errorLines = stderr.split('\n').filter(line =>
          line.includes('error') ||
          line.includes('Error') ||
          line.includes('Invalid') ||
          line.includes('not found') ||
          line.includes('moov atom')
        )

        const errorMessage = errorLines.length > 0
          ? errorLines.join('; ')
          : stderr || 'Unknown error'

        if (DEBUG) {
          console.error('[FFPROBE DEBUG] Error detected:', errorMessage)
        }

        reject(new Error(
          `ffprobe failed with exit code ${code}: ${errorMessage}. ` +
          `This usually indicates a corrupted or incomplete video file.`
        ))
        return
      }

      try {
        const metadata = JSON.parse(stdout)
        const videoStream = metadata.streams.find((s: any) => s.codec_type === 'video')

        if (DEBUG) {
          console.log('[FFPROBE DEBUG] Parsed metadata:', JSON.stringify(metadata, null, 2))
        }

        if (!videoStream) {
          if (DEBUG) {
            console.error('[FFPROBE DEBUG] No video stream found in metadata')
          }
          reject(new Error('No video stream found in file. The file may be audio-only or corrupted.'))
          return
        }

        // Parse frame rate
        let fps: number | undefined
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
          fps = den ? num / den : undefined
        }

        const result = {
          duration: parseFloat(metadata.format.duration) || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          fps,
          codec: videoStream.codec_name,
        }

        if (DEBUG) {
          console.log('[FFPROBE DEBUG] Extracted video metadata:', result)
        }

        resolve(result)
      } catch (error) {
        if (DEBUG) {
          console.error('[FFPROBE DEBUG] Failed to parse output:', error)
        }
        reject(new Error(`Failed to parse ffprobe output: ${error}. Output was: ${stdout.substring(0, 200)}`))
      }
    })

    ffprobe.on('error', (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}. Is ffprobe installed?`))
    })
  })
}

export interface TranscodeOptions {
  inputPath: string
  /** MP4 output file. Required unless `hlsOutputDir` is set (direct-to-HLS mode). */
  outputPath?: string
  width: number
  height: number
  onProgress?: (progress: number) => void | Promise<void>
  shouldAbort?: () => boolean | Promise<boolean>
  // When true, force keyframes at a fixed interval and disable scene-cut keyframes so this
  // rendition's segments align with every other rendition's (required for HLS ABR).
  alignKeyframes?: boolean
  /**
   * Direct-to-HLS mode: when set, the encoder writes a VOD HLS rendition (index.m3u8 +
   * init.mp4 + seg-*.m4s) into this directory in a single pass, instead of an MP4 to
   * `outputPath`. Same encode/filter/keyframe flags — only the output muxer differs. This
   * removes the redundant "encode MP4 → upload → download → remux" round-trip.
   */
  hlsOutputDir?: string
  /** HLS segment target duration in seconds (default 4). Only used with `hlsOutputDir`. */
  segmentDurationSeconds?: number
}

export class FFmpegCancellationError extends Error {
  constructor(message: string = 'FFmpeg operation cancelled') {
    super(message)
    this.name = 'FFmpegCancellationError'
  }
}

export interface TimelineSpriteOptions {
  inputPath: string
  outputPath: string
  startTimeSeconds: number
  durationSeconds: number
  intervalSeconds: number
  tileColumns: number
  tileRows: number
  frameWidth: number
}

export async function generateTimelineSprite(options: TimelineSpriteOptions): Promise<void> {
  const {
    inputPath,
    outputPath,
    startTimeSeconds,
    durationSeconds,
    intervalSeconds,
    tileColumns,
    tileRows,
    frameWidth,
  } = options

  if (intervalSeconds <= 0) {
    throw new Error('intervalSeconds must be > 0')
  }
  if (tileColumns <= 0 || tileRows <= 0) {
    throw new Error('tileColumns and tileRows must be > 0')
  }
  if (frameWidth <= 0) {
    throw new Error('frameWidth must be > 0')
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

  const fpsExpr = `fps=1/${intervalSeconds}`
  const scaleExpr = `scale=${frameWidth}:-2:flags=lanczos`
  const tileExpr = `tile=${tileColumns}x${tileRows}`
  const filter = `${fpsExpr},${scaleExpr},${tileExpr}`

  // Use dynamic thread scaling so a lone timeline regen can use the full *budgeted*
  // CPU allocation, while multiple concurrent jobs divide the same budget.
  // The important constraint is that the budget is computed from a cgroup-aware
  // CPU count (see cpu-config.ts), so it reflects container limits.
  const cpuAllocation = getCpuAllocation()
  const dynamic = getDynamicThreadsPerJob()
  const threads = dynamic.threads

  // Note: -frames:v 1 because tile outputs a single sprite image.
  // `-threads` limits the decode/image-encode pipeline for this simple
  // one-output command, while `-filter_threads 1` keeps the lightweight
  // sprite filter graph from spinning up a pool sized to all visible CPUs.
  const args = [
    '-hide_banner',
    '-loglevel', DEBUG ? 'info' : 'error',
    '-threads', threads.toString(),
    '-ss', `${Math.max(0, startTimeSeconds)}`,
    '-t', `${Math.max(0, durationSeconds)}`,
    '-i', inputPath,
    '-vf', filter,
    '-filter_threads', '1',
    '-frames:v', '1',
    '-q:v', '3',
    outputPath,
  ]

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Timeline sprite CPU allocation:', {
      availableThreads: cpuAllocation.effectiveThreads,
      budgetThreads: cpuAllocation.budgetThreads,
      threadsPerJob: threads,
      activeJobs: dynamic.activeJobs,
    })
    console.log('[FFMPEG DEBUG] Executing:', ffmpegPath, args.join(' '))
  }

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args)
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      if (DEBUG) {
        console.log('[FFMPEG STDERR]', text.trim())
      }
    })

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg sprite generation failed with exit code ${code}: ${stderr || 'Unknown error'}`))
        return
      }
      resolve()
    })

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Is ffmpeg installed?`))
    })
  })
}

export async function transcodeVideo(options: TranscodeOptions): Promise<void> {
  const {
    inputPath,
    outputPath,
    width,
    height,
    onProgress,
    shouldAbort,
    alignKeyframes,
    hlsOutputDir,
    segmentDurationSeconds = 4,
  } = options

  if (!hlsOutputDir && !outputPath) {
    throw new Error('transcodeVideo requires either outputPath (MP4) or hlsOutputDir (HLS)')
  }

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Starting transcodeVideo with options:', {
      inputPath,
      outputPath,
      width,
      height,
      hasProgressCallback: !!onProgress
    })
  }

  // Dynamic CPU allocation: when fewer jobs are active than max concurrency,
  // each job gets a larger share of the thread budget so a lone transcode
  // uses more CPU rather than leaving cores idle.
  const cpuAllocation = getCpuAllocation()
  const dynamic = getDynamicThreadsPerJob()
  const threads = dynamic.threads

  // Optimize preset based on the static per-job thread allocation.
  // Fewer threads -> use a faster preset to keep turnaround reasonable.
  let preset = 'fast'
  if (cpuAllocation.ffmpegThreadsPerJob <= 2) {
    preset = 'faster'
  } else if (cpuAllocation.ffmpegThreadsPerJob <= 4) {
    preset = 'fast'
  } else {
    preset = 'medium'
  }

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] CPU optimization:', {
      availableThreads: cpuAllocation.effectiveThreads,
      budgetThreads: cpuAllocation.budgetThreads,
      activeJobs: dynamic.activeJobs,
      selectedPreset: preset,
      threads,
    })
  }

  // Get video metadata for duration (needed for progress calculation)
  const metadata = await getVideoMetadata(inputPath)
  const duration = metadata.duration

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Input video metadata:', metadata)
  }

  // Build video filters
  const filters: string[] = []

  // Scale video
  filters.push(`scale=${width}:${height}`)

  const filterComplex = filters.join(',')

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Built filter complex:', filterComplex)
  }

  // Build ffmpeg arguments with optimizations.
  // `-threads` before `-i` applies to the decoder/input side; `-threads:v`
  // before the output file caps the libx264 encoder as well.  Keeping
  // `-filter_threads` at 1 prevents our lightweight filter graph from
  // spawning a separate pool sized to all visible CPUs.
  const args = [
    '-v', 'verbose', // Enable verbose logging for debug
    '-threads', threads.toString(),
    '-i', inputPath,
    '-vf', filterComplex,
    '-filter_threads', '1',
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', '23', // Constant Rate Factor: 18-28 range (lower = better quality, 23 is default)
    '-profile:v', 'high',
    '-level', '4.1',
    // HLS ABR alignment: force an IDR every HLS_KEYFRAME_INTERVAL_SECONDS and disable
    // scene-cut keyframes, so this rendition's keyframes (and therefore its `-c copy` HLS
    // segment boundaries) land at the same timestamps as every other rendition's.
    ...(alignKeyframes
      ? ['-force_key_frames', `expr:gte(t,n_forced*${HLS_KEYFRAME_INTERVAL_SECONDS})`, '-x264-params', 'scenecut=0']
      : []),
    '-pix_fmt', 'yuv420p', // Ensure compatibility with all players (especially Safari/iOS)
    '-c:a', 'aac',
    '-b:a', '128k', // Reduced from 192k to 128k (sufficient for most use cases, saves bandwidth)
    '-ar', '48000', // Standard audio sample rate
    '-max_muxing_queue_size', '1024', // Prevent muxing errors on high-bitrate videos
    '-progress', 'pipe:2',
    '-threads:v', threads.toString(),
    // Output muxer: HLS (fMP4/CMAF) directly, or a faststart MP4. The HLS flags mirror
    // packageHlsRendition exactly, so a direct encode is byte-compatible with the old
    // encode-then-remux pipeline the delivery route expects.
    ...(hlsOutputDir
      ? [
          '-f', 'hls',
          '-hls_time', String(segmentDurationSeconds),
          '-hls_playlist_type', 'vod',
          '-hls_segment_type', 'fmp4',
          '-hls_flags', 'independent_segments',
          '-hls_fmp4_init_filename', 'init.mp4',
          '-hls_segment_filename', path.join(hlsOutputDir, 'seg-%05d.m4s'),
          '-y',
          path.join(hlsOutputDir, 'index.m3u8'),
        ]
      : [
          '-movflags', '+faststart', // Enable progressive download (moov atom at start)
          '-y', // Overwrite output file
          outputPath as string,
        ])
  ]

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Executing command:', ffmpegPath, args.join(' '))
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let abortRequested = false
    let abortCheckInFlight = false
    let forcedKillTimer: NodeJS.Timeout | null = null

    const clearAbortTimers = () => {
      if (abortPollInterval) {
        clearInterval(abortPollInterval)
      }
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer)
      }
    }

    const requestAbort = () => {
      if (abortRequested) {
        return
      }

      abortRequested = true

      if (!ffmpeg.killed && ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGTERM')
        forcedKillTimer = setTimeout(() => {
          if (!ffmpeg.killed && ffmpeg.exitCode === null) {
            ffmpeg.kill('SIGKILL')
          }
        }, 5000)
        forcedKillTimer.unref?.()
      }
    }

    const pollForAbort = async () => {
      if (!shouldAbort || abortRequested || abortCheckInFlight) {
        return
      }

      abortCheckInFlight = true
      try {
        const shouldCancel = await shouldAbort()
        if (shouldCancel) {
          requestAbort()
        }
      } catch (error) {
        console.error('[FFMPEG] Failed to evaluate transcode cancellation state:', error)
      } finally {
        abortCheckInFlight = false
      }
    }

    const abortPollInterval = shouldAbort
      ? setInterval(() => {
          void pollForAbort()
        }, 2000)
      : null

    if (abortPollInterval) {
      abortPollInterval.unref?.()
      void pollForAbort()
    }

    if (DEBUG) {
      console.log('[FFMPEG DEBUG] FFmpeg process spawned, PID:', ffmpeg.pid)
    }

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text

      // In debug mode, log all stderr output
      if (DEBUG) {
        console.log('[FFMPEG STDERR]', text.trim())
      }

      // Parse progress from stderr
      if (onProgress && duration > 0) {
        const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/)
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10)
          const minutes = parseInt(timeMatch[2], 10)
          const seconds = parseFloat(timeMatch[3])
          const currentTime = hours * 3600 + minutes * 60 + seconds
          const progress = Math.min(currentTime / duration, 1)
          if (DEBUG) {
            console.log('[FFMPEG DEBUG] Progress:', Math.round(progress * 100) + '%')
          }
          onProgress(progress)
        }
      }

      // Log errors and warnings (even when not in debug mode)
      if (!DEBUG && (text.includes('error') || text.includes('Error') || text.includes('failed'))) {
        console.error('FFmpeg stderr:', text)
      }
    })

    ffmpeg.on('close', (code) => {
      clearAbortTimers()

      if (DEBUG) {
        console.log('[FFMPEG DEBUG] Process exited with code:', code)
      }

      if (abortRequested) {
        reject(new FFmpegCancellationError('FFmpeg transcode cancelled'))
        return
      }

      if (code === 0) {
        if (DEBUG) {
          console.log('[FFMPEG DEBUG] Transcoding completed successfully')
        }
        resolve()
      } else {
        if (DEBUG) {
          console.error('[FFMPEG DEBUG] Transcoding failed with code:', code)
          console.error('[FFMPEG DEBUG] Full stderr output:', stderr)
        }
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`))
      }
    })

    ffmpeg.on('error', (err) => {
      clearAbortTimers()

      if (DEBUG) {
        console.error('[FFMPEG DEBUG] Failed to spawn FFmpeg:', err)
      }

      if (abortRequested) {
        reject(new FFmpegCancellationError('FFmpeg transcode cancelled'))
        return
      }

      reject(new Error(`Failed to start FFmpeg: ${err.message}`))
    })
  })
}

export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  timestamp: number = 10
): Promise<void> {
  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Starting generateThumbnail:', {
      inputPath,
      outputPath,
      timestamp
    })
  }

  const cpuAllocation = getCpuAllocation()
  const thumbThreads = cpuAllocation.timelineThreadsPerJob

  const args = [
    '-v', 'verbose', // Enable verbose logging for debug
    '-threads', thumbThreads.toString(),
    '-ss', timestamp.toString(), // Seek before input (faster - avoids decoding entire video)
    '-i', inputPath,
    '-filter_threads', '1',
    '-vframes', '1', // Extract single frame
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease', // Maintain aspect ratio without padding
    '-q:v', '2', // High quality JPEG (1-31 scale, 2 = excellent quality)
    '-y', // Overwrite output file
    outputPath
  ]

  if (DEBUG) {
    console.log('[FFMPEG DEBUG] Thumbnail command:', ffmpegPath, args.join(' '))
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''

    if (DEBUG) {
      console.log('[FFMPEG DEBUG] Thumbnail process spawned, PID:', ffmpeg.pid)
    }

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      if (DEBUG) {
        console.log('[FFMPEG THUMBNAIL STDERR]', text.trim())
      }
    })

    ffmpeg.on('close', (code) => {
      if (DEBUG) {
        console.log('[FFMPEG DEBUG] Thumbnail process exited with code:', code)
      }

      if (code === 0) {
        if (DEBUG) {
          console.log('[FFMPEG DEBUG] Thumbnail generated successfully')
        }
        resolve()
      } else {
        if (DEBUG) {
          console.error('[FFMPEG DEBUG] Thumbnail generation failed:', stderr)
        }
        reject(new Error(`FFmpeg thumbnail generation failed: ${stderr}`))
      }
    })

    ffmpeg.on('error', (err) => {
      if (DEBUG) {
        console.error('[FFMPEG DEBUG] Failed to spawn FFmpeg for thumbnail:', err)
      }
      reject(new Error(`Failed to start FFmpeg: ${err.message}`))
    })
  })
}

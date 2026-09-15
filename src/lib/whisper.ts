/**
 * Whisper HTTP client — talks to an OpenAI-compatible transcription server
 * (e.g. speaches / faster-whisper-server) over the LAN. Inference runs on the
 * NAS next to the worker; the web app cannot reach it (same topology as the
 * Ollama AI assistant), so all calls happen from worker processors.
 */
import { readFile } from 'fs/promises'

export interface WhisperConfig {
  /** Base URL, e.g. "http://127.0.0.1:8000" (local) or "https://api.openai.com" (OpenAI) */
  url: string
  /** Model id, e.g. "deepdml/faster-whisper-large-v3-turbo-ct2" (local) or "whisper-1" (OpenAI) */
  model: string
  /** Language hint (ISO 639-1). Empty/undefined = server autodetect. */
  language?: string | null
  /** Bearer token — set for OpenAI (api.openai.com); omitted for a self-hosted server. */
  apiKey?: string | null
}

function authHeaders(config: WhisperConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

export class WhisperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhisperError'
  }
}

function baseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeFetchError(e: unknown, url: string): WhisperError {
  if (e instanceof WhisperError) return e
  const cause = (e as { cause?: { code?: string } })?.cause
  if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND' || cause?.code === 'EHOSTUNREACH') {
    return new WhisperError(`Whisper server unreachable from worker at ${url} (${cause.code})`)
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return new WhisperError('Whisper request timed out')
  }
  return new WhisperError(e instanceof Error ? e.message : String(e))
}

/**
 * Transcribe an audio file. responseFormat 'srt' returns raw SRT text;
 * 'json' returns the plain transcript text.
 *
 * For word-level timestamps use {@link whisperTranscribeVerbose} instead —
 * it requests `verbose_json` with `timestamp_granularities=["word"]` so
 * every word carries start/end times, enabling precise subtitle timing.
 */
export async function whisperTranscribe(params: {
  config: WhisperConfig
  audio: Buffer | string // Buffer, or path to a local file
  fileName: string
  mimeType: string
  responseFormat: 'srt' | 'json'
  timeoutMs: number
}): Promise<string> {
  const { config, fileName, mimeType, responseFormat, timeoutMs } = params
  const buffer = typeof params.audio === 'string' ? await readFile(params.audio) : params.audio

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName)
  form.append('model', config.model)
  form.append('response_format', responseFormat)
  // Whisper (and OpenAI) require a bare ISO 639-1 code, not a BCP-47 locale.
  // Strip any region subtag so "en-GB"/"en_AU" → "en".
  const language = config.language?.trim().split(/[-_]/)[0].toLowerCase()
  if (language) form.append('language', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl(config.url)}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new WhisperError(`Whisper server returned ${res.status}: ${body.slice(0, 300)}`)
    }
    if (responseFormat === 'srt') {
      return await res.text()
    }
    const json = (await res.json()) as { text?: string }
    if (typeof json.text !== 'string') {
      throw new WhisperError('Whisper JSON response missing "text" field')
    }
    return json.text
  } catch (e) {
    throw normalizeFetchError(e, config.url)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Word-level timestamps (verbose_json)
// ---------------------------------------------------------------------------

/** A single word with start/end times in seconds. */
export interface WhisperWord {
  word: string
  start: number
  end: number
}

/** One segment from a verbose_json response — includes word timestamps when requested. */
export interface WhisperVerboseSegment {
  id: number
  seek: number
  start: number
  end: number
  text: string
  tokens: number[]
  temperature: number
  avg_logprob: number
  compression_ratio: number
  no_speech_prob: number
  words?: WhisperWord[]
}

/** The full verbose_json transcription response. */
export interface WhisperVerboseJsonResponse {
  task: string
  language: string
  duration: number
  text: string
  /**
   * Populated only when 'segment' granularity is requested. OpenAI omits this
   * array entirely when the request asks for word timings alone — its own SDK
   * types both `segments` and `words` as optional — so never assume it exists.
   */
  segments?: WhisperVerboseSegment[]
  /** The flat word stream: OpenAI's only word carrier, and Speaches returns it too. */
  words?: WhisperWord[]
}

/**
 * Transcribe with word-level timestamps. Requests `verbose_json` +
 * `timestamp_granularities=["word"]` so every word carries start/end times.
 * Supported by OpenAI's whisper-1 and by Speaches / faster-whisper-server;
 * a server or model that rejects it (or answers without a `words` array)
 * falls back to {@link whisperTranscribe} with 'srt' format.
 *
 * Word timing matters beyond neatness: without it faster-whisper reports a
 * segment's start from coarse token timestamps, which drift onto the start of
 * the decode window when the audio opens on music rather than silence — the
 * cause of captions appearing at 00:00 over a musical intro.
 */
export async function whisperTranscribeVerbose(params: {
  config: WhisperConfig
  audio: Buffer | string
  fileName: string
  mimeType: string
  timeoutMs: number
}): Promise<WhisperVerboseJsonResponse> {
  const { config, fileName, mimeType, timeoutMs } = params
  const buffer = typeof params.audio === 'string' ? await readFile(params.audio) : params.audio

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName)
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  // Both granularities: asking for 'word' alone makes OpenAI drop `segments`
  // from the response, and segment timestamps add no latency of their own.
  form.append('timestamp_granularities[]', 'segment')
  form.append('timestamp_granularities[]', 'word')
  const language = config.language?.trim().split(/[-_]/)[0].toLowerCase()
  if (language) form.append('language', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl(config.url)}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new WhisperError(`Whisper server returned ${res.status}: ${body.slice(0, 300)}`)
    }
    const json = (await res.json()) as WhisperVerboseJsonResponse
    const hasWords = Array.isArray(json.words) && json.words.length > 0
    const hasSegments = Array.isArray(json.segments) && json.segments.length > 0
    if (!hasWords && !hasSegments) {
      throw new WhisperError('Whisper verbose_json response carried neither "words" nor "segments"')
    }
    return json
  } catch (e) {
    throw normalizeFetchError(e, config.url)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Liveness + configuration check: GET /v1/models and verify the configured
 * model is listed. Returns a human-readable detail string on success.
 */
export async function whisperTestConnection(config: WhisperConfig, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl(config.url)}/v1/models`, {
      headers: authHeaders(config),
      signal: controller.signal,
    })
    if (!res.ok) {
      if (res.status === 401) {
        throw new WhisperError('Authentication failed — check the API key.')
      }
      throw new WhisperError(`Whisper server returned ${res.status} from /v1/models`)
    }
    const json = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null
    const ids = (json?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
    if (ids.length === 0) {
      return 'Server reachable. Model list is empty or not reported — the configured model will be loaded on first use.'
    }
    if (!ids.includes(config.model)) {
      // Not fatal: many servers download/alias models on demand
      return `Server reachable. Configured model "${config.model}" not in the reported list (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}) — it may still load on demand.`
    }
    return `Server reachable. Model "${config.model}" is available.`
  } catch (e) {
    throw normalizeFetchError(e, config.url)
  } finally {
    clearTimeout(timer)
  }
}

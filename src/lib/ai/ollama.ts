import type { AiDriver, AiGenerateParams, AiTestResult, AiUserContentPart } from './types'

const DEFAULT_TIMEOUT_MS = 180_000

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Base64 image payloads — only consumed by multimodal (vision) models */
  images?: string[]
}

/**
 * Ollama has no content-part syntax: text parts are concatenated into `content`
 * and images ride in `message.images`. PDFs are unsupported natively — the
 * worker text-extracts them first (supportsPdfInput: false), so a document
 * part reaching this driver is a programming error.
 */
function toOllamaMessage(user: string | AiUserContentPart[]): OllamaChatMessage {
  if (typeof user === 'string') return { role: 'user', content: user }
  const texts: string[] = []
  const images: string[] = []
  for (const part of user) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type === 'image') images.push(part.base64)
    else throw new Error('Ollama cannot read PDFs natively — extract the text first')
  }
  const message: OllamaChatMessage = { role: 'user', content: texts.join('\n\n') }
  if (images.length > 0) message.images = images
  return message
}

async function ollamaChat(
  url: string,
  model: string,
  messages: OllamaChatMessage[],
  jsonSchema: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        // Grammar-constrained decoding — the main JSON-reliability lever on local models
        format: jsonSchema,
        options: { temperature: 0.2, num_ctx: 16384 },
        keep_alive: '10m',
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Ollama chat failed: HTTP ${response.status} ${body.slice(0, 300)}`)
    }
    const data = (await response.json()) as { message?: { content?: string } }
    const content = data.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Ollama chat returned an empty response')
    }
    return content
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createOllamaDriver(config: { url: string; model: string }): AiDriver {
  const { url, model } = config
  return {
    label: `OLLAMA:${model}`,
    supportsPdfInput: false,

    async generateStructured(params: AiGenerateParams): Promise<unknown> {
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // The repair round-trip below reuses `messages`, so images survive the retry
      const messages: OllamaChatMessage[] = [
        { role: 'system', content: params.system },
        toOllamaMessage(params.user),
      ]
      const first = await ollamaChat(url, model, messages, params.jsonSchema, timeoutMs)
      try {
        return JSON.parse(first)
      } catch (parseError) {
        // One repair round-trip: show the model its own output and the parse error
        const detail = parseError instanceof Error ? parseError.message : String(parseError)
        const repaired = await ollamaChat(
          url,
          model,
          [
            ...messages,
            { role: 'assistant', content: first },
            {
              role: 'user',
              content: `Your previous response was not valid JSON (${detail}). Respond again with ONLY the corrected JSON document matching the schema — no prose, no code fences.`,
            },
          ],
          params.jsonSchema,
          timeoutMs
        )
        return JSON.parse(repaired)
      }
    },

    async testConnection(): Promise<AiTestResult> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, {
          signal: controller.signal,
        })
        if (!response.ok) {
          return { ok: false, detail: `Ollama responded with HTTP ${response.status}` }
        }
        const data = (await response.json()) as { models?: Array<{ name?: string }> }
        const names = (data.models ?? []).map((m) => m.name ?? '')
        // "qwen3:30b-a3b" should match itself and its bare-name form
        const found = names.some((n) => n === model || n === `${model}:latest` || n.split(':')[0] === model)
        if (!found) {
          return {
            ok: false,
            detail: `Connected, but model "${model}" is not installed. Available: ${names.join(', ') || '(none)'}`,
          }
        }
        return { ok: true, detail: `Connected — model "${model}" is available.` }
      } catch (error) {
        const detail = error instanceof Error && error.name === 'AbortError'
          ? 'Connection timed out after 10s'
          : error instanceof Error ? error.message : String(error)
        return { ok: false, detail: `Could not reach Ollama at ${url}: ${detail}` }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

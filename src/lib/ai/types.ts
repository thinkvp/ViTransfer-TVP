import type { ZodType } from 'zod'

/**
 * A piece of the user turn. Plain requests pass a single string; expense
 * (receipt) requests pass an array mixing text with native image/PDF parts.
 */
export type AiUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType: string } // image/jpeg | image/png | image/webp
  | { type: 'document'; base64: string; mimeType: 'application/pdf'; fileName: string }

export interface AiGenerateParams {
  system: string
  user: string | AiUserContentPart[]
  /** Zod schema — used by the Anthropic driver (messages.parse guarantees schema-valid output) */
  schema: ZodType
  /** Plain JSON schema — used by the Ollama driver (`format` grammar-constrained decoding) */
  jsonSchema: Record<string, unknown>
  timeoutMs?: number
}

export interface AiTestResult {
  ok: boolean
  detail: string
}

export interface AiDriver {
  /** e.g. "OLLAMA:qwen3:30b-a3b" — persisted on the request row for audit */
  readonly label: string
  /** Whether PDFs can be sent as native document parts (false → caller falls back to text extraction) */
  readonly supportsPdfInput: boolean
  /** Returns parsed (but not yet zod-validated) JSON output */
  generateStructured(params: AiGenerateParams): Promise<unknown>
  testConnection(): Promise<AiTestResult>
}

export type AiProvider = 'NONE' | 'OLLAMA' | 'ANTHROPIC' | 'OPENAI'

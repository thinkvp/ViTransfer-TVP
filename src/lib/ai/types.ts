import type { ZodType } from 'zod'

export interface AiGenerateParams {
  system: string
  user: string
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
  /** Returns parsed (but not yet zod-validated) JSON output */
  generateStructured(params: AiGenerateParams): Promise<unknown>
  testConnection(): Promise<AiTestResult>
}

export type AiProvider = 'NONE' | 'OLLAMA' | 'ANTHROPIC' | 'OPENAI'

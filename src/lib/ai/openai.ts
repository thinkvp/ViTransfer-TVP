import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { AiDriver, AiGenerateParams, AiTestResult } from './types'

const DEFAULT_TIMEOUT_MS = 180_000

export function createOpenAiDriver(config: { apiKey: string; model: string }): AiDriver {
  const { apiKey, model } = config
  const client = new OpenAI({ apiKey })

  return {
    label: `OPENAI:${model}`,

    async generateStructured(params: AiGenerateParams): Promise<unknown> {
      const completion = await client.chat.completions.parse(
        {
          model,
          messages: [
            { role: 'system', content: params.system },
            { role: 'user', content: params.user },
          ],
          // Strict Structured Outputs — the OpenAI equivalent of the Anthropic parse path.
          // The zod helper builds an OpenAI-compatible strict JSON schema from the same schema.
          response_format: zodResponseFormat(params.schema, 'assistant_result'),
        },
        { timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS }
      )
      const choice = completion.choices[0]
      if (choice?.message?.refusal) {
        throw new Error(`OpenAI declined the request: ${choice.message.refusal}`)
      }
      if (choice?.finish_reason === 'length') {
        throw new Error('OpenAI response was truncated (max tokens reached)')
      }
      const parsed = choice?.message?.parsed
      if (parsed == null) {
        throw new Error(`OpenAI returned no parseable output (finish_reason: ${choice?.finish_reason})`)
      }
      return parsed
    },

    async testConnection(): Promise<AiTestResult> {
      try {
        const info = await client.models.retrieve(model)
        return { ok: true, detail: `Connected — model "${info.id}" is available.` }
      } catch (error) {
        if (error instanceof OpenAI.AuthenticationError) {
          return { ok: false, detail: 'Authentication failed — check the API key.' }
        }
        if (error instanceof OpenAI.NotFoundError) {
          return { ok: false, detail: `Model "${model}" was not found — check the model name.` }
        }
        if (error instanceof OpenAI.APIConnectionError) {
          return { ok: false, detail: 'Could not reach the OpenAI API (network error from the worker).' }
        }
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false, detail: `OpenAI API error: ${detail}` }
      }
    },
  }
}

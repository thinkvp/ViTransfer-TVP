import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { AiDriver, AiGenerateParams, AiTestResult } from './types'

const DEFAULT_TIMEOUT_MS = 180_000

export function createAnthropicDriver(config: { apiKey: string; model: string }): AiDriver {
  const { apiKey, model } = config
  const client = new Anthropic({ apiKey })

  return {
    label: `ANTHROPIC:${model}`,

    async generateStructured(params: AiGenerateParams): Promise<unknown> {
      const response = await client.messages.parse(
        {
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          system: params.system,
          output_config: { format: zodOutputFormat(params.schema) },
          messages: [{ role: 'user', content: params.user }],
        },
        { timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS }
      )
      if (response.stop_reason === 'refusal') {
        throw new Error('Anthropic declined the request (stop_reason: refusal)')
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Anthropic response was truncated (max_tokens reached)')
      }
      if (response.parsed_output == null) {
        throw new Error(`Anthropic returned no parseable output (stop_reason: ${response.stop_reason})`)
      }
      return response.parsed_output
    },

    async testConnection(): Promise<AiTestResult> {
      try {
        const info = await client.models.retrieve(model)
        return { ok: true, detail: `Connected — model "${info.display_name ?? info.id}" is available.` }
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          return { ok: false, detail: 'Authentication failed — check the API key.' }
        }
        if (error instanceof Anthropic.NotFoundError) {
          return { ok: false, detail: `Model "${model}" was not found — check the model name.` }
        }
        if (error instanceof Anthropic.APIConnectionError) {
          return { ok: false, detail: 'Could not reach the Anthropic API (network error from the worker).' }
        }
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false, detail: `Anthropic API error: ${detail}` }
      }
    },
  }
}

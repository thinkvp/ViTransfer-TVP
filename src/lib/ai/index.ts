import { prisma } from '../db'
import { decrypt } from '../encryption'
import { createOllamaDriver } from './ollama'
import { createAnthropicDriver } from './anthropic'
import { createOpenAiDriver } from './openai'
import type { AiDriver } from './types'

export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiNotConfiguredError'
  }
}

/**
 * Build the configured AI driver from Settings. Called from the WORKER at job
 * time (the Ollama endpoint is only reachable from there); reads fresh settings
 * per call — assistant requests are infrequent enough that caching isn't worth it.
 */
export async function getAiDriver(): Promise<AiDriver> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      aiProvider: true,
      aiOllamaUrl: true,
      aiOllamaModel: true,
      aiAnthropicModel: true,
      aiAnthropicApiKey: true,
      aiOpenaiModel: true,
      aiOpenaiApiKey: true,
    },
  })

  const provider = settings?.aiProvider ?? 'NONE'

  if (provider === 'OLLAMA') {
    if (!settings?.aiOllamaUrl || !settings.aiOllamaModel) {
      throw new AiNotConfiguredError('Ollama is selected but the URL or model is not configured.')
    }
    return createOllamaDriver({ url: settings.aiOllamaUrl, model: settings.aiOllamaModel })
  }

  if (provider === 'ANTHROPIC') {
    if (!settings?.aiAnthropicApiKey) {
      throw new AiNotConfiguredError('Anthropic is selected but no API key is configured.')
    }
    const apiKey = decrypt(settings.aiAnthropicApiKey)
    if (!apiKey) {
      throw new AiNotConfiguredError('The stored Anthropic API key could not be decrypted.')
    }
    return createAnthropicDriver({
      apiKey,
      model: settings.aiAnthropicModel || 'claude-opus-4-8',
    })
  }

  if (provider === 'OPENAI') {
    if (!settings?.aiOpenaiApiKey) {
      throw new AiNotConfiguredError('OpenAI is selected but no API key is configured.')
    }
    const apiKey = decrypt(settings.aiOpenaiApiKey)
    if (!apiKey) {
      throw new AiNotConfiguredError('The stored OpenAI API key could not be decrypted.')
    }
    return createOpenAiDriver({
      apiKey,
      model: settings.aiOpenaiModel || 'gpt-4o',
    })
  }

  throw new AiNotConfiguredError('No AI provider is configured. Set one up in Settings → AI Assistant.')
}

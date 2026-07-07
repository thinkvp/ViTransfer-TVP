'use client'

import { useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ChevronDown, ChevronUp, PlugZap } from 'lucide-react'
import { apiPost, apiFetch } from '@/lib/api-client'

export interface PortfolioRow {
  id?: string
  title: string
  url: string
  description: string
}

interface AiAssistantSettingsSectionProps {
  aiProvider: string
  setAiProvider: (value: string) => void
  aiOllamaUrl: string
  setAiOllamaUrl: (value: string) => void
  aiOllamaModel: string
  setAiOllamaModel: (value: string) => void
  aiAnthropicModel: string
  setAiAnthropicModel: (value: string) => void
  aiAnthropicApiKey: string
  setAiAnthropicApiKey: (value: string) => void
  aiOpenaiModel: string
  setAiOpenaiModel: (value: string) => void
  aiOpenaiApiKey: string
  setAiOpenaiApiKey: (value: string) => void
  /** Vestigial: reply drafting is now opt-in per request via the assistant page "Response" pill */
  aiReplyDraftsEnabled?: boolean
  setAiReplyDraftsEnabled?: (value: boolean) => void
  aiReplySignature: string
  setAiReplySignature: (value: string) => void
  aiInstructions: string
  setAiInstructions: (value: string) => void
  /** Vestigial: the portfolio library was removed; props kept optional so callers still compile */
  aiPortfolio?: PortfolioRow[]
  setAiPortfolio?: (value: PortfolioRow[]) => void
  show: boolean
  setShow: (value: boolean) => void
  hideCollapse?: boolean
}

const TEST_POLL_INTERVAL_MS = 2500
const TEST_POLL_MAX_ATTEMPTS = 24 // ~60s — covers a cold worker pickup

export function AiAssistantSettingsSection({
  aiProvider,
  setAiProvider,
  aiOllamaUrl,
  setAiOllamaUrl,
  aiOllamaModel,
  setAiOllamaModel,
  aiAnthropicModel,
  setAiAnthropicModel,
  aiAnthropicApiKey,
  setAiAnthropicApiKey,
  aiOpenaiModel,
  setAiOpenaiModel,
  aiOpenaiApiKey,
  setAiOpenaiApiKey,
  aiReplySignature,
  setAiReplySignature,
  aiInstructions,
  setAiInstructions,
  show,
  setShow,
  hideCollapse,
}: AiAssistantSettingsSectionProps) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const testRunRef = useRef(0)

  async function handleTestConnection() {
    const runId = ++testRunRef.current
    setTesting(true)
    setTestResult(null)
    try {
      // The test runs on the WORKER (only it can reach Ollama), so enqueue + poll
      const { id } = await apiPost<{ ok: boolean; id: string }>('/api/admin/assistant/test-connection', {})

      for (let attempt = 0; attempt < TEST_POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, TEST_POLL_INTERVAL_MS))
        if (testRunRef.current !== runId) return
        const pollRes = await apiFetch(`/api/admin/assistant/requests/${id}`)
        if (!pollRes.ok) continue
        const { request } = await pollRes.json()
        if (request.status === 'COMPLETED') {
          const detail = (request.resultJson as any)?.connectionTest?.detail || 'Connection successful.'
          setTestResult({ type: 'success', message: detail })
          setTesting(false)
          return
        }
        if (request.status === 'FAILED') {
          setTestResult({ type: 'error', message: request.error || 'Connection test failed.' })
          setTesting(false)
          return
        }
      }
      setTestResult({
        type: 'error',
        message: 'Test timed out — the worker may be offline or still starting the model.',
      })
    } catch (error) {
      setTestResult({ type: 'error', message: error instanceof Error ? error.message : 'Connection test failed.' })
    } finally {
      if (testRunRef.current === runId) setTesting(false)
    }
  }

  return (
    <Card className="border-border">
      <CardHeader
        className={hideCollapse ? undefined : 'cursor-pointer hover:bg-accent/50 transition-colors'}
        onClick={hideCollapse ? undefined : () => setShow(!show)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AI Assistant</CardTitle>
            <CardDescription>
              Configure the LLM used to draft projects, quotes and invoices from briefs
            </CardDescription>
          </div>
          {!hideCollapse && (show ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
          ))}
        </div>
      </CardHeader>

      {(show || hideCollapse) && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="space-y-2">
            <Label>Provider</Label>
            <div className="space-y-3 p-4 bg-muted/50 rounded-md border border-border">
              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="aiProvider"
                  value="NONE"
                  checked={aiProvider === 'NONE'}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm group-hover:text-primary transition-colors">Disabled</div>
                  <div className="text-xs text-muted-foreground mt-1">The AI Assistant page stays inactive.</div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="aiProvider"
                  value="OLLAMA"
                  checked={aiProvider === 'OLLAMA'}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm group-hover:text-primary transition-colors">
                    Local model (Ollama)
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Runs on your own hardware — briefs never leave your network. The URL must be reachable from the
                    machine running the <span className="font-mono">worker</span>, not the web app.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="aiProvider"
                  value="ANTHROPIC"
                  checked={aiProvider === 'ANTHROPIC'}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm group-hover:text-primary transition-colors">
                    Anthropic API (Claude)
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Highest quality extraction. Brief text is sent to the Anthropic API; billed per request.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="aiProvider"
                  value="OPENAI"
                  checked={aiProvider === 'OPENAI'}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm group-hover:text-primary transition-colors">
                    OpenAI API (GPT)
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    High quality extraction via OpenAI. Brief text is sent to the OpenAI API; billed per request.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {aiProvider === 'OLLAMA' && (
            <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="aiOllamaUrl">Ollama URL</Label>
                  <Input
                    id="aiOllamaUrl"
                    type="text"
                    value={aiOllamaUrl}
                    onChange={(e) => setAiOllamaUrl(e.target.value)}
                    placeholder="http://127.0.0.1:11434"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="aiOllamaModel">Model</Label>
                  <Input
                    id="aiOllamaModel"
                    type="text"
                    value={aiOllamaModel}
                    onChange={(e) => setAiOllamaModel(e.target.value)}
                    placeholder="qwen3:30b-a3b"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                If Ollama runs on the same machine as the worker, use http://127.0.0.1:11434.
              </p>
            </div>
          )}

          {aiProvider === 'ANTHROPIC' && (
            <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
              <div className="space-y-2">
                <Label htmlFor="aiAnthropicApiKey">API Key</Label>
                <PasswordInput
                  id="aiAnthropicApiKey"
                  value={aiAnthropicApiKey}
                  onChange={(e) => setAiAnthropicApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                />
                <p className="text-xs text-muted-foreground">Stored encrypted; only decrypted by the worker at call time.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="aiAnthropicModel">Model</Label>
                <Input
                  id="aiAnthropicModel"
                  type="text"
                  value={aiAnthropicModel}
                  onChange={(e) => setAiAnthropicModel(e.target.value)}
                  placeholder="claude-opus-4-8"
                />
              </div>
            </div>
          )}

          {aiProvider === 'OPENAI' && (
            <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
              <div className="space-y-2">
                <Label htmlFor="aiOpenaiApiKey">API Key</Label>
                <PasswordInput
                  id="aiOpenaiApiKey"
                  value={aiOpenaiApiKey}
                  onChange={(e) => setAiOpenaiApiKey(e.target.value)}
                  placeholder="sk-..."
                />
                <p className="text-xs text-muted-foreground">Stored encrypted; only decrypted by the worker at call time.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="aiOpenaiModel">Model</Label>
                <Input
                  id="aiOpenaiModel"
                  type="text"
                  value={aiOpenaiModel}
                  onChange={(e) => setAiOpenaiModel(e.target.value)}
                  placeholder="gpt-4o"
                />
                <p className="text-xs text-muted-foreground">Use a model that supports Structured Outputs (e.g. gpt-4o, gpt-4o-mini, gpt-4.1).</p>
              </div>
            </div>
          )}

          {aiProvider !== 'NONE' && (
            <div className="space-y-2">
              <Button type="button" variant="outline" onClick={handleTestConnection} disabled={testing}>
                {testing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Testing via worker…
                  </>
                ) : (
                  <>
                    <PlugZap className="w-4 h-4 mr-2" />
                    Test connection
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Save settings first — the test uses the saved configuration and runs through the background worker.
              </p>
              {testResult && (
                <p className={`text-sm ${testResult.type === 'success' ? 'text-green-600 dark:text-green-500' : 'text-destructive'}`}>
                  {testResult.message}
                </p>
              )}
            </div>
          )}

          {aiProvider !== 'NONE' && (
            <div className="space-y-5 border-t pt-5">
              <div>
                <Label className="text-base">Customisation</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Shape what the assistant proposes. These guide its suggestions — the safety checks and your review
                  before anything is created still apply.
                </p>
              </div>

              {/* Enquiry reply sign-off — replies are requested per-request from the
                  assistant page ("Response" pill); this sign-off is appended when they are. */}
              <div className="space-y-2 border p-4 rounded-lg bg-muted/30">
                <Label htmlFor="aiReplySignature">Reply sign-off</Label>
                <p className="text-xs text-muted-foreground">
                  When you ask the assistant for a <span className="font-medium text-foreground/90">Response</span>, this
                  sign-off is appended verbatim to the drafted reply.
                </p>
                <Textarea
                  id="aiReplySignature"
                  rows={3}
                  value={aiReplySignature}
                  onChange={(e) => setAiReplySignature(e.target.value)}
                  placeholder={'Cheers,\nThe ThinkVP Team\n03 1234 5678'}
                />
              </div>

              {/* Freeform studio instructions */}
              <div className="space-y-2">
                <Label htmlFor="aiInstructions">Studio instructions (house style)</Label>
                <Textarea
                  id="aiInstructions"
                  rows={5}
                  value={aiInstructions}
                  onChange={(e) => setAiInstructions(e.target.value)}
                  placeholder={
                    'Free-form guidance, one per line. e.g.\n' +
                    '- Australian English, warm but concise, no exclamation marks.\n' +
                    '- We don’t quote weddings — flag those instead of quoting.\n' +
                    '- If no delivery date is given, assume 3 weeks after the shoot.'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Like a house-style note the assistant reads every time. Good for tone, phrasing and default
                  assumptions — not a place for rules that must never break (those are enforced in code).
                </p>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

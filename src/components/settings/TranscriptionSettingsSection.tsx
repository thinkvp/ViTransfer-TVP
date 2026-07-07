'use client'

import { useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { Loader2, ChevronDown, ChevronUp, PlugZap } from 'lucide-react'
import { apiPost, apiFetch } from '@/lib/api-client'

interface TranscriptionSettingsSectionProps {
  transcriptionEnabled: boolean
  setTranscriptionEnabled: (value: boolean) => void
  transcriptionProvider: string
  setTranscriptionProvider: (value: string) => void
  transcriptionWhisperUrl: string
  setTranscriptionWhisperUrl: (value: string) => void
  transcriptionWhisperModel: string
  setTranscriptionWhisperModel: (value: string) => void
  transcriptionOpenaiApiKey: string
  setTranscriptionOpenaiApiKey: (value: string) => void
  transcriptionOpenaiModel: string
  setTranscriptionOpenaiModel: (value: string) => void
  transcriptionLanguage: string
  setTranscriptionLanguage: (value: string) => void
  transcriptionMaxCharsPerLine: number | ''
  setTranscriptionMaxCharsPerLine: (value: number | '') => void
  transcriptionMaxLines: number | ''
  setTranscriptionMaxLines: (value: number | '') => void
  show: boolean
  setShow: (value: boolean) => void
  hideCollapse?: boolean
}

const TEST_POLL_INTERVAL_MS = 2500
const TEST_POLL_MAX_ATTEMPTS = 24 // ~60s — covers a cold worker pickup

export function TranscriptionSettingsSection({
  transcriptionEnabled,
  setTranscriptionEnabled,
  transcriptionProvider,
  setTranscriptionProvider,
  transcriptionWhisperUrl,
  setTranscriptionWhisperUrl,
  transcriptionWhisperModel,
  setTranscriptionWhisperModel,
  transcriptionOpenaiApiKey,
  setTranscriptionOpenaiApiKey,
  transcriptionOpenaiModel,
  setTranscriptionOpenaiModel,
  transcriptionLanguage,
  setTranscriptionLanguage,
  transcriptionMaxCharsPerLine,
  setTranscriptionMaxCharsPerLine,
  transcriptionMaxLines,
  setTranscriptionMaxLines,
  show,
  setShow,
  hideCollapse,
}: TranscriptionSettingsSectionProps) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const testRunRef = useRef(0)
  const isOpenai = transcriptionProvider === 'OPENAI'

  function numberInput(value: number | '', setValue: (v: number | '') => void) {
    return {
      value: value === '' ? '' : String(value),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.trim()
        if (raw === '') { setValue(''); return }
        const n = parseInt(raw, 10)
        if (Number.isFinite(n)) setValue(Math.max(0, Math.min(200, n)))
      },
    }
  }

  async function handleTestConnection() {
    const runId = ++testRunRef.current
    setTesting(true)
    setTestResult(null)
    try {
      // The test runs on the WORKER (only it can reach a local server, and this exercises
      // the real call path for OpenAI too), so enqueue + poll.
      const { id } = await apiPost<{ ok: boolean; id: string }>('/api/admin/transcription/test-connection', {})

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
        message: 'Test timed out — the worker may be offline or still starting.',
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
            <CardTitle>Subtitles & Transcription</CardTitle>
            <CardDescription>
              Auto-generate subtitles for video versions and power Dictate with Whisper
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
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={transcriptionEnabled}
              onChange={(e) => setTranscriptionEnabled(e.target.checked)}
              className="mt-1 h-4 w-4 text-primary focus:ring-primary rounded"
            />
            <div className="flex-1">
              <div className="font-medium text-sm group-hover:text-primary transition-colors">
                Auto-generate subtitles (Whisper)
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                The master switch for Whisper captions. When on, new versions are transcribed by default —
                you can turn auto-generation off per version at upload, and set captions manually (upload an SRT
                or copy them from another version). Subtitles appear as a CC option in the player, and the SRT
                becomes a downloadable video asset once the video is approved.
              </div>
            </div>
          </label>

          {transcriptionEnabled && (
            <>
              <div className="space-y-2">
                <Label>Provider</Label>
                <div className="space-y-3 p-4 bg-muted/50 rounded-md border border-border">
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="radio"
                      name="transcriptionProvider"
                      value="LOCAL"
                      checked={!isOpenai}
                      onChange={(e) => setTranscriptionProvider(e.target.value)}
                      className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm group-hover:text-primary transition-colors">
                        Local server (self-hosted Whisper)
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Any OpenAI-compatible transcription server (e.g. Speaches / faster-whisper-server). Audio
                        never leaves your network. The URL must be reachable from the machine running the{' '}
                        <span className="font-mono">worker</span>, not the web app.
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="radio"
                      name="transcriptionProvider"
                      value="OPENAI"
                      checked={isOpenai}
                      onChange={(e) => setTranscriptionProvider(e.target.value)}
                      className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm group-hover:text-primary transition-colors">
                        OpenAI API
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Audio is sent to OpenAI and billed per minute. No server to run.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {!isOpenai ? (
                <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="transcriptionWhisperUrl">Whisper server URL</Label>
                      <Input
                        id="transcriptionWhisperUrl"
                        type="text"
                        value={transcriptionWhisperUrl}
                        onChange={(e) => setTranscriptionWhisperUrl(e.target.value)}
                        placeholder="http://127.0.0.1:8000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="transcriptionWhisperModel">Model</Label>
                      <Input
                        id="transcriptionWhisperModel"
                        type="text"
                        value={transcriptionWhisperModel}
                        onChange={(e) => setTranscriptionWhisperModel(e.target.value)}
                        placeholder="deepdml/faster-whisper-large-v3-turbo-ct2"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    If the server runs on the same machine as the worker, use http://127.0.0.1:8000.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                  <div className="space-y-2">
                    <Label htmlFor="transcriptionOpenaiApiKey">OpenAI API Key</Label>
                    <PasswordInput
                      id="transcriptionOpenaiApiKey"
                      value={transcriptionOpenaiApiKey}
                      onChange={(e) => setTranscriptionOpenaiApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                    <p className="text-xs text-muted-foreground">Stored encrypted; only decrypted by the worker at call time.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="transcriptionOpenaiModel">Model</Label>
                    <Input
                      id="transcriptionOpenaiModel"
                      type="text"
                      value={transcriptionOpenaiModel}
                      onChange={(e) => setTranscriptionOpenaiModel(e.target.value)}
                      placeholder="whisper-1"
                    />
                    <p className="text-xs text-muted-foreground">
                      Keep <span className="font-mono">whisper-1</span> — it&apos;s the only OpenAI model that returns
                      the word timings needed to build subtitles (the newer gpt-4o-transcribe models don&apos;t).
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="transcriptionLanguage">Language hint</Label>
                  <Input
                    id="transcriptionLanguage"
                    type="text"
                    value={transcriptionLanguage}
                    onChange={(e) => setTranscriptionLanguage(e.target.value)}
                    placeholder="en"
                  />
                  <p className="text-xs text-muted-foreground">Blank = autodetect.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="transcriptionMaxCharsPerLine">Max characters / line</Label>
                  <Input
                    id="transcriptionMaxCharsPerLine"
                    type="number"
                    min={0}
                    max={200}
                    {...numberInput(transcriptionMaxCharsPerLine, setTranscriptionMaxCharsPerLine)}
                    placeholder="42"
                  />
                  <p className="text-xs text-muted-foreground">0 = no wrapping.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="transcriptionMaxLines">Max lines / caption</Label>
                  <Input
                    id="transcriptionMaxLines"
                    type="number"
                    min={1}
                    max={200}
                    {...numberInput(transcriptionMaxLines, setTranscriptionMaxLines)}
                    placeholder="2"
                  />
                  <p className="text-xs text-muted-foreground">Overflow splits into more captions.</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                Caption formatting is applied when subtitles are generated; manual edits are left as typed.
              </p>

              <div className="space-y-2 pt-1">
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
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

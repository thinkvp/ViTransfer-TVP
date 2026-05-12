import type { Readable } from 'stream'

/**
 * Convert a Node.js Readable stream to a Web ReadableStream with proper pull-based
 * backpressure.
 *
 * A push-based approach (using `.on('data', ...)` without pausing) enqueues chunks
 * as fast as the source can produce them. For large files on slow client connections
 * the Web ReadableStream's internal queue grows unboundedly in memory, causing OOM
 * errors or HTTP-layer timeouts that force the client to retry from scratch.
 *
 * This pull-based approach only reads the next chunk from the source when the
 * consumer (browser/network) is ready for more data, keeping memory usage flat
 * regardless of file size or transfer speed.
 *
 * @param stream - A Node.js Readable (e.g. from `fs.createReadStream`).
 * @param hooks  - Optional callbacks for observability / download tracking.
 */
export function createWebReadableStream(
  stream: Readable,
  hooks?: {
    onBytes?: (bytes: number) => void
    onComplete?: () => void
    onError?: (error: Error) => void
    onCancel?: () => void
  },
): ReadableStream {
  let ended = false
  let closed = false

  return new ReadableStream({
    start() {
      // Pause immediately — we only resume inside pull().
      stream.pause()
      stream.once('end', () => { ended = true })
    },

    pull(controller) {
      // Guard: the runtime may call pull() one extra time after the controller
      // was already closed by a previous onEnd/onError callback, which would
      // throw ERR_INVALID_STATE ("Controller is already closed").
      if (closed) return
      if (ended) {
        closed = true
        controller.close()
        return
      }

      return new Promise<void>((resolve) => {
        const onData = (chunk: Buffer | string) => {
          cleanup()
          stream.pause()
          const output = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          if (!closed) {
            hooks?.onBytes?.(output.byteLength)
            controller.enqueue(output)
          }
          resolve()
        }
        const onEnd = () => {
          cleanup()
          ended = true
          if (!closed) {
            closed = true
            hooks?.onComplete?.()
            controller.close()
          }
          resolve()
        }
        const onError = (err: Error) => {
          cleanup()
          if (!closed) {
            closed = true
            hooks?.onError?.(err)
            controller.error(err)
          }
          resolve()
        }
        const cleanup = () => {
          stream.removeListener('data', onData)
          stream.removeListener('end', onEnd)
          stream.removeListener('error', onError)
        }

        stream.once('data', onData)
        stream.once('end', onEnd)
        stream.once('error', onError)
        stream.resume()
      })
    },

    cancel() {
      if (!closed && !ended) {
        hooks?.onCancel?.()
      }
      closed = true
      stream.destroy()
    },
  })
}

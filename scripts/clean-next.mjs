import fs from 'node:fs/promises'

const TARGET = new URL('../.next', import.meta.url)

function isRetryable(err) {
  return (
    err &&
    typeof err === 'object' &&
    ('code' in err) &&
    (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')
  )
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function rmWithRetry(url, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(url, { recursive: true, force: true })
      return
    } catch (err) {
      if (!isRetryable(err) || i === attempts - 1) {
        throw err
      }
      // Exponential-ish backoff: 80ms, 160ms, 320ms...
      await sleep(80 * 2 ** i)
    }
  }
}

try {
  await rmWithRetry(TARGET)
} catch (err) {
  // Keep the message short but actionable for Windows users.
  console.error('[clean-next] Failed to remove .next (it may be locked). Close any running `next`/`node` processes and try again.')
  throw err
}

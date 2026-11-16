import { Worker } from 'node:worker_threads'
import { replayRun } from './ReplayEngine.js'

/**
 * Runs ReplayEngine.replayRun off the main event loop in a persistent worker thread, with an
 * in-process fallback (the exact same function) if the worker is unavailable, disabled
 * (REPLAY_WORKER=0) or fails — so a worker problem can never lose a legitimate run.
 * The worker processes jobs one at a time, which is also what keeps its own seeded-RNG/clock
 * singletons safe.
 */
const JOB_TIMEOUT_MS = 20000
let worker = null
let nextId = 1
const pending = new Map()

function failAll(reason) {
  for (const [, job] of pending) job.reject(new Error(reason))
  pending.clear()
}

function getWorker() {
  if (process.env.REPLAY_WORKER === '0') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./replayWorker.js', import.meta.url))
    worker.on('message', ({ id, result }) => {
      const job = pending.get(id)
      if (!job) return
      pending.delete(id)
      clearTimeout(job.timer)
      job.resolve(result)
    })
    const drop = (reason) => () => { worker = null; failAll(reason) }
    worker.on('error', (err) => { console.error('[replayRunner] worker error', err); drop('worker_error')() })
    worker.on('exit', drop('worker_exit'))
    worker.unref()
  } catch (err) {
    console.error('[replayRunner] could not start worker, using in-process replay', err)
    worker = null
  }
  return worker
}

export async function replayRunAsync(run) {
  const w = getWorker()
  if (!w) return replayRun(run)
  try {
    return await new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')) }, JOB_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      w.postMessage({ id, run })
    })
  } catch (err) {
    console.warn('[replayRunner] worker replay failed, falling back to in-process:', err.message)
    return replayRun(run)
  }
}

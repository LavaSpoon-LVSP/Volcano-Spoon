// Worker-thread entry for ReplayEngine.replayRun. Running the replay here keeps the main Node event
// loop free (a long run replay costs ~300 ms of pure CPU, which used to block every other player's
// requests). The worker has its OWN copies of the seededRandom / simClock singletons, so nothing here
// can interfere with the main thread.
import { parentPort } from 'node:worker_threads'
import { replayRun } from './ReplayEngine.js'

parentPort.on('message', ({ id, run }) => {
  let result
  try {
    result = replayRun(run)
  } catch (error) {
    result = { score: 0, coins: 0, jackpotTokensCollected: 0, framesReplayed: 0, crashed: true, error: error?.message || String(error) }
  }
  parentPort.postMessage({ id, result })
})

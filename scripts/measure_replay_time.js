// Measures how long the server needs to simulate a long run (the synchronous part of replayRun).
// Keeps the spoon alive by refilling health + position so the sim runs the full frame count.
// Run: node Backend/scripts/measure_replay_time.js
import { GameLogic } from '../src/game/GameLogic.js'
import { seedRandom } from '../src/game/seededRandom.js'
import { setSimClock } from '../src/game/simClock.js'

for (const [stage, seconds] of [[1, 60], [3, 180], [8, 180], [8, 600]]) {
  const frames = seconds * 60
  seedRandom(4242 + stage); let now = 0; setSimClock(() => now)
  const g = new GameLogic(); g.reset(); g.setArenaStage(stage, { lavaCoinMultiplier: 1 }); g.setArtifactPerks?.({})
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < frames; i++) {
    if (i % 40 === 0) g.handleInput('launch', { dx: ((i / 40) % 2 ? 40 : -40), dy: -70 })
    g.health = 100; g.gameOver = false
    g.update(1); now += 16.667
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  setSimClock(null); seedRandom(NaN)
  console.log(`stage ${stage}, ${seconds}s run (${frames} frames): ${ms.toFixed(0)} ms  (${(ms / frames).toFixed(3)} ms/frame)`)
}

// Determinism check: the browser reuses ONE long-lived GameLogic across runs (reset() between them),
// while the server replays each run on a FRESH instance. Any state that survives reset() would make
// the 2nd, 3rd, ... run of a session score differently on the server (the "final score doesn't match
// what I earned" symptom). This plays many bot runs the way the browser does and compares each with
// the server replay, across all 8 arena stages, with and without artifact perks, including
// Gravity-Orb steer inputs.
// Run: node Backend/scripts/test_replay_determinism.js [runsPerStage=6] [maxFrames=5000]
import { GameLogic } from '../src/game/GameLogic.js'
import { seedRandom } from '../src/game/seededRandom.js'
import { setSimClock } from '../src/game/simClock.js'
import { replayRun } from '../src/game/ReplayEngine.js'

const RUNS = Number(process.argv[2]) || 6
const MAX_FRAMES = Number(process.argv[3]) || 5000
const MULT = { 1: 1, 2: 1.5, 3: 2.5, 4: 4, 5: 6, 6: 9, 7: 13, 8: 18 }
const PERKS_ALL = { healRegen: true, pickupRadiusBonus: true, comboDurationBonus: true, hazardVisibility: true, comboStabilize: true }
let rs = 20261105; const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 2 ** 32)

const browserGame = new GameLogic() // long-lived, like Game.jsx's localGameRef
let simNow = 0
let total = 0, same = 0
const bad = []
console.log('stage | run | perks | frames | score client/server | coins client/server | tokens | result')
for (let stage = 1; stage <= 8; stage++) {
  for (let k = 0; k < RUNS; k++) {
    const seed = 777 * stage + 31 * k + 5
    const perks = k % 2 ? PERKS_ALL : {}
    const sm = { lavaCoinMultiplier: MULT[stage], rareOrbChance: 0 }
    // ---- play like the browser ----
    seedRandom(seed); simNow = 0; setSimClock(() => simNow)
    browserGame.reset(); browserGame.setArtifactPerks(perks); browserGame.setArenaStage(stage, sm)
    const g = browserGame
    const frames = [], inputs = []
    let nextLaunch = 0
    for (let i = 0; i < MAX_FRAMES; i++) {
      const gravityCtl = g.powerups.isGravityControlActive?.(simNow)
      if (gravityCtl && i % 2 === 0) {
        const x = 60 + rnd() * 480, y = 80 + rnd() * 500
        g.handleInput('steer', { dx: x, dy: y }); inputs.push({ atFrame: i, type: 'steer', dx: x, dy: y })
      } else if (i >= nextLaunch) {
        const lava = g.orbs.orbs.filter((o) => o.active && o.type === 'lava')
        let dx = (rnd() - 0.5) * 120, dy = -(55 + rnd() * 40)
        if (lava.length) { const o = lava.reduce((a, b) => (Math.abs(a.x - g.physics.x) < Math.abs(b.x - g.physics.x) ? a : b)); dx = Math.max(-120, Math.min(120, (o.x - g.physics.x) * 0.7)); dy = -(60 + rnd() * 35) }
        g.handleInput('launch', { dx, dy }); inputs.push({ atFrame: i, type: 'launch', dx, dy })
        nextLaunch = i + 25 + Math.floor(rnd() * 85)
      }
      const dt = Math.min(3, Math.max(0.5, 1 + (rnd() - 0.4) * 0.5 + (rnd() < 0.02 ? 1.2 : 0)))
      g.update(dt); frames.push(dt); simNow += dt * 16.667
      if (g.gameOver) break
    }
    const client = { score: g.score, coins: g.coins, tokens: g.jackpotTokensCollected }
    setSimClock(null); seedRandom(NaN)
    // ---- server replay (fresh instance) ----
    const r = replayRun({ seed, frames, inputs, arenaStage: stage, stageMultipliers: sm, artifactPerks: perks })
    const ok = !r.crashed && r.score === client.score && r.coins === client.coins && r.jackpotTokensCollected === client.tokens
    total += 1; if (ok) same += 1; else bad.push({ stage, k, client, server: r })
    console.log(`${stage}     | ${k}   | ${Object.keys(perks).length ? 'all ' : 'none'}  | ${String(frames.length).padStart(5)}  | ${client.score}/${r.score} | ${client.coins}/${r.coins} | ${client.tokens}/${r.jackpotTokensCollected} | ${ok ? 'identical' : 'MISMATCH'}`)
  }
}
console.log(`\n${same}/${total} runs identical`)
if (bad.length) console.log('MISMATCHES:', JSON.stringify(bad, null, 1))
process.exit(bad.length ? 1 : 0)

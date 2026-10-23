// 20 bot-played runs: real CLIENT GameLogic (Frontend/src/game) vs real SERVER replay (Backend ReplayEngine).
// The bot is NOT a human: it is a scripted player with human-like launch gaps and jittery frame times,
// used to prove client and server simulate identically. It does not replace 20 hand-played runs.
// Run: node Backend/scripts/replay_20_runs.js
import { GameLogic as ClientGame } from '../../Frontend/src/game/GameLogic.js'
import { seedRandom as clientSeed } from '../../Frontend/src/game/seededRandom.js'
import { setSimClock as clientClock } from '../../Frontend/src/game/simClock.js'
import { GameLogic as ServerGame } from '../src/game/GameLogic.js'
import { seedRandom as serverSeed } from '../src/game/seededRandom.js'
import { setSimClock as serverClock } from '../src/game/simClock.js'
import { replayRun } from '../src/game/ReplayEngine.js'

const MULT = { 1: 1, 2: 1.5, 3: 2, 4: 3 }          // default stage multipliers shown on the arena cards
const MAX_FRAMES = 4000
let botState = 99
const bot = () => { botState |= 0; botState = (botState + 0x6d2b79f5) | 0; let t = Math.imul(botState ^ (botState >>> 15), 1 | botState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

function playClient(seed, stage, mult) {
  clientSeed(seed); let now = 0; clientClock(() => now)
  const g = new ClientGame(); g.reset(); g.setArenaStage(stage, { lavaCoinMultiplier: mult }); g.setArtifactPerks?.({})
  const frames = [], inputs = [], hist = []
  let nextLaunch = 0
  for (let i = 0; i < MAX_FRAMES; i++) {
    if (i >= nextLaunch) {                                  // launch toward the nearest Lava Orb, human-like gap 25-110 frames
      const lava = g.orbs.orbs.filter((o) => o.active && o.type === 'lava')
      let dx = (bot() - 0.5) * 120, dy = -(55 + bot() * 40)
      if (lava.length) { const o = lava.reduce((a, b) => (Math.abs(a.x - g.physics.x) < Math.abs(b.x - g.physics.x) ? a : b)); dx = Math.max(-120, Math.min(120, (o.x - g.physics.x) * 0.6)) }
      g.handleInput('launch', { dx, dy }); inputs.push({ atFrame: i, type: 'launch', dx, dy })
      nextLaunch = i + 25 + Math.floor(bot() * 85)
    }
    const dt = Math.min(3, Math.max(0.5, 1 + (bot() - 0.4) * 0.5 + (bot() < 0.02 ? 1.2 : 0)))   // jittery frame time, rare hitch
    g.update(dt); now += dt * 16.667; frames.push(dt)
    hist.push([g.physics.x, g.physics.y, g.physics.vx, g.physics.vy, g.score, g.coins, g.health, g.orbs.orbs.length])
    if (g.gameOver) break
  }
  const res = { score: g.score, coins: g.coins, tokens: g.jackpotTokensCollected }
  clientClock(null); clientSeed(NaN)
  return { frames, inputs, hist, res }
}

function replayServerWithHistory(seed, stage, mult, frames, inputs) {
  serverSeed(seed); let now = 0; serverClock(() => now)
  const g = new ServerGame(); g.reset(); g.setArenaStage(stage, { lavaCoinMultiplier: mult }); g.setArtifactPerks?.({})
  const sorted = [...inputs].sort((a, b) => a.atFrame - b.atFrame); let c = 0; const hist = []
  for (let i = 0; i < frames.length; i++) {
    while (c < sorted.length && sorted[c].atFrame <= i) { g.handleInput(sorted[c].type, { dx: sorted[c].dx, dy: sorted[c].dy }); c++ }
    g.update(frames[i]); now += frames[i] * 16.667
    hist.push([g.physics.x, g.physics.y, g.physics.vx, g.physics.vy, g.score, g.coins, g.health, g.orbs.orbs.length])
    if (g.gameOver) break
  }
  serverClock(null); serverSeed(NaN)
  return hist
}

const NAMES = ['x', 'y', 'vx', 'vy', 'score', 'coins', 'health', 'orbCount']
let confirmed = 0, mismatches = 0, runNo = 0
console.log('Run | Stage | Frames | Score c/s | Raw coins c/s | Mult | Admin changed mid-run | Payout | Result')
for (let stage = 1; stage <= 4; stage++) {
  for (let k = 0; k < 5; k++) {
    runNo++
    const seed = 1000 * stage + 17 * k + 3
    const mult = MULT[stage]
    const adminChange = k % 2 === 1 ? +(mult * 2.5).toFixed(2) : null     // admin changes the live multiplier during the run (snapshot must win)
    const c = playClient(seed, stage, mult)
    const r = replayRun({ seed, frames: c.frames, inputs: c.inputs, arenaStage: stage, stageMultipliers: { lavaCoinMultiplier: mult } })
    const same = !r.crashed && r.score === c.res.score && r.coins === c.res.coins && r.jackpotTokensCollected === c.res.tokens
    let detail = ''
    if (!same) {
      mismatches++
      const sh = replayServerWithHistory(seed, stage, mult, c.frames, c.inputs)
      for (let f = 0; f < c.hist.length; f++) { const d = NAMES.findIndex((_, j) => Math.abs(c.hist[f][j] - (sh[f]?.[j] ?? NaN)) > 1e-9 || !(f in sh)); if (d >= 0) { detail = ` first divergence frame ${f}: ${NAMES[d]} client ${c.hist[f][d]} vs server ${sh[f]?.[d]}`; break } }
    } else confirmed++
    const payout = Math.round(r.coins * mult)                              // = ClientSession: Math.round(rawCoins * run-start snapshot)
    console.log(`${String(runNo).padStart(3)} | ${stage}     | ${String(c.frames.length).padStart(6)} | ${c.res.score}/${r.score} | ${c.res.coins}/${r.coins} | ${mult}x | ${adminChange ? adminChange + 'x (ignored, snapshot ' + mult + 'x)' : 'no'} | ${payout} | ${same ? 'CONFIRMED' : 'MISMATCH' + detail}`)
  }
}
console.log(`\n${confirmed}/20 runs confirmed identical (score, coins, tokens). Mismatches: ${mismatches}`)
process.exit(mismatches ? 1 : 0)

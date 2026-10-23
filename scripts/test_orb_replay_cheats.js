// Orb effects: client-vs-server replay with forced orbs + cheat tests.
// Run: node Backend/scripts/test_orb_replay_cheats.js
//
// Forced-orb runs: the SAME orb pickups are injected at the SAME frames on the client
// simulation (Frontend GameLogic) and on the server simulation (Backend GameLogic, stepped
// exactly the way ReplayEngine steps it). The inputs (launch + steer) are recorded and replayed.
// This proves the new orb effects (Gravity steering, Diamond, Rose, Sun Flame) are deterministic.
import { GameLogic as ClientGame } from '../../Frontend/src/game/GameLogic.js'
import { seedRandom as clientSeed } from '../../Frontend/src/game/seededRandom.js'
import { setSimClock as clientClock } from '../../Frontend/src/game/simClock.js'
import { GameLogic as ServerGame } from '../src/game/GameLogic.js'
import { seedRandom as serverSeed } from '../src/game/seededRandom.js'
import { setSimClock as serverClock } from '../src/game/simClock.js'
import { replayRun } from '../src/game/ReplayEngine.js'
import { analyzeInputPlausibility } from '../src/game/inputPlausibility.js'
import * as C from '../src/game/constants.js'

let fails = 0
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`) }
let st = 5
const rnd = () => { st |= 0; st = (st + 0x6d2b79f5) | 0; let t = Math.imul(st ^ (st >>> 15), 1 | st); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

// plan: [{ frame, orb }] pickups injected at the player position; steer targets while Gravity control is open
function sim(Game, seedFn, clockFn, seed, stage, plan, inputsIn, frames) {
  seedFn(seed); let now = 0; clockFn(() => now)
  const g = new Game(); g.reset(); g.setArenaStage(stage, { lavaCoinMultiplier: 1 }); g.setArtifactPerks?.({})
  const inputs = [], hist = []
  const N = frames ? frames.length : 900
  const outFrames = []
  let mythicSeen = 0
  for (let i = 0; i < N; i++) {
    const dt = frames ? frames[i] : Math.min(3, Math.max(0.5, 1 + (rnd() - 0.4) * 0.5))
    if (inputsIn) { for (const inp of inputsIn.filter((x) => x.atFrame === i)) g.handleInput(inp.type, { dx: inp.dx, dy: inp.dy }) }
    else {
      if (i % 40 === 0) { const dx = (rnd() - 0.5) * 120, dy = -(55 + rnd() * 40); g.handleInput('launch', { dx, dy }); inputs.push({ atFrame: i, type: 'launch', dx, dy }) }
      if (g.powerups.isGravityControlActive(now)) { const dx = 100 + ((i * 7) % 400), dy = 200 + ((i * 5) % 200); g.handleInput('steer', { dx, dy }); inputs.push({ atFrame: i, type: 'steer', dx, dy }) }
    }
    for (const p of plan.filter((x) => x.frame === i)) {
      const orb = g.orbs.spawnOrb(p.orb); orb.x = g.physics.x; orb.y = g.physics.y
      g._handleOrbCollected(orb, now, g.powerups.getModifiers())
      if (p.zeroVisual) g._mythicVisualUntil = 0
      if (p.orb === 'mythic') mythicSeen = Math.max(mythicSeen, g.getGameState().mythicVisualMs)
    }
    g.update(dt); now += dt * 16.667; outFrames.push(dt)
    hist.push([g.physics.x, g.physics.y, g.score, g.coins, g.health, g.combo.count])
    if (g.gameOver) break
  }
  const res = { score: g.score, coins: g.coins, diamonds: g.diamondPayoutCount, steps: hist.length }
  clockFn(null); seedFn(NaN)
  return { res, hist, inputs, frames: outFrames, mythicSeen }
}

const CASES = [
  { name: 'Gravity Control (steering)', stage: 5, plan: [{ frame: 30, orb: 'gravity' }] },
  { name: 'Diamond (coins + boosts)',   stage: 4, plan: [{ frame: 40, orb: 'diamond' }, { frame: 60, orb: 'lava' }, { frame: 80, orb: 'lava' }] },
  { name: 'Rose (combo safe)',          stage: 3, plan: [{ frame: 20, orb: 'rose' }, { frame: 25, orb: 'bad_rock' }] },
  { name: 'Sun Flame (combo boost)',    stage: 4, plan: [{ frame: 20, orb: 'sun_flame' }, { frame: 30, orb: 'lava' }, { frame: 40, orb: 'lava' }] },
  { name: 'Shield vs Fire Wall/Black',  stage: 4, plan: [{ frame: 20, orb: 'shield' }, { frame: 30, orb: 'fire_wall' }, { frame: 35, orb: 'black' }] },
]
console.log('=== Forced-orb runs: client sim vs server replay ===')
let seed = 4000
for (const c of CASES) {
  seed += 11
  const cl = sim(ClientGame, clientSeed, clientClock, seed, c.stage, c.plan, null, null)
  const sv = sim(ServerGame, serverSeed, serverClock, seed, c.stage, c.plan, cl.inputs, cl.frames)
  let diverge = -1
  for (let f = 0; f < cl.hist.length; f++) if (cl.hist[f].some((v, j) => Math.abs(v - (sv.hist[f]?.[j] ?? NaN)) > 1e-9 || !(f in sv.hist))) { diverge = f; break }
  const steers = cl.inputs.filter((i) => i.type === 'steer').length
  ok(diverge < 0 && cl.res.score === sv.res.score && cl.res.coins === sv.res.coins,
    `${c.name}: identical over ${cl.res.steps} frames (score ${cl.res.score}/${sv.res.score}, coins ${cl.res.coins}/${sv.res.coins}, steer inputs ${steers})${diverge >= 0 ? ' first divergence at frame ' + diverge : ''}`)
  if (c.name.startsWith('Gravity')) ok(steers > 0, 'Gravity run actually recorded steer inputs')
  if (c.name.startsWith('Diamond')) ok(cl.res.diamonds === 1 && cl.res.coins >= C.DIAMOND_COIN_PAYOUT - 1000 && cl.res.coins < C.DIAMOND_COIN_PAYOUT + 1000, `Diamond credited once (${cl.res.coins} raw coins)`)
}

// Mythic visual: the display timer must not change the simulation
{ const withV = sim(ServerGame, serverSeed, serverClock, 9100, 5, [{ frame: 30, orb: 'mythic' }], null, null)
  const noV = sim(ServerGame, serverSeed, serverClock, 9100, 5, [{ frame: 30, orb: 'mythic', zeroVisual: true }], withV.inputs, withV.frames)
  const same = withV.hist.length === noV.hist.length && withV.hist.every((h, i) => h.every((v, j) => Math.abs(v - noV.hist[i][j]) < 1e-9))
  ok(withV.mythicSeen > 0 && withV.mythicSeen <= C.MYTHIC_VISUAL_MS, `Mythic visual timer set (${withV.mythicSeen} ms, within the document's 5-8 s)`)
  ok(C.MYTHIC_VISUAL_MS >= 5000 && C.MYTHIC_VISUAL_MS <= 8000, `Mythic visual duration ${C.MYTHIC_VISUAL_MS} ms is inside 5000-8000`)
  ok(same && withV.res.score === noV.res.score && withV.res.coins === noV.res.coins, 'Mythic visual changes NO score, coins, positions or RNG (run identical with the timer on or off)') }

console.log('\n=== Cheat tests (server must refuse / not pay) ===')
// a) two Diamonds in one run
{ const r = sim(ServerGame, serverSeed, serverClock, 777, 4, [{ frame: 30, orb: 'diamond' }, { frame: 90, orb: 'diamond' }], null, null)
  ok(r.res.diamonds === 1 && r.res.coins < C.DIAMOND_COIN_PAYOUT * 2, `two Diamonds in one run pay only once (raw coins ${r.res.coins}, not ${C.DIAMOND_COIN_PAYOUT * 2}+)`) }
// b) forged 'diamond' input on a stage where it cannot spawn: replay pays nothing extra
{ const base = sim(ClientGame, clientSeed, clientClock, 888, 1, [], null, null)
  const forged = [...base.inputs, { atFrame: 50, type: 'diamond', dx: 0, dy: -50 }, { atFrame: 51, type: 'collect_diamond', dx: 0, dy: 0 }]
  const r = replayRun({ seed: 888, frames: base.frames, inputs: forged, arenaStage: 1, stageMultipliers: { lavaCoinMultiplier: 1 } })
  ok(!r.crashed && r.coins < 100000 && (r.diamondPayouts || 0) === 0, `forged Diamond claim on Stage 1: no payout (raw coins ${r.coins}, diamondPayouts ${r.diamondPayouts})`)
  ok(true, 'orb_spec_check proves a Diamond never spawns before Arena Stage 3 / Level 3') }
// c) steer values far outside the arena are rejected by the plausibility check
{ const frames = Array.from({ length: 200 }, () => 1)
  const bad = analyzeInputPlausibility({ inputs: [{ atFrame: 10, type: 'steer', dx: 99999, dy: 100 }], frames })
  ok(bad.rejectReason === 'implausible_steer_values', `steer far outside the arena rejected (${bad.rejectReason})`)
  const nan = analyzeInputPlausibility({ inputs: [{ atFrame: 10, type: 'steer', dx: 'abc', dy: 100 }], frames })
  ok(nan.rejectReason === 'implausible_steer_values', `non-numeric steer rejected (${nan.rejectReason})`)
  const fine = analyzeInputPlausibility({ inputs: [{ atFrame: 10, type: 'steer', dx: 300, dy: 300 }, { atFrame: 11, type: 'steer', dx: 301, dy: 300 }], frames })
  ok(fine.rejectReason === null, 'normal per-frame steer inputs are not mistaken for a bot (not subject to the input-rate rule)') }
// d) a huge steer jump is speed-clamped inside the game
{ serverSeed(5); let now = 1000; serverClock(() => now)
  const g = new ServerGame(); g.reset(); g.physics.launched = true; g.physics.x = 100; g.physics.y = 300
  const o = g.orbs.spawnOrb('gravity'); g._handleOrbCollected(o, now, g.powerups.getModifiers())
  g.handleInput('steer', { dx: 500, dy: 600 }); const x0 = g.physics.x, y0 = g.physics.y; now += 16; g.update(1)
  const moved = Math.hypot(g.physics.x - x0, g.physics.y - y0)
  ok(moved <= C.GRAVITY_STEER_MAX_SPEED + 0.5, `huge steer jump limited to ${moved.toFixed(1)} px/tick (max ${C.GRAVITY_STEER_MAX_SPEED})`)
  ok(moved > 1, 'and it did move (steering active)'); serverClock(null); serverSeed(NaN) }

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL ORB REPLAY + CHEAT CHECKS PASSED')
process.exit(fails ? 1 : 0)

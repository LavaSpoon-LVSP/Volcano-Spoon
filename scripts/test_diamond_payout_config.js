// Diamond Orb payout is admin-configurable and does not change the simulation.
// No database needed. Run (from Backend/):  node scripts/test_diamond_payout_config.js
import { GameLogic } from '../src/game/GameLogic.js'
import { seedRandom } from '../src/game/seededRandom.js'
import { setSimClock } from '../src/game/simClock.js'
import { replayRun } from '../src/game/ReplayEngine.js'
import * as C from '../src/game/constants.js'

let fails = 0
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`) }

function run(payout, frames = 200) {
  seedRandom(4242); let now = 0; setSimClock(() => now)
  const g = new GameLogic(); g.reset(); g.setArenaStage(4, { lavaCoinMultiplier: 1 }); g.setArtifactPerks({})
  if (payout !== undefined) g.setDiamondCoinPayout(payout)
  const hist = []
  for (let i = 0; i < frames; i++) {
    if (i === 10) g.handleInput('launch', { dx: 40, dy: -70 })
    if (i === 40) { const orb = g.orbs.spawnOrb('diamond'); orb.x = g.physics.x; orb.y = g.physics.y; g._handleOrbCollected(orb, now, g.powerups.getModifiers()) }
    g.update(1); now += 16.667
    hist.push([g.physics.x, g.physics.y, g.score])
    if (g.gameOver) break
  }
  const out = { coins: g.coins, diamonds: g.diamondPayoutCount, hist }
  setSimClock(null); seedRandom(NaN)
  return out
}

const def = run(undefined)
const custom = run(12345)
const off = run(0)
ok(def.diamonds === 1 && def.coins >= C.DIAMOND_COIN_PAYOUT, `default payout unchanged (${def.coins} raw coins, constant ${C.DIAMOND_COIN_PAYOUT})`)
ok(custom.diamonds === 1 && custom.coins - (def.coins - C.DIAMOND_COIN_PAYOUT) === 12345, `custom payout 12345 is credited exactly (${custom.coins} raw coins)`)
ok(off.diamonds === 1 && off.coins === def.coins - C.DIAMOND_COIN_PAYOUT, `payout 0 (disabled): orb still counted/boosts, pays no coins (${off.coins})`)
const same = def.hist.length === custom.hist.length && def.hist.every((h, i) => h.every((v, j) => v === custom.hist[i][j]) && off.hist[i].every((v, j) => v === h[j]))
ok(same, 'positions and score identical for every payout value (simulation/RNG not affected)')
{ const g = new GameLogic(); g.setDiamondCoinPayout(-5); ok(g.diamondCoinPayout === C.DIAMOND_COIN_PAYOUT, 'invalid (negative) payout falls back to the constant')
  g.setDiamondCoinPayout('abc'); ok(g.diamondCoinPayout === C.DIAMOND_COIN_PAYOUT, 'invalid (non-numeric) payout falls back to the constant') }
{ const r = replayRun({ seed: 1, frames: [1, 1, 1], inputs: [], diamondCoinPayout: 5 }); ok(!r.crashed, 'replayRun accepts diamondCoinPayout') }

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL DIAMOND PAYOUT CONFIG CHECKS PASSED')
process.exit(fails ? 1 : 0)

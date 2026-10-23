// Orb specification check (Orbs document -> code), run with: node Backend/scripts/orb_spec_check.js
// "Level" in the Orbs document is enforced twice in code: the in-run Level (LevelSystem unlocks)
// AND the Arena Stage gate (constants *_MIN_ARENA_STAGE). An orb can spawn only when BOTH are met.
import { OrbSystem } from '../src/game/OrbSystem.js'
import LevelSystem from '../src/game/LevelSystem.js'
import { ARENA_STAGE_CONFIGS } from '../src/game/arenaStages.js'
import { seedRandom } from '../src/game/seededRandom.js'
import * as C from '../src/game/constants.js'

// id, doc name, doc "Level" gate, rarity (from the Orbs document)
const SPEC = [
  ['lava', 'Lava', 1, 'common'], ['turbo', 'Turbo', 1, 'common'], ['shield', 'Shield', 1, 'common'],
  ['bad_rock', 'Bad Rock', 1, 'common'], ['fire_wall', 'Fire Wall', 1, 'common'],
  ['combo', 'Combo', 2, 'common'], ['rose', 'Rose', 2, 'uncommon'],
  ['magnet', 'Magnet', 3, 'uncommon'], ['black', 'Black', 3, 'uncommon'], ['diamond', 'Diamond', 3, 'ultra rare'],
  ['freeze', 'Freeze', 4, 'uncommon'], ['chaos', 'Chaos', 4, 'rare'], ['sun_flame', 'Sun Flame', 4, 'rare'],
  ['electric', 'Electric Shock', 4, 'uncommon'],
  ['gravity', 'Gravity Control', 5, 'uncommon'], ['mythic', 'Mythic Event', 5, 'extremely rare'], ['jackpot', 'Jackpot', 5, 'extremely rare'],
]
const CONST_GATE = {
  turbo: C.TURBO_MIN_ARENA_STAGE, shield: C.SHIELD_MIN_ARENA_STAGE, bad_rock: C.BAD_ROCK_MIN_ARENA_STAGE,
  fire_wall: C.FIRE_WALL_MIN_ARENA_STAGE, combo: C.COMBO_MIN_ARENA_STAGE, rose: C.ROSE_MIN_ARENA_STAGE,
  magnet: C.MAGNET_MIN_ARENA_STAGE, black: C.BLACK_MIN_ARENA_STAGE, diamond: C.DIAMOND_MIN_ARENA_STAGE,
  freeze: C.FREEZE_MIN_ARENA_STAGE, chaos: C.CHAOS_MIN_ARENA_STAGE, sun_flame: C.SUN_FLAME_MIN_ARENA_STAGE,
  electric: C.ELECTRIC_MIN_ARENA_STAGE, gravity: C.GRAVITY_MIN_ARENA_STAGE, mythic: C.MYTHIC_MIN_ARENA_STAGE,
  jackpot: C.JACKPOT_MIN_ARENA_STAGE,
}
let fails = 0
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? '[PASS]' : '[FAIL]'} ${msg}`) }
const DRAWS = 3000
const RARITY_DRAWS = 20000

// 1. constants gate == document level
console.log('--- 1. Arena Stage gate constants vs Orbs document ---')
for (const [id, name, lvl] of SPEC) {
  if (id === 'lava') continue
  check(CONST_GATE[id] === lvl, `${name}: document level ${lvl}, code Arena Stage gate ${CONST_GATE[id]}`)
}

// 2. LevelSystem (in-run level) unlock == document level
console.log('\n--- 2. In-run Level unlocks (LevelSystem) vs Orbs document ---')
const ls0 = new LevelSystem()
const firstLevel = (id) => ls0.levels.find((l) => l.unlocks.includes(id))?.level
for (const [id, name, lvl] of SPEC) check(firstLevel(id) === lvl, `${name}: document level ${lvl}, first in-run level that unlocks it ${firstLevel(id)}`)
check(!ls0.levels.some((l) => l.unlocks.includes('health')), 'Legacy Health orb is not unlocked at any in-run level (cannot spawn)')

// 3. Arena card roster == document
console.log('\n--- 3. Arena stage card orb lists vs Orbs document ---')
for (let s = 1; s <= 8; s++) {
  const expect = SPEC.filter(([id, , lvl]) => lvl <= s && !['lava', 'bad_rock', 'fire_wall'].includes(id)).map(([id]) => id).sort()
  const got = [...ARENA_STAGE_CONFIGS[s - 1].availablePowerups].sort()
  check(JSON.stringify(expect) === JSON.stringify(got), `Stage ${s} card lists ${got.length} orbs: ${got.join(', ')}`)
}

// 4. Real spawn simulation for every (arena stage, in-run level) cell
console.log(`\n--- 4. Spawn simulation: ${DRAWS} real OrbSystem draws per (Arena Stage, in-run Level) ---`)
seedRandom(12345)
const observed = {}   // id -> { minStage, minLevel }
let early = 0
const counts88 = {}
for (let S = 1; S <= 8; S++) {
  for (let L = 1; L <= 8; L++) {
    const ls = new LevelSystem(); ls.update(ls.levels[L - 1].minScore)
    const os = new OrbSystem(); os.setArenaStage(S); os.setSpawnProfile(ls.getSpawnProfile())
    const seen = new Set()
    for (let i = 0; i < DRAWS; i++) {
      os.orbs.length = 0
      const orb = os.trySpawn((i + 1) * 100000)
      if (!orb) continue
      seen.add(orb.type)
      if (S === 8 && L === 8) counts88[orb.type] = (counts88[orb.type] || 0) + 1
    }
    for (const t of seen) {
      const spec = SPEC.find(([id]) => id === t)
      if (!spec) { early++; console.log(`[FAIL] undocumented orb "${t}" spawned at Stage ${S}, Level ${L}`); continue }
      if (S < (CONST_GATE[t] ?? 1) || L < spec[2]) { early++; console.log(`[FAIL] ${spec[1]} spawned before its gate at Stage ${S}, Level ${L}`) }
      const o = (observed[t] ??= { minStage: 99, minLevel: 99 })
      if (L === 8) o.minStage = Math.min(o.minStage, S)
      if (S === 8) o.minLevel = Math.min(o.minLevel, L)
    }
  }
}
check(early === 0, 'No orb ever spawned before its document gate (all 64 stage/level cells)')
console.log('\nOrb              | Doc level | Code gate (Stage) | First Stage seen (Lvl 8) | First Level seen (Stage 8) | Rarity')
for (const [id, name, lvl, rar] of SPEC) {
  const o = observed[id] || { minStage: '-', minLevel: '-' }
  const okRow = o.minStage === (id === 'lava' ? 1 : CONST_GATE[id]) && o.minLevel === lvl
  if (!okRow) fails++
  console.log(`${name.padEnd(16)} | ${String(lvl).padEnd(9)} | ${String(CONST_GATE[id] ?? 1).padEnd(17)} | ${String(o.minStage).padEnd(24)} | ${String(o.minLevel).padEnd(26)} | ${rar}  ${okRow ? '[PASS]' : '[FAIL]'}`)
}
console.log('\n--- 5. Rarity: real spawn share per (Arena Stage, Level) cell, ' + RARITY_DRAWS + ' seeded draws each ---')
// Order required by the Orbs document labels: common > uncommon > rare > top tier (ultra / extremely rare).
// Lava is the main collectible and is excluded from the comparison.
const rank = { common: 0, uncommon: 1, rare: 2, 'ultra rare': 3, 'extremely rare': 3 }
const rarityOf = Object.fromEntries(SPEC.map(([id, name, , rar]) => [id, { name, rar }]))
seedRandom(777)
const inversions = []
let topTierMax = 0
const stage8 = {}
for (let S = 1; S <= 8; S++) {
  for (let L = 1; L <= 8; L++) {
    const ls = new LevelSystem(); ls.update(ls.levels[L - 1].minScore)
    const os = new OrbSystem(); os.setArenaStage(S); os.setSpawnProfile(ls.getSpawnProfile())
    const n = {}
    for (let i = 0; i < RARITY_DRAWS; i++) { os.orbs.length = 0; const orb = os.trySpawn((i + 1) * 100000); if (orb) n[orb.type] = (n[orb.type] || 0) + 1 }
    if (S === 8) stage8[L] = n
    const ids = Object.keys(n).filter((id) => id !== 'lava' && rarityOf[id])
    for (const x of ids) for (const y of ids) {
      if (rank[rarityOf[x].rar] < rank[rarityOf[y].rar] && n[x] <= n[y]) {
        inversions.push(`Stage ${S} Level ${L}: ${rarityOf[x].name} (${rarityOf[x].rar}, ${(100 * n[x] / RARITY_DRAWS).toFixed(2)}%) is not more frequent than ${rarityOf[y].name} (${rarityOf[y].rar}, ${(100 * n[y] / RARITY_DRAWS).toFixed(2)}%)`)
      }
    }
    for (const id of ['diamond', 'mythic', 'jackpot']) if (n[id]) topTierMax = Math.max(topTierMax, 100 * n[id] / RARITY_DRAWS)
  }
}
console.log('Share of all spawns at Arena Stage 8, per in-run Level (%):')
for (let L = 1; L <= 8; L++) {
  const n = stage8[L]; const tot = Object.values(n).reduce((a, b) => a + b, 0)
  console.log(`  L${L}: ` + SPEC.filter(([id]) => n[id]).map(([id, name]) => `${name} ${(100 * n[id] / tot).toFixed(1)}`).join(' | '))
}
console.log(`Top-tier orbs (Diamond / Mythic / Jackpot) highest share in any cell: ${topTierMax.toFixed(2)}%`)
inversions.slice(0, 12).forEach((i) => console.log('   - ' + i))
check(inversions.length === 0, `spawn frequency follows the Orbs document rarity labels in all 64 cells (${inversions.length} inversion(s))`)
// Shares are relative: when Arena-Stage gating removes other orbs, a top-tier orb's share rises slightly (about 0.5% -> up to about 0.7%).
check(topTierMax <= 1.0, 'top-tier orbs (ultra / extremely rare) stay at or below 1% of spawns in every cell')
check(!counts88.health, 'Legacy Health orb never spawned')
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL ORB SPEC CHECKS PASSED')
process.exit(fails ? 1 : 0)

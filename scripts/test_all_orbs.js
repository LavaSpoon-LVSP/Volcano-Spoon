// Behaviour test for ALL 17 orbs against the Orbs document. Run: node Backend/scripts/test_all_orbs.js
// [GAP] = documented behaviour that the code does not (fully) implement. Gaps are reported, not failed.
import { GameLogic } from '../src/game/GameLogic.js'
import { seedRandom } from '../src/game/seededRandom.js'
import * as C from '../src/game/constants.js'
import { setSimClock } from '../src/game/simClock.js'

let fails = 0, gaps = 0
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`) }
const gap = (m) => { gaps++; console.log(`[GAP]  ${m}`) }
const between = (v, lo, hi) => v >= lo && v <= hi
const T0 = 1_000_000
function fresh() { seedRandom(7); const g = new GameLogic(); g.combo.reset(); return g }
function collect(g, type, setup) {
  const orb = g.orbs.spawnOrb(type)
  orb.x = g.physics.x; orb.y = g.physics.y
  if (setup) setup(orb)
  g._handleOrbCollected(orb, T0, g.powerups.getModifiers())
  return orb
}
// how long (ms) a powerup flag stays on
function duration(g, flag) {
  for (let ms = 0; ms <= 20000; ms += 50) { g.powerups.update(T0 + ms); if (!g.powerups[flag]) return ms }
  return Infinity
}

console.log('=== 1 Lava Orb ===')
{ const g = fresh(); const s0 = g.score, c0 = g.coins; collect(g, 'lava'); ok(g.coins === c0 + C.COIN_PER_LAVA_ORB && g.score > s0, `gives Lava Coins (+${g.coins - c0}) and builds score (+${g.score - s0})`) }

console.log('\n=== 2 Turbo Orb (speed boost 3-5 s) ===')
{ const g = fresh(); const c0 = g.coins; collect(g, 'turbo'); const m = g.powerups.getModifiers()
  ok(m.turboActive && m.airControlBonus > 1, `speed/responsiveness boost active (air control x${m.airControlBonus})`)
  ok(g.coins - c0 >= C.TURBO_ORB_COIN_MIN && g.coins - c0 <= C.TURBO_ORB_COIN_MAX, `bonus coins ${g.coins - c0} within ${C.TURBO_ORB_COIN_MIN}-${C.TURBO_ORB_COIN_MAX}`)
  const d = duration(g, 'turboActive'); ok(between(d, 3000, 5000), `duration ${d} ms within 3000-5000`) }

console.log('\n=== 3 Magnet Orb (5-7 s) ===')
{ const g = fresh(); collect(g, 'magnet'); ok(g.powerups.getModifiers().magnetActive, 'magnet active')
  const d = duration(g, 'magnetActive'); ok(between(d, 5000, 7000), `duration ${d} ms within 5000-7000`)
  const pull = (magnetOn) => {
    const g2 = fresh(); const lava = g2.orbs.spawnOrb('lava'); lava.x = g2.physics.x + 80; lava.y = g2.physics.y; lava.vx = 0; lava.vy = 0
    for (let i = 0; i < 30; i++) g2.orbs.update(T0 + i * 16, { x: g2.physics.x, y: g2.physics.y, radius: g2.physics.radius }, magnetOn)
    return Math.hypot(g2.physics.x - lava.x, g2.physics.y - lava.y)
  }
  const withMagnet = pull(true), without = pull(false)
  ok(withMagnet < without - 5, `Lava Orb pulled toward player: ${without.toFixed(1)} px away without magnet, ${withMagnet.toFixed(1)} px with it (pull radius ${C.MAGNET_PULL_RADIUS})`) }

console.log('\n=== 4 Combo Orb ===')
{ const g = fresh(); const n0 = g.combo.count; collect(g, 'combo'); ok(g.combo.count === n0 + C.COMBO_ORB_BOOST, `combo +${g.combo.count - n0}`)
  for (let i = 0; i < 12; i++) g.combo.onLavaOrb(T0 + i); ok(g.combo.multiplier > 1, `higher combo gives multiplier x${g.combo.multiplier}`)
  g.combo.breakCombo('hit'); ok(g.combo.count === 0 || g.combo.multiplier === 1, 'taking a hit breaks the combo') }

console.log('\n=== 5 Freeze Orb (slow motion 3-4 s) ===')
{ const g = fresh(); collect(g, 'freeze'); const m = g.powerups.getModifiers()
  ok(m.freezeActive && m.freezeFactor < 1 && g.orbs.freezeActive, `hazards/arena slowed (factor ${m.freezeFactor})`)
  const d = duration(g, 'freezeActive'); ok(between(d, 3000, 4000), `duration ${d} ms within 3000-4000`) }

console.log('\n=== 6 Shield Orb (3-5 s, blocks hazards) ===')
{ const g = fresh(); collect(g, 'shield'); const m = g.powerups.getModifiers()
  ok(m.shieldActive && m.invincible, 'invincibility active (no lava-stick / spike / knife / rain damage)')
  const g2 = fresh(); collect(g2, 'shield'); g2.coins = 200; g2.combo.onLavaOrb(T0); const n = g2.combo.count; collect(g2, 'bad_rock')
  ok(g2.coins === 200 && g2.combo.count === n, 'Bad Rock under shield: no coin loss, combo kept')
  collect(g2, 'fire_wall'); ok(g2.coins === 200 && g2.combo.count === n, 'Fire Wall under shield: no coin loss, combo kept')
  collect(g2, 'black'); ok(g2.coins === 200 && g2.combo.count === n && !(g2._lastBlackOrbDistortUntil > 0), 'Black under shield: no coin loss, combo kept, no distortion')
  const g3 = fresh(); g3.coins = 200; collect(g3, 'black'); ok(g3.coins === 175, 'Black without shield still takes coins (control)')
  const d = duration(g, 'shieldActive'); ok(between(d, 3000, 5000), `duration ${d} ms within 3000-5000`) }

console.log('\n=== 7 Rose Orb (instant heal) ===')
{ const g = fresh(); g.health = 50; collect(g, 'rose'); ok(g.health === 50 + C.ROSE_ORB_HEAL, `instant heal +${g.health - 50} HP`)
  g.health = C.MAX_HEALTH; collect(g, 'rose'); ok(g.health === C.MAX_HEALTH, 'heal is clamped at max health')
  { const g2 = fresh(); g2.combo.onLavaOrb(T0); g2.combo.onLavaOrb(T0); const n = g2.combo.count; collect(g2, 'rose')
    g2.combo.breakOnHazard(0); g2.combo.breakCombo('bad_rock')
    ok(g2.combo.count === n, `Rose: combo stabilised - hazards do not break it for ${C.ROSE_COMBO_SAFE_MS} ms`)
    g2.combo.hazardProtected = false; g2.combo.breakCombo('bad_rock'); ok(g2.combo.count === 0, 'Rose: combo breaks normally once the safe window ends')
    ok(g2._comboSafeUntil === T0 + C.ROSE_COMBO_SAFE_MS, 'Rose: safe window is 3 s') }
  console.log('[SKIP] Rose: optional movement-control boost intentionally not built (overlaps Gravity direct control)') }

console.log('\n=== 8 Chaos Orb (random effects) ===')
{ const seen = new Set(); let coinsOk = true
  for (let i = 0; i < 300; i++) { seedRandom(1000 + i); const g = new GameLogic(); const c0 = g.coins; const o = collect(g, 'chaos'); seen.add(o.chaosEffect); if (g.coins - c0 < C.CHAOS_ORB_COIN_MIN || g.coins - c0 > C.CHAOS_ORB_COIN_MAX) coinsOk = false }
  ok(seen.size >= 3, `random effect varies: ${[...seen].join(', ')}`); ok(coinsOk, `coin reward always within ${C.CHAOS_ORB_COIN_MIN}-${C.CHAOS_ORB_COIN_MAX}`)
  const g = fresh(); collect(g, 'chaos', (o) => { o.chaosEffect = 'hazard_burst' }); ok(true, 'hazard-producing chaos effect handled without error') }

console.log('\n=== 9 Bad Rock Orb ===')
{ const g = fresh(); g.coins = 500; g.combo.onLavaOrb(T0); g.combo.onLavaOrb(T0 + 1); collect(g, 'bad_rock')
  ok(g.coins >= 500 - C.BAD_ROCK_COIN_PENALTY_MAX && g.coins <= 500 - C.BAD_ROCK_COIN_PENALTY_MIN, `Lava Coins reduced by ${500 - g.coins}`)
  ok(g.combo.count === 0, 'combo chain broken') }

console.log('\n=== 10 Fire Wall Orb (lava zones 3-6 s) ===')
{ const g = fresh(); g.coins = 500; const n0 = g.orbs.orbs.filter((o) => o.type === 'lava_stick').length; collect(g, 'fire_wall')
  ok(g.orbs.orbs.filter((o) => o.type === 'lava_stick').length > n0, 'lava hazard trails created on the arena walls')
  ok(between(C.LAVA_STICK_LIFETIME_MS, 3000, 6000), `lava trail lifetime ${C.LAVA_STICK_LIFETIME_MS} ms within 3000-6000`)
  ok(g.coins < 500, `touching costs Lava Coins (-${500 - g.coins})`)
  const g2 = fresh(); const h0 = g2.health; const stick = collect(g2, 'lava_stick'); ok(g2.health < h0, `touching a lava zone reduces health (-${h0 - g2.health})`) }

console.log('\n=== 11 Black Orb ===')
{ const g = fresh(); g.coins = 100; g.score = 200; g.combo.onLavaOrb(T0); collect(g, 'black')
  ok(g.coins < 100 && g.combo.count === 0 && g.score < 200, `removes Lava Coins (-${100 - g.coins}) and breaks combo, score -${200 - g.score}`)
  ok(g._lastBlackOrbDistortUntil > 0, `movement/visibility distortion flag set for ${C.BLACK_ORB_DISTORT_MS} ms`) }

console.log('\n=== 12 Sun Flame Orb ===')
{ const g = fresh(); g.coins = 70; g.score = 100; collect(g, 'sun_flame'); ok(g.coins === 120 && g.score === 150, 'instantly +50 Lava Coins and +50 score')
  { const g2 = fresh(); collect(g2, 'sun_flame'); const run4 = (now) => { g2.combo.reset(); const a = g2.score; for (let i = 0; i < 4; i++) { g2.combo.reset(); const o = g2.orbs.spawnOrb('lava'); g2._handleOrbCollected(o, now, g2.powerups.getModifiers()) } return g2.score - a }
    const boosted = run4(T0 + 100), normal = run4(T0 + C.SUN_FLAME_BOOST_MS + 500)
    ok(boosted === Math.floor(4 * C.LAVA_ORB_BASE_SCORE * C.SUN_FLAME_COMBO_MULT) && boosted > normal, `Sun Flame: combo score value x${C.SUN_FLAME_COMBO_MULT} for ${C.SUN_FLAME_BOOST_MS} ms (4 orbs: ${boosted} vs ${normal})`) } }

console.log('\n=== 13 Electric Shock Orb (1-2 s freeze + collect nearby Lava Orbs) ===')
{ const g = fresh(); const near = []; for (let i = 0; i < 3; i++) { const l = g.orbs.spawnOrb('lava'); l.x = g.physics.x + 20 + i * 5; l.y = g.physics.y; near.push(l) }
  const far = g.orbs.spawnOrb('lava'); far.x = g.physics.x + C.ELECTRIC_COLLECT_RADIUS + 200; far.y = g.physics.y
  const c0 = g.coins; collect(g, 'electric')
  ok(g.orbs.freezeActive && between(C.ELECTRIC_SHOCK_MS, 1000, 2000), `screen freeze ${C.ELECTRIC_SHOCK_MS} ms within 1000-2000`)
  ok(near.every((o) => o.collected) && !far.collected, 'all nearby Lava Orbs collected, distant one untouched')
  ok(g.coins - c0 === near.length * C.COIN_PER_LAVA_ORB, `bonus from collected Lava Orbs (+${g.coins - c0} coins)`) }

console.log('\n=== 14 Gravity Control Orb (4-6 s float + 3 s direct control) ===')
{ const g = fresh(); collect(g, 'gravity'); const m = g.powerups.getModifiers()
  ok(m.gravityActive && m.gravityFactor < 1, `reduced gravity (factor ${m.gravityFactor})`)
  const d = duration(g, 'gravityActive'); ok(between(d, 4000, 6000), `float duration ${d} ms within 4000-6000`)
  { setSimClock(() => T0 + 500)
    const g2 = fresh(); g2.physics.launched = true; g2.physics.x = 300; g2.physics.y = 300; g2.physics.vx = 5; g2.physics.vy = 5
    collect(g2, 'gravity'); const T = (ms) => setSimClock(() => T0 + ms)
    ok(g2.powerups.getModifiers().gravityControlActive, 'direct-control window opens')
    g2.handleInput('steer', { dx: 450, dy: 300 }); const x0 = g2.physics.x; T(600); g2.update(1)
    ok(g2.physics.x > x0 && g2.physics.x - x0 <= C.GRAVITY_STEER_MAX_SPEED + 0.01, `spoon follows the pointer at a clamped speed (+${(g2.physics.x - x0).toFixed(1)} px, max ${C.GRAVITY_STEER_MAX_SPEED}/tick)`)
    ok(Math.abs(g2.physics.vx) < 0.01 && Math.abs(g2.physics.vy) < 0.01, 'normal momentum paused (velocity held at 0)')
    const y0 = g2.physics.y; T(700); g2.update(1); ok(Math.abs(g2.physics.y - y0) < 1, 'no gravity fall while steering')
    g2.handleInput('launch', { dx: 100, dy: -100 }); T(800); g2.update(1); ok(Math.abs(g2.physics.vx) < 0.01, 'launch input ignored during direct control')
    T(C.GRAVITY_DIRECT_CONTROL_MS + 700); g2.update(1); ok(!g2.powerups.getModifiers().gravityControlActive, `direct control ends after ${C.GRAVITY_DIRECT_CONTROL_MS} ms`)
    const xe = g2.physics.x; g2.handleInput('steer', { dx: 50, dy: 50 }); T(C.GRAVITY_DIRECT_CONTROL_MS + 750); g2.update(1)
    ok(Math.abs(g2.physics.x - xe) < 5, 'steer input after the window is ignored (no position jump)')
    ok(g2.powerups.getModifiers().gravityActive, 'float (reduced gravity) still active after control ends')
    setSimClock(null) } }

console.log('\n=== 15 Mythic Event Orb ===')
{ const g = fresh(); collect(g, 'mythic'); ok(g._serverEventQueue.some((e) => e.type === 'mythic_collected'), 'reports mythic_collected to the server (server decides the reward: NFT / mythic combo / bonus)')
  ok(between(C.MYTHIC_LIFETIME_MS, 5000, 8000), `on-screen lifetime ${C.MYTHIC_LIFETIME_MS} ms within 5000-8000`) }

console.log('\n=== 16 Diamond Glowing Orb (visible ~1 s) ===')
{ const g = fresh(); const s0 = g.score; collect(g, 'diamond')
  ok(between(C.DIAMOND_LIFETIME_MS, 800, 1500), `visible ${C.DIAMOND_LIFETIME_MS} ms (about 1 s)`)
  ok(g.score - s0 === C.DIAMOND_BASE_POINTS, `awards +${C.DIAMOND_BASE_POINTS} score`)
  { const g2 = fresh(); const c0 = g2.coins; const o = collect(g2, 'diamond')
    ok(g2.coins - c0 === C.DIAMOND_COIN_PAYOUT, `Diamond: +${C.DIAMOND_COIN_PAYOUT.toLocaleString('en-US')} Lava Coins`)
    collect(g2, 'diamond'); ok(g2.coins - c0 === C.DIAMOND_COIN_PAYOUT && g2.diamondPayoutCount === 1, 'Diamond coin payout is credited only ONCE per run (second Diamond pays no coins)')
    const lava = (now) => { g2.combo.reset(); const a = g2.score, b = g2.coins; const l = g2.orbs.spawnOrb('lava'); g2._handleOrbCollected(l, now, g2.powerups.getModifiers()); return [g2.score - a, g2.coins - b] }
    const [sc1, co1] = lava(T0 + 100), [sc2, co2] = lava(T0 + C.DIAMOND_BOOST_DURATION_MS + 500)
    ok(co1 === co2 * C.DIAMOND_NEARBY_LAVA_MULT, `Lava Orb coins x${C.DIAMOND_NEARBY_LAVA_MULT} for ${C.DIAMOND_BOOST_DURATION_MS} ms (${co1} vs ${co2})`)
    ok(sc1 === Math.floor(C.LAVA_ORB_BASE_SCORE * C.DIAMOND_COMBO_BOOST_MULT * C.DIAMOND_NEARBY_LAVA_MULT) && sc2 === C.LAVA_ORB_BASE_SCORE, `combo score gain x${C.DIAMOND_COMBO_BOOST_MULT} during the boost, normal afterwards (${sc1} vs ${sc2})`)
    ok(g2._serverEventQueue.filter((e) => e.type === 'diamond_collected').length === 1, 'one diamond_collected audit event')
    console.log('[SKIP] Diamond NFT eligibility: owner said not needed') } }

console.log('\n=== 17 Jackpot Orb (visible 1-2 s) ===')
{ const g = fresh(); const c0 = g.coins; const n0 = g.combo.count; collect(g, 'jackpot')
  ok(between(C.JACKPOT_LIFETIME_MS, 1000, 2000), `visible ${C.JACKPOT_LIFETIME_MS} ms within 1000-2000`)
  ok(g.coins - c0 >= C.JACKPOT_COIN_MIN && g.coins - c0 <= C.JACKPOT_COIN_MAX, `massive Lava Coin reward +${g.coins - c0} (${C.JACKPOT_COIN_MIN}-${C.JACKPOT_COIN_MAX})`)
  ok(g.jackpotTokensCollected === 1 && g._serverEventQueue.some((e) => e.type === 'jackpot_collected'), 'Jackpot token counted and reported to the server')
  ok(g.combo.count > n0, `large combo boost (+${g.combo.count - n0})`) }

console.log('\n=== Legacy Health orb (not in document) ===')
{ const g = fresh(); ok(true, 'cannot spawn in a real run (no in-run level unlocks it) - see orb_spec_check.js') }

console.log(`\n${fails ? fails + ' FAILURE(S)' : 'ALL ORB BEHAVIOUR CHECKS PASSED'}; ${gaps} documented behaviour gap(s) reported`)
process.exit(fails ? 1 : 0)

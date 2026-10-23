// D1 proof: free-Energy-per-day counter (DB-free, simulated clock via computeSettlement(user,config,now))
import { computeSettlement } from '../src/game/EnergyService.js'
const cfg = { maxEnergy: 10, regenEnabled: true, regenIntervalMinutes: 30, dailyResetEnabled: true, dailyResetTimezone: 'UTC', dailyFreeEnergyLimit: 50 }
let ok = true; const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false }
const day0 = Date.UTC(2026, 9, 21, 0, 5)
let t = day0
let u = { energy: 10, freeEnergyToday: 10, energyLastRegenAt: new Date(t), energyLastDailyResetAt: new Date(t) }
const apply = s => { if (s) { const { resetHappened, regenTicks, ...f } = s; Object.assign(u, f) } }
check('starts with 10 Energy, counter 10', u.energy === 10 && u.freeEnergyToday === 10)
let rises = [], spent = 0
for (let i = 0; i < 200 && t < Date.UTC(2026, 9, 21, 23, 50); i++) {
  u.energy = 0; spent += 10; t += 30 * 60000 * 10 // spend all, wait 10 intervals
  const before = u.freeEnergyToday; apply(computeSettlement(u, cfg, t)); rises.push(`${before}->${u.freeEnergyToday}`)
  if (u.freeEnergyToday >= 50) break
}
console.log('counter log:', rises.join(', '))
check('+1 per 30 min (10 ticks per 5h wait)', rises[0] === '10->20')
check('counter stops at exactly 50', u.freeEnergyToday === 50)
u.energy = 0; t += 30 * 60000 * 4
check('no free regen after limit (same day)', computeSettlement(u, cfg, t) === null && u.energy === 0)
u.energy += 5 // bought Energy
check('bought Energy still usable after limit', u.energy === 5 && u.freeEnergyToday === 50)
t = Date.UTC(2026, 9, 22, 0, 1)
const r = computeSettlement(u, cfg, t); apply(r)
check('daily reset at UTC midnight: counter reset, energy refilled', r?.resetHappened && u.freeEnergyToday === 10 && u.energy === 10)
check('regen works again next day', (() => { u.energy = 0; const r2 = computeSettlement(u, cfg, t + 31 * 60000); return r2?.energy === 1 && r2.freeEnergyToday === 11 })())
console.log(ok ? 'ALL D1 CHECKS PASSED' : 'D1 FAILED'); process.exit(ok ? 0 : 1)

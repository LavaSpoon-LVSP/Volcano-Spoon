// Anti-bot sanity test: human-like input patterns must PASS; bot-like patterns must still be rejected or flagged.
// Run: node Backend/scripts/test_antibot_false_positives.js
import { analyzeInputPlausibility } from '../src/game/inputPlausibility.js'

const frames = Array.from({ length: 3000 }, () => 1) // 3000 frames of dt=1 (~50 s)
let failed = 0
function check(name, result, expectReject, expectFlag = null) {
  const gotReject = !!result.rejectReason
  const gotFlag = result.flags.includes(expectFlag)
  const ok = gotReject === expectReject && (expectFlag === null || gotFlag)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -> reject=${result.rejectReason} flags=${result.flags.join(',') || '-'}`)
}

// Deterministic jitter so the test is repeatable
let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)

// 1. Human: irregular gaps of 25-110 frames
{
  const inputs = []; let f = 0
  for (let i = 0; i < 30; i += 1) { f += 25 + Math.floor(rnd() * 85); inputs.push({ atFrame: f, type: 'launch', dx: (rnd() - 0.5) * 120, dy: -(40 + rnd() * 60) }) }
  check('human irregular launches', analyzeInputPlausibility({ inputs, frames }), false)
}
// 2. Honest duplicate event: same gesture reported twice on the same frame (touch + synthesized mouse)
{
  const inputs = [{ atFrame: 0, type: 'launch', dx: 10, dy: -60 }, { atFrame: 0, type: 'launch', dx: 10, dy: -60 }, { atFrame: 80, type: 'launch', dx: -20, dy: -50 }]
  check('duplicate identical event on same frame', analyzeInputPlausibility({ inputs, frames }), false)
}
// 3. Bot: two DIFFERENT launches on the same frame
{
  const inputs = [{ atFrame: 10, type: 'launch', dx: 10, dy: -60 }, { atFrame: 10, type: 'launch', dx: -30, dy: -80 }]
  check('bot: two different launches same frame', analyzeInputPlausibility({ inputs, frames }), true)
}
// 4. Bot: forged huge launch
{
  const inputs = [{ atFrame: 20, type: 'launch', dx: 9999, dy: -9999 }]
  check('bot: forged launch magnitude', analyzeInputPlausibility({ inputs, frames }), true)
}
// 5. Bot: metronomic timing (flag only, never reject)
{
  const inputs = Array.from({ length: 20 }, (_, i) => ({ atFrame: 30 + i * 60, type: 'launch', dx: 5 + (i % 3), dy: -60 }))
  check('bot: perfectly regular timing flagged', analyzeInputPlausibility({ inputs, frames }), false, 'scripted_input_timing')
}
// 6. Bot: steer input far out of range
{
  const inputs = [{ atFrame: 5, type: 'steer', dx: 99999, dy: 10 }]
  check('bot: steer out of range', analyzeInputPlausibility({ inputs, frames }), true)
}
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall anti-bot checks behave as expected')
process.exit(failed ? 1 : 0)

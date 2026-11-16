// End-to-end check of the run-report path against a real MongoDB: plays a bot run with the client
// GameLogic, submits it through ClientSession exactly like the browser does, and reports
//   - how long until run:validated is sent (the "Confirming your results" time),
//   - that the server's credited score/coins equal the client's local result,
//   - that a duplicate report does not credit twice.
// WARNING: it creates a test user and rounds - point MONGO_URI at a TEST database, never production.
// Uses MONGO_URI if set, otherwise starts an in-memory MongoDB (needs `npm i --no-save mongodb-memory-server`).
// Run: node Backend/scripts/test_run_report_timing.js
import mongoose from 'mongoose'
import { GameLogic } from '../src/game/GameLogic.js'
import { seedRandom } from '../src/game/seededRandom.js'
import { setSimClock } from '../src/game/simClock.js'

let mongod = null
let uri = process.env.MONGO_URI
if (!uri) {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  mongod = await MongoMemoryServer.create()
  uri = mongod.getUri('vs_timing_test')
}
await mongoose.connect(uri)

const { User } = await import('../src/models/User.js')
const { RunResult } = await import('../src/models/RunResult.js')
const { ClientSession } = await import('../src/game/ClientSession.js')

const user = await User.create({ username: 'timing_test', email: 'timing@test.local', passwordHash: 'x' })
const sent = []
const ws = { readyState: 1, send: (raw) => sent.push({ t: Date.now(), ...JSON.parse(raw) }), close() {} }
const session = new ClientSession({ ws, user: { id: String(user._id), username: user.username, email: user.email, role: 'user' }, ip: '127.0.0.1' })
await session.init()

const waitFor = async (type, ms = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const m = sent.find((x) => x.type === type)
    if (m) return m
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timeout waiting for ' + type)
}

session.handleMessage({ type: 'game:restart', isMobile: false })
const tokenMsg = await waitFor('run:token')
const { runToken, seed, artifactPerks, arenaStage, stageMultipliers } = tokenMsg.payload

// Play the run locally exactly as the browser does (client GameLogic, seeded, simulated clock)
seedRandom(seed); let now = 0; setSimClock(() => now)
const g = new GameLogic(); g.reset(); g.setArtifactPerks?.(artifactPerks); g.setArenaStage(arenaStage, stageMultipliers)
const frames = [], inputs = []
let rs = 7; const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 2 ** 32)
let next = 0
for (let i = 0; i < 6000; i++) {
  if (i >= next) {
    const lava = g.orbs.orbs.filter((o) => o.active && o.type === 'lava')
    let dx = (rnd() - 0.5) * 120, dy = -(55 + rnd() * 40)
    if (lava.length) { const o = lava[0]; dx = Math.max(-120, Math.min(120, (o.x - g.physics.x) * 0.6)) }
    g.handleInput('launch', { dx, dy }); inputs.push({ atFrame: i, type: 'launch', dx, dy })
    next = i + 25 + Math.floor(rnd() * 85)
  }
  g.update(1); now += 16.667; frames.push(1)
  if (g.gameOver) break
}
setSimClock(null); seedRandom(NaN)
const virtualMs = frames.length * 16.667
session._activeRun.serverIssuedAt -= virtualMs + 500 // test shortcut: pretend the run really took this long

const report = { type: 'game:run_report', runToken, score: g.score, coinsEarned: g.coins, jackpotTokensCollected: g.jackpotTokensCollected, frames, inputs }
const t0 = Date.now()
session.handleMessage(report)
const validated = await waitFor('run:validated', 15000)
const confirmMs = validated.t - t0

console.log(`run: ${frames.length} frames (${(virtualMs / 1000).toFixed(1)} s), ${inputs.length} inputs`)
console.log(`client score/coins: ${g.score}/${g.coins}   server score/coins: ${validated.payload.score}/${validated.payload.coinsEarned}`)
console.log(`time until run:validated: ${confirmMs} ms`)

let ok = validated.payload.score === g.score
const before = (await User.findById(user._id)).coins
session.handleMessage(report) // duplicate report must not credit again
await new Promise((r) => setTimeout(r, 600))
const after = (await User.findById(user._id)).coins
console.log(`duplicate report credited twice? ${after !== before ? 'YES (BAD)' : 'no'}  (coins ${before} -> ${after})`)
ok = ok && after === before
await new Promise((r) => setTimeout(r, 500)) // let background follow-ups finish
console.log('follow-up messages:', sent.filter((m) => ['badges:awarded', 'leaderboard:data'].includes(m.type)).map((m) => m.type).join(', ') || '(none)')
console.log('committed rounds:', await RunResult.countDocuments({ userId: user._id, status: 'committed' }))
console.log(ok ? 'RESULT: OK' : 'RESULT: PROBLEM')
session.close?.()
await mongoose.disconnect(); if (mongod) await mongod.stop()
process.exit(ok ? 0 : 1)

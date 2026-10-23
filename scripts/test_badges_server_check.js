// F1: the server must reject a badge the player has not earned, and accept one backed by a confirmed run.
// Runs against the real router code with an in-memory stand-in for the two Mongo models (no database needed).
// Re-run against a real test MongoDB before sign-off.
import express from 'express'
import { signAuthToken } from '../src/auth.js'
import { User } from '../src/models/User.js'
import { RunResult } from '../src/models/RunResult.js'
import { createBadgesRouter } from '../src/routes/badges.js'

const SECRET = 'test-secret-for-local-check'
const userDoc = { _id: 'u1', tokenVersion: 0, badges: [] }
const committedRuns = [{ userId: 'u1', status: 'committed', survivalMs: 35000, maxCombo: 12, jackpotOrbCollected: false, mythicOrbCollected: false }]

const chain = (v) => ({ select: () => chain(v), lean: async () => v, then: (r, j) => Promise.resolve(v).then(r, j) })
User.findById = () => chain(userDoc)
User.exists = async (q) => (q['badges.id'] && userDoc.badges.some(b => b.id === q['badges.id'])) ? { _id: 'u1' } : null
User.updateOne = async (q, u) => { for (const b of (u.$push?.badges?.$each ?? [u.$push.badges])) if (!userDoc.badges.some(x => x.id === b.id)) userDoc.badges.push(b); return {} }
RunResult.exists = async (q) => {
  const hit = committedRuns.some(r => r.userId === q.userId && r.status === q.status &&
    (q.survivalMs ? r.survivalMs >= q.survivalMs.$gte : true) &&
    (q.maxCombo ? r.maxCombo >= q.maxCombo.$gte : true) &&
    (q.jackpotOrbCollected ? r.jackpotOrbCollected : true) &&
    (q.mythicOrbCollected ? r.mythicOrbCollected : true))
  return hit ? { _id: 'r' } : null
}

const app = express(); app.use(express.json()); app.use('/api/badges', createBadgesRouter(SECRET))
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/badges`
const token = signAuthToken({ id: 'u1', username: 'checker', tokenVersion: 0 }, SECRET)
const earn = async (badgeId) => { const r = await fetch(base + '/earn', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ badgeId }) }); return { status: r.status, body: await r.json() } }

let fail = 0
const check = (name, cond, extra) => { console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name} -> ${extra}`); if (!cond) fail++ }

let r = await earn('survivor_180'); check('unearned badge survivor_180 (best run 35 s) is rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
r = await earn('combo_50');        check('unearned badge combo_50 (best combo 12) is rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
r = await earn('first_jackpot');   check('unearned badge first_jackpot is rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
r = await earn('not_a_badge');     check('unknown badge id is rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
check('badge list is still empty after the rejected requests', userDoc.badges.length === 0, `badges=${userDoc.badges.length}`)
r = await earn('survivor_30');     check('earned badge survivor_30 (confirmed 35 s run) is accepted', r.status === 200 && r.body.badges.some(b => b.id === 'survivor_30'), `${r.status} ${JSON.stringify(r.body.badges?.map(b => b.id))}`)
r = await earn('survivor_30');     check('repeat claim is idempotent (no duplicate)', r.status === 200 && userDoc.badges.length === 1, `${r.status} badges=${userDoc.badges.length}`)
server.close()
console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL BADGE SERVER-CHECKS PASSED')
process.exit(fail ? 1 : 0)

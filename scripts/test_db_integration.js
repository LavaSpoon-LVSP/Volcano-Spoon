// Real-database checks (B1, C2, badges/F1, G1, G7). Starts the backend on a spare port using ONLY .env.test,
// so the real .env secrets are never loaded. Writes test data to the database named in .env.test.
// Run (from Backend/):  node scripts/test_db_integration.js
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import WebSocket from 'ws'
import { User } from '../src/models/User.js'
import { RunResult } from '../src/models/RunResult.js'
import { AdminUser } from '../src/models/AdminUser.js'
import { AdminAuditLog } from '../src/models/AdminAuditLog.js'
import { PasswordResetToken } from '../src/models/PasswordResetToken.js'
import { replayRun } from '../src/game/ReplayEngine.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env.test') })
const FLAG = path.join(os.tmpdir(), 'volcano_fault_once.flag'), PRELOAD = path.join(os.tmpdir(), 'volcano_fault_once.mjs')
fs.writeFileSync(PRELOAD, `// Test-only preload: makes the NEXT User.findByIdAndUpdate call fail once (simulated DB failure while crediting a round) when the flag file exists.
import fs from 'fs'
const { User } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/models/User.js')).href)})
const orig = User.findByIdAndUpdate.bind(User)
User.findByIdAndUpdate = (...a) => { if (fs.existsSync(${JSON.stringify(FLAG)})) { fs.unlinkSync(${JSON.stringify(FLAG)}); throw new Error('SIMULATED_DB_FAILURE: connection dropped while crediting the round') } return orig(...a) }
`)
const PORT = 5055, BASE = `http://127.0.0.1:${PORT}`, TAG = 'dbt' + Date.now().toString(36)
const dbName = (process.env.MONGO_URI.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1] || '(none)'
console.log(`Database in use: ${dbName} (credentials not printed)   test tag: ${TAG}\n`)
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 }).catch((e) => { console.error('Cannot connect to the database:', e.name, e.code || ''); process.exit(1) })

let server, serverOut = ''
const startServer = async () => {
  serverOut = ''
  server = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, 'server.js'], { cwd: root, env: { ...process.env, DOTENV_CONFIG_PATH: '.env.test', PORT: String(PORT), NODE_ENV: 'test' } })
  server.stdout.on('data', d => serverOut += d); server.stderr.on('data', d => serverOut += d)
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) return } catch {} ; await sleep(500) }
  throw new Error('server did not start:\n' + serverOut)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' -> ' + detail : ''}`); if (!ok) fails++ }
const api = async (method, url, body, token) => { const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json() } catch {} ; return { status: r.status, body: j } }

function session(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`), hist = [], waiters = new Set()
    ws.on('message', d => { const m = JSON.parse(d.toString()); for (const w of waiters) if (w.f(m)) { waiters.delete(w); clearTimeout(w.t); return w.r(m) } hist.push(m) })
    const wait = (f, ms = 15000) => new Promise((res, rej) => { const i = hist.findIndex(f); if (i >= 0) return res(hist.splice(i, 1)[0]); const w = { f, r: res, t: setTimeout(() => { waiters.delete(w); rej(new Error('timeout; history=' + JSON.stringify(hist))) }, ms) }; waiters.add(w) })
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'game:start', perks: {}, isMobile: false })))
    wait(m => m.type === 'auth:ok' || m.type === 'game:state').then(() => resolve({ ws, wait, send: o => ws.send(JSON.stringify(o)) })).catch(reject)
  })
}
function scoringRun(seed) {
  const frames = [0]; for (let f = 1; f < 240; f++) frames.push(1)
  for (const a of [35, 45, -35, -45, 25, 55, -25, -55, 65, -65]) for (const p2 of [-40, 40, 0, -60, 60, -20, 20]) for (const p3 of [30, -30, 50, -50, 0]) {
    const inputs = [{ atFrame: 0, type: 'launch', dx: a, dy: -75 }, { atFrame: 45, type: 'launch', dx: p2, dy: -80 }, { atFrame: 100, type: 'launch', dx: p3, dy: -70 }, { atFrame: 160, type: 'launch', dx: -a, dy: -85 }]
    const r = replayRun({ seed, frames, inputs, arenaStage: 1, stageMultipliers: null, artifactPerks: {} })
    if (r.score > 0 && r.coins > 0) return { frames, inputs }
  }
  throw new Error('no scoring run found')
}
const signup = async (name) => { const r = await api('POST', '/auth/signup', { username: `${TAG}_${name}`, email: `${TAG}_${name}@example.test`, password: 'Passw0rd!x' }); if (r.status !== 201) throw new Error('signup failed ' + JSON.stringify(r)); return r.body }
async function startRun(s) { await sleep(900); s.send({ type: 'game:restart', isTutorial: false }); return (await s.wait(m => m.type === 'run:token')).payload }
const report = (s, runToken, run) => s.send({ type: 'game:run_report', runToken, score: 0, coinsEarned: 0, durationMs: 4000, frames: run.frames, inputs: run.inputs })
const coinsOf = async id => (await User.findById(id).select('coins').lean()).coins

try {
  await startServer()
  const A = await signup('a'); const userId = A.user.id
  await User.updateOne({ _id: userId }, { $set: { energy: 50 } })

  console.log('\n===== C2 / B1: one result per round, duplicates, concurrency =====')
  let s = await session(A.token)
  let { runToken, seed } = await startRun(s)
  let run = scoringRun(seed); await sleep(Math.round(run.frames.length * 16.667) + 400)
  const c0 = await coinsOf(userId)
  report(s, runToken, run); let v1 = await s.wait(m => m.type === 'run:validated')
  const c1 = await coinsOf(userId); const rr = await RunResult.findOne({ roundId: runToken }).lean()
  check('first report is validated, credited once and committed', v1.payload.coinsEarned > 0 && c1 - c0 === v1.payload.coinsEarned && rr.status === 'committed' && rr.walletCredited, `coinsEarned=${v1.payload.coinsEarned} wallet +${c1 - c0} roundId=${v1.payload.roundId} status=${rr.status}`)
  report(s, runToken, run); let v2 = await s.wait(m => m.type === 'run:validated')
  check('same report sent again: same roundId, same saved result, no second credit', v2.payload.roundId === v1.payload.roundId && v2.payload.coinsEarned === v1.payload.coinsEarned && await coinsOf(userId) === c1, `wallet still ${await coinsOf(userId)}; replies were run:validated, never a second credit`)
  s.ws.close()

  s = await session(A.token); ;({ runToken, seed } = await startRun(s)); run = scoringRun(seed); await sleep(Math.round(run.frames.length * 16.667) + 400)
  const c2 = await coinsOf(userId)
  report(s, runToken, run); report(s, runToken, run); report(s, runToken, run)       // three reports in the same instant
  await sleep(2500)
  const rows = await RunResult.countDocuments({ roundId: runToken }); const d = (await coinsOf(userId)) - c2
  const expected = (await RunResult.findOne({ roundId: runToken }).lean()).coinsEarned
  check('3 simultaneous reports for one round: exactly one RunResult and one credit', rows === 1 && d === expected && expected > 0, `RunResult rows=${rows}, wallet +${d}, round coinsEarned=${expected}`)
  s.ws.close()

  console.log('\n===== B1: forced failure in the middle of saving, then retry =====')
  s = await session(A.token); ;({ runToken, seed } = await startRun(s)); run = scoringRun(seed); await sleep(Math.round(run.frames.length * 16.667) + 400)
  const c3 = await coinsOf(userId); fs.writeFileSync(FLAG, '1')
  report(s, runToken, run); const rej = await s.wait(m => m.type === 'run:rejected' || m.type === 'run:validated')
  const mid = await RunResult.findOne({ roundId: runToken }).lean()
  check('save fails mid-way: round left recoverable, nothing credited yet', rej.type === 'run:rejected' && rej.payload.retryable === true && mid && mid.status === 'settling' && (await coinsOf(userId)) === c3, `reply=${JSON.stringify(rej.payload)} status=${mid?.status} walletCredited=${mid?.walletCredited} totalCoinsAfter=${mid?.totalCoinsAfter} wallet unchanged=${await coinsOf(userId) === c3}`)
  report(s, runToken, run); const rec = await s.wait(m => m.type === 'run:validated')
  const done = await RunResult.findOne({ roundId: runToken }).lean()
  check('retry completes it: one credit, same round ID, status committed', rec.payload.roundId === runToken && done.status === 'committed' && (await coinsOf(userId)) - c3 === done.coinsEarned && done.coinsEarned > 0, `roundId same=${rec.payload.roundId === runToken}, wallet +${(await coinsOf(userId)) - c3}, status=${done.status}`)
  report(s, runToken, run); await s.wait(m => m.type === 'run:validated')
  check('another duplicate after recovery adds nothing', (await coinsOf(userId)) - c3 === done.coinsEarned, `wallet +${(await coinsOf(userId)) - c3}`)
  s.ws.close()

  console.log('\n===== F1: badges are decided by the server =====')
  const B = await signup('b')
  let r = await api('POST', '/api/badges/earn', { badgeId: 'survivor_180' }, B.token); check('player with no runs claims survivor_180: rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
  r = await api('POST', '/api/badges/earn', { badgeId: 'not_a_badge' }, B.token); check('unknown badge id: rejected', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
  r = await api('GET', '/api/badges/me', null, B.token); check('badge list still empty', r.body.badges.length === 0, JSON.stringify(r.body))
  await RunResult.create({ roundId: `${TAG}-seeded-run`, userId: B.user.id, status: 'committed', score: 1, coinsEarned: 0, jackpotTokensCollected: 0, xpEarned: 0, arenaStage: 1, lavaCoinMultiplier: 1, survivalMs: 35000, walletCredited: true, totalCoinsAfter: 0 })
  r = await api('POST', '/api/badges/earn', { badgeId: 'survivor_30' }, B.token); check('after a confirmed 35 s run (seeded record), survivor_30 is accepted', r.status === 200 && r.body.badges.some(b => b.id === 'survivor_30'), `${r.status} ${JSON.stringify(r.body.badges?.map(b => b.id))}`)
  const signin = await api('POST', '/auth/signin', { email: `${TAG}_b@example.test`, password: 'Passw0rd!x' })
  r = await api('GET', '/api/badges/me', null, signin.body.token); check('badge is still there on a fresh login (new token, no browser storage)', r.body.badges.some(b => b.id === 'survivor_30'), JSON.stringify(r.body.badges?.map(b => b.id)))
  r = await api('POST', '/api/badges/earn', { badgeId: 'combo_50' }, signin.body.token); check('still cannot claim an unearned badge (combo_50)', r.status === 400, `${r.status}`)

  console.log('\n===== G1: password reset (single use, expiry, old sessions end) =====')
  const C = await signup('c'); const emailC = `${TAG}_c@example.test`
  r = await api('POST', '/auth/forgot-password', { email: emailC }); await sleep(1500)
  const m = serverOut.match(/resetToken=([A-Za-z0-9_\-]+)/g); const tok = m && m[m.length - 1].split('=')[1]
  check('reset email (logged by the server in console mode) contains a link', r.status === 200 && !!tok, `status ${r.status}; link ends ...${tok?.slice(-6)}`)
  r = await api('GET', '/api/badges/me', null, C.token); check('old session works before the reset', r.status === 200, String(r.status))
  r = await api('POST', '/auth/reset-password', { token: tok, password: 'NewPassw0rd!y' }); check('reset with the link succeeds', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`)
  r = await api('POST', '/auth/reset-password', { token: tok, password: 'Another0ne!z' }); check('same link a second time is refused', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)
  r = await api('GET', '/api/badges/me', null, C.token); check('old session (token issued before the reset) is logged out', r.status === 401, `${r.status} ${JSON.stringify(r.body)}`)
  r = await api('POST', '/auth/signin', { email: emailC, password: 'NewPassw0rd!y' }); check('login with the new password works', r.status === 200, String(r.status))
  r = await api('POST', '/auth/signin', { email: emailC, password: 'Passw0rd!x' }); check('login with the old password fails', r.status === 401, String(r.status))
  serverOut = ''; await api('POST', '/auth/forgot-password', { email: emailC }); await sleep(1500)
  const m2 = serverOut.match(/resetToken=([A-Za-z0-9_\-]+)/g); const tok2 = m2 && m2[m2.length - 1].split('=')[1]
  await PasswordResetToken.updateMany({ userId: C.user.id, usedAt: null }, { $set: { expiresAt: new Date(Date.now() - 60_000) } })
  r = await api('POST', '/auth/reset-password', { token: tok2, password: 'Expired0ne!q' }); check('an expired link (expiry set to 1 minute ago) is refused', !!tok2 && r.status === 400, `${r.status} ${JSON.stringify(r.body)}`)

  console.log('\n===== G7: player search, correction with reason, audit log, named admins =====')
  const ownerName = `${TAG}_owner`
  await AdminUser.create({ username: ownerName, passwordHash: await bcrypt.hash('OwnerPass!1', 10), role: 'owner', active: true })
  const login = await api('POST', '/admin/login', { username: ownerName, password: 'OwnerPass!1' }); const at = login.body.token
  check('named admin logs in', login.status === 200 && !!at, String(login.status))
  r = await api('POST', '/api/admin/admins', { username: `${TAG}_admin2`, password: 'AdminPass!2', role: 'admin' }, at); check('second named admin account created', r.status === 201, `${r.status}`)
  r = await api('GET', '/api/admin/admins', null, at); check('Admins list shows both named accounts', JSON.stringify(r.body).includes(ownerName) && JSON.stringify(r.body).includes(`${TAG}_admin2`), JSON.stringify(r.body).replace(/passwordHash[^,}]*/g, '').slice(0, 300))
  r = await api('GET', `/api/admin/players?q=${TAG}_a`, null, at); check('player search finds the test player', r.status === 200 && JSON.stringify(r.body).includes(`${TAG}_a`), `${r.status}`)
  const e0 = (await User.findById(userId).select('energy').lean()).energy
  r = await api('POST', `/api/admin/players/${TAG}_a/correct`, { field: 'energy', mode: 'delta', amount: -2, reason: 'Checklist G7 test: manual Energy correction' }, at)
  check('correction without a reason is refused', (await api('POST', `/api/admin/players/${TAG}_a/correct`, { field: 'energy', mode: 'delta', amount: 1 }, at)).status === 400)
  const e1 = (await User.findById(userId).select('energy').lean()).energy
  check('correction with a reason is applied', r.status === 200 && e1 === e0 - 2, `${r.status}; energy ${e0} -> ${e1}`)
  r = await api('GET', `/api/admin/audit-log?targetUsername=${TAG}_a`, null, at)
  const entry = (r.body.entries || r.body.logs || r.body.items || (Array.isArray(r.body) ? r.body : []))[0]
  check('audit log has the entry with admin name, field, change and reason', !!entry && JSON.stringify(entry).includes(ownerName) && JSON.stringify(entry).includes('Checklist G7 test'), JSON.stringify(entry)?.slice(0, 400))
} catch (e) { fails++; console.error('TEST ERROR:', String(e.stack || e).replace(/mongodb(\+srv)?:\/\/[^\s'"]*/g, 'mongodb://<hidden>').slice(0, 1500)) }
finally {
  try {
    const users = await User.find({ username: new RegExp('^' + TAG) }).select('_id').lean(); const ids = users.map(u => u._id)
    await RunResult.deleteMany({ $or: [{ userId: { $in: ids } }, { roundId: new RegExp('^' + TAG) }] })
    await PasswordResetToken.deleteMany({ userId: { $in: ids } }); await AdminAuditLog.deleteMany({ targetUsername: new RegExp('^' + TAG) })
    await AdminUser.deleteMany({ username: new RegExp('^' + TAG) }); await User.deleteMany({ _id: { $in: ids } })
    console.log(`\nCleaned up test data (tag ${TAG}).`)
  } catch (e) { console.error('cleanup error', e.message) }
  server?.kill('SIGKILL'); await mongoose.disconnect()
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL DATABASE CHECKS PASSED'); process.exit(fails ? 1 : 0)
}

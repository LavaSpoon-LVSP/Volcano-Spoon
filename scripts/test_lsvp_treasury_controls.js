// LSVP ratio control + treasury protection, tested over HTTP against the TEST database in .env.test.
// Covers: rate change audit log, rate-change guard (+override), per-transaction cap, global daily
// reservation (+release on reject), pending request keeps its own coinsSpent after a rate change,
// stats totals, reward caps endpoint. Never sends on-chain transfers (approval threshold is forced to 1 so
// every purchase goes to the pending queue). Restores the settings it changes and deletes what it creates.
// Run (from Backend/):  node scripts/test_lsvp_treasury_controls.js
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import express from 'express'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env.test') })
if (!process.env.MONGO_URI) { console.error('MONGO_URI missing (.env.test)'); process.exit(1) }

const { User } = await import('../src/models/User.js')
const { AdminUser } = await import('../src/models/AdminUser.js')
const { LsvpBuyConfig, getLsvpBuyConfig } = await import('../src/models/LsvpBuyConfig.js')
const { RewardCapsConfig, getRewardCapsConfig } = await import('../src/models/RewardCapsConfig.js')
const { LsvpRateChange } = await import('../src/models/LsvpRateChange.js')
const { LsvpPurchaseRequest } = await import('../src/models/LsvpPurchaseRequest.js')
const { LsvpDailyUsage, todayDateKey } = await import('../src/models/LsvpDailyUsage.js')
const { LsvpGlobalDailyUsage, getGlobalLsvpUsage } = await import('../src/models/LsvpGlobalDailyUsage.js')
const { signAuthToken, signAdminToken } = await import('../src/auth.js')
const { createBlockchainAdminRouter } = await import('../src/routes/blockchainAdmin.js')
const { createBlockchainUserRouter } = await import('../src/routes/blockchainUser.js')

const SECRET = 'test-secret-treasury'
let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' -> ' + detail : ''}`); if (!ok) fails++ }

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 })
const tag = 'trs' + Date.now().toString(36)

// Snapshot settings so the test leaves the database as it found it.
const buyBefore = (await getLsvpBuyConfig()).toObject()
const capsBefore = (await getRewardCapsConfig()).toObject()

const app = express()
app.use(express.json())
app.use('/api/admin/blockchain', createBlockchainAdminRouter(SECRET, new Map()))
app.use('/api/blockchain', createBlockchainUserRouter(SECRET, new Map()))
const server = http.createServer(app)
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`

const admin = await AdminUser.create({ username: tag + '_admin', passwordHash: 'x', role: 'admin' })
const player = await User.create({ username: tag + '_p', email: tag + '@example.test', passwordHash: 'x', coins: 100000, solanaWalletAddress: '11111111111111111111111111111112' })
const adminTok = signAdminToken(SECRET, admin)
const playerTok = signAuthToken(player, SECRET)
const call = async (method, url, token, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
const cfgUrl = '/api/admin/blockchain/lsvp-buy-config'

try {
  // Known starting point: rate 100, guard 50%, min 1 / max 100000, tx cap 5, everything routes to approval.
  await LsvpBuyConfig.updateOne({ key: 'default' }, { $set: { coinsPerLsvp: 100, approvalThresholdLsvp: 1, dailyLimitLsvp: 100000, globalDailyLimitLsvp: 100000, maxLsvpPerTransaction: 5, maxRateChangePercent: 50, minCoinsPerLsvp: 1, maxCoinsPerLsvp: 100000 } })

  // 1. Rate change within the guard: saved, immediate, logged.
  let r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 120, note: 'test raise' })
  check('rate +20% saved immediately', r.status === 200 && r.data.coinsPerLsvp === 120, JSON.stringify(r.data))
  let log = await LsvpRateChange.find({ changedBy: admin.username, field: 'coinsPerLsvp' }).sort({ createdAt: -1 })
  check('rate change recorded (old, new, who, note)', log.length === 1 && log[0].oldValue === 100 && log[0].newValue === 120 && log[0].note === 'test raise' && log[0].changePercent === 20, JSON.stringify(log[0]))

  // 2. Rate change beyond the guard is refused without override...
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 1000 })
  check('rate +733% refused with RATE_GUARD', r.status === 409 && r.data.code === 'RATE_GUARD' && r.data.requiresOverride === true, r.data.message)
  check('refused change did not alter the rate', (await getLsvpBuyConfig()).coinsPerLsvp === 120)
  // ...and accepted with confirmOverride.
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 1000, confirmOverride: true })
  log = await LsvpRateChange.find({ changedBy: admin.username, field: 'coinsPerLsvp' }).sort({ createdAt: -1 })
  check('override applies the change and flags it in the log', r.status === 200 && r.data.coinsPerLsvp === 1000 && log[0].overrideUsed === true)
  // Decreasing is guarded the same way.
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 100 })
  check('large decrease (-90%) is also guarded', r.status === 409 && r.data.code === 'RATE_GUARD')
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 800 })
  check('moderate decrease (-20%) allowed', r.status === 200 && r.data.coinsPerLsvp === 800)
  // Outside min/max
  r = await call('PUT', cfgUrl, adminTok, { maxCoinsPerLsvp: 900, maxRateChangePercent: 1000 })
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 950 })
  check('rate above maxCoinsPerLsvp needs override', r.status === 409 && r.data.code === 'RATE_GUARD')
  r = await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 0 })
  check('zero / negative rate rejected', r.status === 400)
  r = await call('PUT', cfgUrl, adminTok, { minCoinsPerLsvp: 5000 })
  check('min greater than max rejected', r.status === 400)
  await LsvpBuyConfig.updateOne({ key: 'default' }, { $set: { coinsPerLsvp: 100, maxCoinsPerLsvp: 100000, maxRateChangePercent: 50 } })

  // 3. Per-transaction hard cap.
  r = await call('POST', '/api/blockchain/lsvp/buy', playerTok, { lsvpAmount: 6 })
  check('purchase above maxLsvpPerTransaction (5) refused', r.status === 400 && /maximum purchase/i.test(r.data.message || ''), r.data.message)

  // 4. Pending request keeps its own coinsSpent; global usage reserved; rate change afterwards does not touch it.
  const dateKey = todayDateKey()
  const g0 = await getGlobalLsvpUsage(dateKey)
  r = await call('POST', '/api/blockchain/lsvp/buy', playerTok, { lsvpAmount: 3 })
  const reqId = r.data.request?._id
  check('purchase queued as pending at the current rate (3 LSVP = 300 coins)', r.status === 201 && r.data.request?.status === 'pending' && r.data.request?.coinsSpent === 300, JSON.stringify(r.data.request))
  check('global daily usage reserved (+3)', (await getGlobalLsvpUsage(dateKey)) === g0 + 3)
  await call('PUT', cfgUrl, adminTok, { coinsPerLsvp: 140 })
  const stored = await LsvpPurchaseRequest.findById(reqId)
  check('pending request still carries its original coinsSpent after a rate change', stored.coinsSpent === 300)

  // 5. Stats reflect the queue.
  r = await call('GET', '/api/admin/blockchain/lsvp-stats', adminTok)
  check('stats: pending count/LSVP include the request, rate matches', r.status === 200 && r.data.pendingCount >= 1 && r.data.pendingLsvp >= 3 && r.data.coinsPerLsvp === 140, JSON.stringify({ pc: r.data.pendingCount, pl: r.data.pendingLsvp, rate: r.data.coinsPerLsvp }))
  const approvedAgg = await LsvpPurchaseRequest.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, l: { $sum: '$lsvpAmount' }, c: { $sum: '$coinsSpent' } } }])
  check('stats: total LSVP converted / coins spent equal the approved requests', r.data.totalLsvpConverted === (approvedAgg[0]?.l || 0) && r.data.totalCoinsSpent === (approvedAgg[0]?.c || 0))

  // 6. Rejecting releases both the per-player and the global reservation.
  r = await call('POST', `/api/admin/blockchain/lsvp-requests/${reqId}/reject`, adminTok, { reason: 'test' })
  check('reject succeeds', r.status === 200 && r.data.request?.status === 'rejected')
  check('global reservation released on reject', (await getGlobalLsvpUsage(dateKey)) === g0)

  // 7. History endpoint.
  r = await call('GET', '/api/admin/blockchain/lsvp-rate-history?limit=200', adminTok)
  check('history endpoint lists the changes', r.status === 200 && r.data.changes.some((c) => c.changedBy === admin.username && c.field === 'coinsPerLsvp'))

  // 8. Reward caps.
  r = await call('PUT', '/api/admin/blockchain/reward-caps', adminTok, { diamondOrbCoinPayout: 5000000, maxCoinsPerRun: 9000000 })
  check('reward caps saved', r.status === 200 && r.data.diamondOrbCoinPayout === 5000000 && r.data.maxCoinsPerRun === 9000000)
  r = await call('PUT', '/api/admin/blockchain/reward-caps', adminTok, { diamondOrbCoinPayout: -1 })
  check('negative Diamond payout rejected', r.status === 400)
  r = await call('GET', '/api/admin/blockchain/reward-caps', adminTok)
  check('reward caps readable', r.status === 200 && r.data.diamondOrbCoinPayout === 5000000)
  const capLog = await LsvpRateChange.find({ scope: 'rewardCaps', changedBy: admin.username })
  check('reward cap changes are audit-logged', capLog.some((c) => c.field === 'diamondOrbCoinPayout' && c.newValue === 5000000))

  // 9. Players cannot use the admin endpoints.
  r = await call('PUT', cfgUrl, playerTok, { coinsPerLsvp: 1 })
  check('non-admin cannot change the rate', r.status === 403 || r.status === 401, String(r.status))
} finally {
  await LsvpBuyConfig.replaceOne({ key: 'default' }, buyBefore)
  await RewardCapsConfig.replaceOne({ key: 'default' }, capsBefore)
  await LsvpRateChange.deleteMany({ changedBy: admin.username })
  await LsvpPurchaseRequest.deleteMany({ user: player._id })
  await LsvpDailyUsage.deleteMany({ user: player._id })
  await User.deleteOne({ _id: player._id })
  await AdminUser.deleteOne({ _id: admin._id })
  await new Promise((r) => server.close(r))
  await mongoose.disconnect()
}
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL LSVP TREASURY CHECKS PASSED')
process.exit(fails ? 1 : 0)

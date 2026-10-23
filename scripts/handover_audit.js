// HANDOVER AUDIT (READ-ONLY) - proves a database is clean before it is handed to the client.
// It never writes, updates or deletes anything. Run it against the database you will hand over:
//   MONGO_URI="<handover db uri>" node Backend/scripts/handover_audit.js | tee docs/evidence/handover_audit.txt
// (or put MONGO_URI in Backend/.env). It prints only the database NAME, never the URI, passwords or emails.
// Exit code 0 = clean, 1 = leftovers found.
import 'dotenv/config'
import mongoose from 'mongoose'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const uri = process.env.MONGO_URI
if (!uri) { console.error('MONGO_URI is not set.'); process.exit(2) }

const TEST_NAME = /(^|[^a-z])(zz_test|test|delete_?me|checklist|dummy|temp|tmp)([^a-z]|$)/i
const TEST_USER = /^(suf1|qinwan|energytest|anticheat_live_.*|checklistw_.*|test.*)$/i
let problems = 0
const section = (t) => console.log(`\n=== ${t} ===`)
const flag = (m) => { problems++; console.log(`[FOUND] ${m}`) }
const okLine = (m) => console.log(`[CLEAN] ${m}`)

// 1. Source tree: leftover scripts / test references that would ship in the code
section('1. Source code handed to the client')
const mustNotExist = ['_to_delete', '_to_delete/_tmp_test_plausibility.mjs']
for (const p of mustNotExist) fs.existsSync(path.join(root, p)) ? flag(`Backend/${p} still exists`) : okLine(`Backend/${p} does not exist`)
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue
    const f = path.join(dir, e.name)
    e.isDirectory() ? walk(f, acc) : acc.push(f)
  }
  return acc
}
const files = walk(path.join(root, 'src')).concat(walk(here)).filter((f) => /\.(m?js|json)$/.test(f))
const refs = []
for (const f of files) {
  if (path.basename(f) === 'handover_audit.js') continue
  const txt = fs.readFileSync(f, 'utf8')
  const hit = txt.match(/ZZ_TEST|checklist_purchase_test|anticheat_live|checklistw_|EnergyTest|_tmp_test_plausibility/)
  if (hit) refs.push(`${path.relative(root, f)} mentions "${hit[0]}"`)
}
refs.length ? refs.forEach((r) => flag(r)) : okLine('no source file references test accounts or test catalog items')
const debugLogs = []
for (const f of walk(path.join(root, 'src')).filter((x) => x.endsWith('.js'))) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/console\.(log|debug|info)\(/.test(line) && !line.trim().startsWith('//')) debugLogs.push(`${path.relative(root, f)}:${i + 1}`)
  })
}
console.log(`console.log/debug/info calls left in Backend/src: ${debugLogs.length}`)
debugLogs.forEach((d) => console.log('   ' + d))

// 2. Database
await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 })
console.log(`\nConnected to database: ${mongoose.connection.name}`)
const db = mongoose.connection.db
const col = (n) => db.collection(n)
const names = new Set((await db.listCollections().toArray()).map((c) => c.name))
const has = (n) => names.has(n)

section('2. Shop / catalog (players would see these)')
for (const [coll, field] of [['items', 'name'], ['nfts', 'name'], ['skins', 'name'], ['nftcollections', 'name']]) {
  if (!has(coll)) { console.log(`(no "${coll}" collection)`); continue }
  const docs = await col(coll).find({}, { projection: { [field]: 1, enabled: 1, verified: 1 } }).toArray()
  const bad = docs.filter((d) => TEST_NAME.test(String(d[field] || '')))
  console.log(`${coll}: ${docs.length} total`)
  bad.length ? bad.forEach((d) => flag(`${coll}: "${d[field]}" (id ${d._id})`)) : okLine(`${coll}: no test-looking entries`)
}
if (has('nftmints')) {
  const staleReserved = await col('nftmints').countDocuments({ reservedUntil: { $gt: new Date() } })
  staleReserved ? flag(`nftmints: ${staleReserved} copies currently reserved`) : okLine('nftmints: no active reservations')
  const failed = await col('nftmints').countDocuments({ transferFailed: true })
  failed ? flag(`nftmints: ${failed} failed transfers still unresolved`) : okLine('nftmints: no unresolved failed transfers')
}

section('3. Test accounts and balances (usernames and balances only)')
if (has('users')) {
  const users = await col('users').find({}, { projection: { username: 1, coins: 1, lsvpBalance: 1, role: 1 } }).toArray()
  console.log(`users: ${users.length} total`)
  const bad = users.filter((u) => TEST_USER.test(String(u.username || '')))
  bad.length ? bad.forEach((u) => flag(`test account "${u.username}" coins=${u.coins ?? 0} lsvpBalance=${u.lsvpBalance ?? 0}`)) : okLine('no test accounts')
  const rich = users.filter((u) => (u.lsvpBalance || 0) > 0 && !bad.includes(u))
  console.log(`accounts with a withdrawable LSVP balance: ${rich.length} (review: must be real players only)`)
}

section('4. Test data noise in the admin panel')
for (const [coll, label] of [['anticheatalerts', 'anti-cheat alerts'], ['seasons', 'seasons'], ['seasonscores', 'season scores'],
  ['cashoutrequests', 'cashout requests'], ['jackpottransactions', 'jackpot transactions'], ['energytransactions', 'energy transactions'],
  ['lsvppayments', 'LSVP payments'], ['runresults', 'run results'], ['adminauditlogs', 'admin audit log entries'], ['passwordresettokens', 'password reset tokens'], ['walletlinkchallenges', 'wallet link challenges']]) {
  if (!has(coll)) continue
  const n = await col(coll).countDocuments({})
  n ? flag(`${label}: ${n} records (a clean handover database should be empty or real data only)`) : okLine(`${label}: empty`)
}
if (has('seasons')) (await col('seasons').find({}, { projection: { name: 1, status: 1, startDate: 1, endDate: 1 } }).toArray())
  .forEach((s) => console.log(`   season "${s.name}" ${s.status} ${s.startDate?.toISOString?.().slice(0, 10)} -> ${s.endDate?.toISOString?.().slice(0, 10)}`))

section('5. Settings left over from testing (printed for review against the agreed values)')
for (const coll of ['arenastageconfigs', 'energyconfigs', 'lsvpbuyconfigs', 'payoutconfigs', 'cashoutconfigs', 'jackpotconfigs', 'slotmachineconfigs']) {
  if (!has(coll)) { console.log(`(no "${coll}" document yet: code defaults apply)`); continue }
  const docs = await col(coll).find({}, { projection: { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 } }).toArray()
  docs.forEach((d) => console.log(`${coll}: ${JSON.stringify(d)}`))
}
const stage = has('arenastageconfigs') ? await col('arenastageconfigs').findOne({}) : null
if (stage) {
  const mult = stage.rewardMultipliers || {}
  const flat = Object.keys(mult).length && Object.values(mult).every((v) => v === Object.values(mult)[0])
  if (flat) flag('arena reward multipliers are all identical - looks like a test setting')
  const costs = stage.unlockCosts || {}
  const zero = Object.entries(costs).filter(([, v]) => !(v > 0))
  zero.length ? flag(`arena unlock cost is 0/missing for stages: ${zero.map(([k]) => k).join(', ')}`) : okLine('every arena unlock cost is above zero')
}
const energy = has('energyconfigs') ? await col('energyconfigs').findOne({}) : null
if (energy) {
  const want = { maxEnergy: 10, regenIntervalMinutes: 30, dailyFreeEnergyLimit: 50 }
  for (const [k, v] of Object.entries(want)) energy[k] === v ? okLine(`Energy ${k} = ${v} (agreed)`) : flag(`Energy ${k} = ${energy[k]} (agreed value is ${v})`)
}

console.log(problems ? `\nRESULT: ${problems} leftover item(s) found - NOT ready for handover.` : '\nRESULT: CLEAN - nothing left over.')
await mongoose.disconnect()
process.exit(problems ? 1 : 0)

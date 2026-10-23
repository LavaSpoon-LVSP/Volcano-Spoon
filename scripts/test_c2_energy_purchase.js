// C2 (Energy consumption and purchase concurrency) against the test database named in .env.test.
// Calls the real service functions directly; creates one temporary test user and temporary payment records, then deletes them.
// Run (from Backend/):  node scripts/test_c2_energy_purchase.js     Output is also saved to docs/evidence/C2/C2_energy_purchase.txt
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env.test') })
const { User } = await import('../src/models/User.js')
const { LsvpPayment, claimPaymentAndGrant } = await import('../src/models/LsvpPayment.js')
const { consumeEnergyForRun } = await import('../src/game/EnergyService.js')
const lines = []; const out = s => { console.log(s); lines.push(s) }
const dbName = (process.env.MONGO_URI.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1] || '(none)'
out(`C2 energy + purchase concurrency - ${new Date().toISOString()} - database: ${dbName} (credentials not printed)`)
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 }).catch(e => { console.error('Cannot connect:', e.name); process.exit(1) })
const tag = 'c2ep' + Date.now().toString(36)
const user = await User.create({ username: tag, email: tag + '@example.test', passwordHash: 'x', energy: 1 })
let fails = 0
const check = (name, ok, detail = '') => { out(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' -> ' + detail : ''}`); if (!ok) fails++ }
try {
  // Energy: 1 Energy left, 5 simultaneous run starts
  await User.updateOne({ _id: user._id }, { $set: { energy: 1, unlimitedEnergyUntil: null } })
  const res = await Promise.all([1, 2, 3, 4, 5].map(() => consumeEnergyForRun(user._id)))
  const allowed = res.filter(r => r.allowed).length
  const after = (await User.findById(user._id).select('energy')).energy
  res.forEach((r, i) => out(`  start #${i + 1}: allowed=${r.allowed}${r.reason ? ' reason=' + r.reason : ''}`))
  check('5 simultaneous run starts with 1 Energy: exactly 1 allowed, 4 refused', allowed === 1, `allowed=${allowed}, refused=${5 - allowed}`)
  check('Energy never goes negative', after === 0, `energy after = ${after}`)
  // Energy: 10 Energy, 15 simultaneous starts -> exactly 10 allowed
  await User.updateOne({ _id: user._id }, { $set: { energy: 10 } })
  const res2 = await Promise.all(Array.from({ length: 15 }, () => consumeEnergyForRun(user._id)))
  const allowed2 = res2.filter(r => r.allowed).length
  const after2 = (await User.findById(user._id).select('energy')).energy
  check('15 simultaneous run starts with 10 Energy: exactly 10 allowed', allowed2 === 10, `allowed=${allowed2}, energy after = ${after2}`)
  // Purchase: same payment signature submitted 5 times at once
  let grants = 0
  const sig = 'c2ep-sig-' + tag
  const args = { txSignature: sig, userId: user._id, payerWallet: 'QaTestWallet' + tag, amountLsvp: 1, purpose: 'item_purchase', purposeRefId: 'qa-item', grant: async () => { grants++; await new Promise(r => setTimeout(r, 50)); return { granted: true } }, getGrantedResponse: async () => ({ alreadyGranted: true }) }
  const pres = await Promise.allSettled([1, 2, 3, 4, 5].map(() => claimPaymentAndGrant(args)))
  const granted = pres.filter(p => p.status === 'fulfilled' && p.value?.granted).length
  const dup = pres.filter(p => p.status === 'fulfilled' && p.value?.alreadyGranted).length
  const rows = await LsvpPayment.countDocuments({ txSignature: sig })
  check('same payment submitted 5 times at once: the item is granted exactly once', grants === 1 && granted === 1, `grant() ran ${grants}x, granted responses=${granted}, "already granted" responses=${dup}`)
  check('only one payment record exists for that signature', rows === 1, `records=${rows}`)
  // Purchase: same signature reused for a DIFFERENT purchase is refused
  const other = await claimPaymentAndGrant({ ...args, purposeRefId: 'other-item', grant: async () => { grants++; return { granted: true } } }).then(() => 'accepted', e => `refused (${e.status})`)
  check('the same payment signature cannot be reused for a different purchase', other.startsWith('refused'), other)
} finally {
  await LsvpPayment.deleteMany({ payerWallet: 'QaTestWallet' + tag })
  await User.deleteOne({ _id: user._id })
  out('Test user and test payment records removed.')
  fs.mkdirSync(path.join(root, 'docs/evidence/C2'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/evidence/C2/C2_energy_purchase.txt'), lines.join('\n') + '\n')
  await mongoose.disconnect()
}
out(fails ? `${fails} CHECK(S) FAILED` : 'ALL C2 ENERGY + PURCHASE CHECKS PASSED')
process.exit(fails ? 1 : 0)

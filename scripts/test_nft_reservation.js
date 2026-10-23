// Tests the REAL reservation + retry-decision code (src/solana/nftReservation.js, nftRetryDecision.js)
// against an in-memory stand-in for the NftMint collection. MongoDB makes each findOneAndUpdate on one
// document atomic; this stand-in does the same (single-threaded, no await inside an operation), so it
// proves the LOGIC. Re-run with a real test database before sign-off (see the note at the end).
// Run: node Backend/scripts/test_nft_reservation.js
import { reserveMint, releaseReservation, claimMintForSale, stockSummary, RESERVATION_TTL_MS } from '../src/solana/nftReservation.js'
import { decideRetryAction } from '../src/solana/nftRetryDecision.js'

// ---- minimal Mongo-like model --------------------------------------------------------------------
function matches(doc, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((sub) => matches(doc, sub))
    const x = doc[k] ?? null
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lte' in v) return x !== null && x <= v.$lte
      if ('$gt' in v) return x !== null && x > v.$gt
      if ('$lt' in v) return x !== null && x < v.$lt
      if ('$ne' in v) return x !== v.$ne
    }
    return (x instanceof Date && v instanceof Date) ? x.getTime() === v.getTime() : x === v
  })
}
class FakeMints {
  constructor(docs) { this.docs = docs }
  async findOneAndUpdate(f, u) { const d = this.docs.find((x) => matches(x, f)); if (d) Object.assign(d, u.$set); return d ? { ...d } : null }
  async updateMany(f, u) { this.docs.filter((x) => matches(x, f)).forEach((d) => Object.assign(d, u.$set)) }
  async countDocuments(f) { return this.docs.filter((x) => matches(x, f)).length }
}
const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ mintAddress: 'm' + i, collectionMintAddress: 'C', status: 'published', ownerUserId: null, reservedBy: null, reservedUntil: null, ...extra }))
let fails = 0
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`) }
const t0 = new Date('2026-10-21T12:00:00Z')
const at = (ms) => new Date(t0.getTime() + ms)

console.log('--- 1. Last copy, two buyers at the same moment ---')
{ const NftMint = new FakeMints(mk(1))
  const [a, b] = await Promise.all([reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'A', now: t0 }), reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'B', now: t0 })])
  ok(!!a !== !!b, `exactly one reserved the last copy (A:${!!a}, B:${!!b})`)
  const s = await stockSummary({ NftMint, collectionMintAddress: 'C', userId: 'B', now: t0 })
  ok(s.availableToMe === (b ? 1 : 0) && s.reservedByOthers === (a ? 1 : 0), `shop shows loser: available ${s.availableToMe}, held by others ${s.reservedByOthers}`) }

console.log('\n--- 2. Another buyer cannot buy a reserved copy; the holder can ---')
{ const NftMint = new FakeMints(mk(1)); await reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'A', now: t0 })
  ok((await claimMintForSale({ NftMint, collectionMintAddress: 'C', userId: 'B', now: at(1000) })) === null, 'B (paid, but not the holder) cannot take A\'s reserved copy')
  const sold = await claimMintForSale({ NftMint, collectionMintAddress: 'C', userId: 'A', now: at(2000) })
  ok(sold?.status === 'sold' && sold.ownerUserId === 'A' && sold.reservedBy === null, 'A claims it: sold, owner A, reservation cleared') }

console.log('\n--- 3. Release and expiry ---')
{ const NftMint = new FakeMints(mk(1)); await reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'A', now: t0 })
  await releaseReservation({ NftMint, collectionMintAddress: 'C', userId: 'A' })
  ok(!!(await reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'B', now: at(500) })), 'after A releases, B can reserve')
  const N2 = new FakeMints(mk(1)); await reserveMint({ NftMint: N2, collectionMintAddress: 'C', userId: 'A', now: t0 })
  ok((await reserveMint({ NftMint: N2, collectionMintAddress: 'C', userId: 'B', now: at(RESERVATION_TTL_MS - 1000) })) === null, 'still held 1 s before expiry')
  ok(!!(await reserveMint({ NftMint: N2, collectionMintAddress: 'C', userId: 'B', now: at(RESERVATION_TTL_MS + 1000) })), `a crashed buyer's hold frees itself after ${RESERVATION_TTL_MS / 1000} s`) }

console.log('\n--- 4. One hold per player, extendable ---')
{ const NftMint = new FakeMints(mk(3)); const r1 = await reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'A', now: t0 })
  const r2 = await reserveMint({ NftMint, collectionMintAddress: 'C', userId: 'A', now: at(60000) })
  ok(r2.extended && r1.mint.mintAddress === r2.mint.mintAddress, 'second reserve by A extends the same copy (does not hoard a second)')
  const s = await stockSummary({ NftMint, collectionMintAddress: 'C', userId: 'B', now: at(60000) })
  ok(s.availableToMe === 2 && s.reservedByOthers === 1, `B sees 2 available, 1 held by others`) }

console.log('\n--- 5. 10 buyers, 3 copies, all at once ---')
{ const NftMint = new FakeMints(mk(3)); const users = Array.from({ length: 10 }, (_, i) => 'U' + i)
  const res = await Promise.all(users.map((u) => reserveMint({ NftMint, collectionMintAddress: 'C', userId: u, now: t0 })))
  const won = res.filter(Boolean); ok(won.length === 3 && new Set(won.map((w) => w.mint.mintAddress)).size === 3, `3 reservations, 3 different copies, 7 refused`)
  const claims = await Promise.all(users.map((u) => claimMintForSale({ NftMint, collectionMintAddress: 'C', userId: u, now: at(1000) })))
  ok(claims.filter(Boolean).length === 3, 'only the 3 holders can complete a sale') }

console.log('\n--- 6. Admin retry decision (never double-send) ---')
const final = (success, landed) => async () => ({ success, landed })
{ let d = await decideRetryAction({ lastSignature: 'sigA', getTransferFinalStatus: final(true, true), isHeldByOwner: async () => false })
  ok(d.action === 'mark_delivered', `earlier send landed -> mark delivered, send nothing (${d.why})`)
  d = await decideRetryAction({ lastSignature: 'sigA', getTransferFinalStatus: final(false, null), isHeldByOwner: async () => false })
  ok(d.action === 'uncertain', `earlier send status unknown -> uncertain, send nothing (${d.why})`)
  d = await decideRetryAction({ lastSignature: null, getTransferFinalStatus: final(false, false), isHeldByOwner: async () => true })
  ok(d.action === 'mark_delivered', `no signature but buyer wallet holds the NFT -> mark delivered (${d.why})`)
  d = await decideRetryAction({ lastSignature: 'sigA', getTransferFinalStatus: final(false, false), isHeldByOwner: async () => false })
  ok(d.action === 'send', `provably not landed and not held -> send once (${d.why})`)
  d = await decideRetryAction({ lastSignature: null, getTransferFinalStatus: final(false, false), isHeldByOwner: async () => { throw new Error('rpc down') } })
  ok(d.action === 'uncertain', `wallet read fails -> uncertain, send nothing (${d.why})`) }

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL RESERVATION + RETRY CHECKS PASSED (in-memory model; re-run against a real test MongoDB before sign-off)')
process.exit(fails ? 1 : 0)

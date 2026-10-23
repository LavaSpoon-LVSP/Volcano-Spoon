// Malformed transaction signatures must be refused with a readable reason BEFORE any RPC call.
// Run: node Backend/scripts/test_signature_validation.js   (no database, no network needed)
process.env.SOLANA_NETWORK ||= 'devnet'
const { verifyLsvpPayment } = await import('../src/solana/paymentVerification.js')
let fails = 0
const cases = [
  ['empty string', ''], ['undefined', undefined], ['number', 12345], ['too short', 'abc'], ['wrong length (40 chars)', '1'.repeat(40)],
  ['not base58 (contains 0, O, I, l)', '0OIl'.repeat(22)], ['valid base58 but decodes to 32 bytes', '11111111111111111111111111111111'], ['valid base58 but decodes to 65 bytes', '1'.repeat(65)],
  ['very long (500 chars)', '1'.repeat(500)], ['SQL/JSON-looking', '{"$gt":""}'],
]
for (const [name, sig] of cases) {
  const t0 = Date.now()
  const r = await verifyLsvpPayment({ txSignature: sig, expectedAmountLsvp: 10, payerWallet: '11111111111111111111111111111111' })
  const ok = r.ok === false && typeof r.reason === 'string' && r.reason.length > 0 && !/Invalid param|failed to get/i.test(r.reason) && Date.now() - t0 < 500
  if (!ok) fails++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name.padEnd(48)} -> ok:${r.ok} reason:"${r.reason}" (${Date.now() - t0} ms, no RPC)`)
}
console.log(fails ? `${fails} FAILURE(S)` : 'ALL MALFORMED SIGNATURES REFUSED CLEANLY')
process.exit(fails ? 1 : 0)

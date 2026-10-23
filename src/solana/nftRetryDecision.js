/**
 * Decide what an admin "retry transfer" must do for a paid-for NFT whose
 * delivery is flagged as failed. Pure function (all lookups injected) so the
 * three outcomes are unit-tested without a chain.
 *
 *  - 'mark_delivered': the earlier attempt actually landed (its signature is
 *    final, or the buyer's wallet already holds the NFT). Nothing is sent.
 *  - 'uncertain': the earlier attempt's outcome can't be determined right
 *    now. Nothing is sent; the admin is told to check back.
 *  - 'send': the earlier attempt provably did not land and the buyer does
 *    not hold the NFT; it is safe to send once.
 */
export async function decideRetryAction({ lastSignature, getTransferFinalStatus, isHeldByOwner }) {
  if (lastSignature) {
    const status = await getTransferFinalStatus(lastSignature)
    if (status.success) return { action: 'mark_delivered', signature: lastSignature, why: 'earlier send landed on-chain' }
    if (status.landed === null) return { action: 'uncertain', why: 'earlier send status unknown' }
  }
  let held
  try {
    held = await isHeldByOwner()
  } catch {
    return { action: 'uncertain', why: 'could not read the buyer wallet' }
  }
  if (held) return { action: 'mark_delivered', signature: lastSignature || null, why: 'buyer wallet already holds the NFT' }
  return { action: 'send', why: 'earlier send did not land and the NFT is not in the buyer wallet' }
}

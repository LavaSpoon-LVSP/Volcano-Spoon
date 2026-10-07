import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { connection, adminPublicKey, requireLsvpMint } from '../config/solana.js'
import { lsvpToBaseUnits, getLsvpProgramId } from './tokenService.js'

/**
 * PAYMENT VERIFICATION — for anything a player pays for with LSVP (NFTs,
 * Spoon Skins, Items), the backend never moves LSVP out of the player's
 * wallet itself (it doesn't have their private key, only the admin
 * wallet's). Instead the FRONTEND builds an LSVP transfer from the
 * player's connected wallet to the admin wallet, the player signs it with
 * their own wallet (Phantom/Solflare), and only the resulting transaction
 * signature is sent to the backend. This file is what checks that
 * signature is real before the backend hands over the NFT/skin/item.
 *
 * verifyLsvpPayment() reads the finalized transaction straight from the
 * Solana network and checks the LSVP token balance change it actually
 * caused — never the client's claim of what it did. Specifically it
 * requires that the transaction:
 *   1. Succeeded on-chain (no error)
 *   2. Increased the ADMIN wallet's LSVP balance by exactly the expected
 *      amount
 *   3. Decreased the PAYER wallet's LSVP balance by exactly that same
 *      amount
 *
 * This "read the balance delta" approach is used instead of parsing the
 * transaction's raw instructions because it's far simpler to read and just
 * as reliable — the money either moved from A to B by the right amount, or
 * it didn't, regardless of how the instruction that did it was built.
 *
 * IMPORTANT: this function does NOT protect against the same signature
 * being submitted twice (replaying a valid payment to claim two items). A
 * signature must additionally be recorded as "spent" in the LsvpPayment
 * collection — using its unique index on txSignature — by the caller. See
 * consumeLsvpPayment() below, and routes/blockchainUser.js for how the two
 * are used together.
 */
export async function verifyLsvpPayment({ txSignature, expectedAmountLsvp, payerWallet }) {
  if (!txSignature || typeof txSignature !== 'string') {
    return { ok: false, reason: 'Missing transaction signature' }
  }

  const lsvpMint = requireLsvpMint()
  const expectedBaseUnits = await lsvpToBaseUnits(expectedAmountLsvp)
  const payer = payerWallet instanceof PublicKey ? payerWallet : new PublicKey(payerWallet)

  const tx = await connection.getParsedTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })

  if (!tx) {
    return { ok: false, reason: 'Transaction not found (it may not be confirmed yet — try again in a few seconds)' }
  }
  if (tx.meta?.err) {
    return { ok: false, reason: 'Transaction failed on-chain' }
  }

  const adminDelta = tokenBalanceDelta(tx.meta, lsvpMint, adminPublicKey)
  const payerDelta = tokenBalanceDelta(tx.meta, lsvpMint, payer)

  if (adminDelta !== expectedBaseUnits) {
    return { ok: false, reason: `Payment amount did not match — expected ${expectedAmountLsvp} LSVP to reach the admin wallet` }
  }
  if (payerDelta !== -expectedBaseUnits) {
    return { ok: false, reason: 'Payment did not come from the expected wallet' }
  }

  return { ok: true }
}

/**
 * Reads how much a wallet's balance of `mint` changed in a parsed
 * transaction, in raw base units. 0 if the wallet isn't involved at all.
 */
function tokenBalanceDelta(meta, mint, owner) {
  const ownerKey = owner.toBase58()
  const mintKey = mint.toBase58()

  const pre = (meta?.preTokenBalances ?? []).find((b) => b.mint === mintKey && b.owner === ownerKey)
  const post = (meta?.postTokenBalances ?? []).find((b) => b.mint === mintKey && b.owner === ownerKey)

  const preAmount = pre ? BigInt(pre.uiTokenAmount.amount) : 0n
  const postAmount = post ? BigInt(post.uiTokenAmount.amount) : 0n

  return postAmount - preAmount
}

/** The admin wallet's LSVP associated token account — this is the address the frontend must send LSVP payments to. */
export async function getAdminLsvpDepositAddress() {
  const lsvpMint = requireLsvpMint()
  const programId = await getLsvpProgramId()
  return getAssociatedTokenAddress(lsvpMint, adminPublicKey, false, programId)
}

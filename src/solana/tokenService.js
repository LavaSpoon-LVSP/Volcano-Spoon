import { PublicKey, Transaction } from '@solana/web3.js'
import {
  getMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { connection, adminKeypair, lsvpMint, requireAdminKeypair, requireLsvpMint } from '../config/solana.js'

/**
 * LSVP TOKEN SERVICE — everything that moves the LSVP SPL token. This is the
 * only file in the backend that actually signs and sends an LSVP transfer,
 * so every LSVP payout (LSVP purchased with coins, admin-approved LSVP
 * purchases) goes through the two functions below.
 *
 * All amounts in this file's public functions are in *whole LSVP tokens*
 * (e.g. 25, not 25000000) — the conversion to the token's raw on-chain base
 * units (using its `decimals`) happens internally, once, right before
 * sending. This keeps every caller (routes, admin tools) free of any
 * decimals math.
 *
 * TOKEN-2022 SUPPORT: newer SPL tokens (anything minted with "extensions",
 * e.g. built-in metadata) live under the Token-2022 program instead of the
 * original Token program — two different on-chain programs that look almost
 * identical but are NOT interchangeable; every instruction has to be told
 * which one a given mint belongs to. Rather than assume one or the other
 * (and silently break if the LSVP token is ever reminted under the other
 * program), getLsvpProgramId() below reads it straight off the mint account
 * once and caches it, the same way decimals are cached.
 */

// Cached after the first lookup — a token's decimals and program never change.
let cachedDecimals = null
let cachedProgramId = null

/** Which token program (classic Token, or Token-2022) the LSVP mint actually belongs to. */
async function getLsvpProgramId() {
  if (cachedProgramId) return cachedProgramId
  const mint = requireLsvpMint()
  const accountInfo = await connection.getAccountInfo(mint)
  if (!accountInfo) {
    throw new Error(`LSVP mint ${mint.toBase58()} was not found on-chain — check LSVP_TOKEN_MINT_* in .env`)
  }
  cachedProgramId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  return cachedProgramId
}

async function getLsvpDecimals() {
  if (cachedDecimals !== null) return cachedDecimals
  const mint = requireLsvpMint()
  const programId = await getLsvpProgramId()
  const mintInfo = await getMint(connection, mint, 'confirmed', programId)
  cachedDecimals = mintInfo.decimals
  return cachedDecimals
}

/** Converts a whole-token amount (e.g. 25 LSVP) to the mint's raw base-unit amount, as a BigInt. */
export async function lsvpToBaseUnits(amountLsvp) {
  if (!Number.isInteger(amountLsvp) || amountLsvp <= 0) {
    throw new Error('LSVP amount must be a positive whole number')
  }
  const decimals = await getLsvpDecimals()
  return BigInt(amountLsvp) * 10n ** BigInt(decimals)
}

/** Converts a raw base-unit amount back to whole LSVP tokens (used when reading balances off-chain). */
export async function baseUnitsToLsvp(baseUnits) {
  const decimals = await getLsvpDecimals()
  return Number(BigInt(baseUnits) / 10n ** BigInt(decimals))
}

/**
 * Transfers `amountLsvp` whole LSVP tokens from the admin wallet to
 * `destinationWallet` (a PublicKey). Creates the destination's LSVP token
 * account if it doesn't have one yet — the admin wallet pays the small
 * one-time rent for that account, same as it pays the transaction fee.
 *
 * Returns the transaction signature. Throws if the admin wallet doesn't
 * hold enough LSVP, or isn't configured.
 */
export async function transferLsvpFromAdmin(destinationWallet, amountLsvp) {
  const admin = requireAdminKeypair()
  const mint = requireLsvpMint()
  const programId = await getLsvpProgramId()
  const destination = destinationWallet instanceof PublicKey ? destinationWallet : new PublicKey(destinationWallet)

  const adminTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, admin.publicKey, false, 'confirmed', undefined, programId
  )
  const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, destination, false, 'confirmed', undefined, programId
  )

  const baseUnits = await lsvpToBaseUnits(amountLsvp)
  const decimals = await getLsvpDecimals()

  const instruction = createTransferCheckedInstruction(
    adminTokenAccount.address,
    mint,
    destinationTokenAccount.address,
    admin.publicKey, // authority — the admin wallet owns the source account
    baseUnits,
    decimals,
    [],
    programId
  )

  return sendSignedTransfer(admin, [instruction])
}

/**
 * UNCERTAIN-TRANSFER SAFETY — shared by every LSVP/NFT transfer this file
 * signs and sends. Builds and signs the transaction FIRST, which fixes its
 * signature deterministically before it's ever broadcast, then sends and
 * confirms it.
 *
 * Why this matters: the old code used @solana/spl-token's transferChecked
 * helper, which builds, signs, sends AND confirms in one call and only
 * ever hands back a signature on success. If the confirm step times out or
 * the RPC connection drops — which does not mean the transaction failed,
 * Solana transactions can and do land on-chain after a client stops
 * watching for them — the caller only ever saw a thrown error and had no
 * signature to check, so every call site's failure handling (refund coins,
 * flag an NFT for admin retry) assumed "definitely never sent" when the
 * truth was "unknown, possibly sent". Refunding or retrying on top of a
 * transfer that actually landed is a real double-payout risk.
 *
 * Signing locally first means the signature is known and attached to the
 * thrown error even when send/confirm fails, so every caller can (and now
 * does — see getTransferFinalStatus below) check that exact signature's
 * real on-chain status before deciding to refund or retry anything.
 */
export async function sendSignedTransfer(admin, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const transaction = new Transaction({ feePayer: admin.publicKey, blockhash, lastValidBlockHeight })
  for (const instruction of instructions) transaction.add(instruction)
  transaction.sign(admin)

  const signature = bs58.encode(transaction.signature)

  try {
    const rawTransaction = transaction.serialize()
    await connection.sendRawTransaction(rawTransaction, { skipPreflight: false })
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  } catch (error) {
    // Attach the signature so a caller that only sees this thrown error
    // can still look up what actually happened — see getTransferFinalStatus.
    error.signature = signature
    throw error
  }

  return signature
}

/**
 * Independently checks whether a transaction signature actually landed and
 * succeeded on-chain, regardless of what the client that sent it saw.
 * Callers use this after a send/confirm failure (a timeout, a dropped RPC
 * connection — see sendSignedTransfer above) to tell "definitely never
 * sent" apart from "sent, we just lost the confirmation" BEFORE refunding
 * coins or retrying a transfer — retrying one that already landed would
 * send the same payout twice.
 *
 * Returns { landed, success, err }:
 *   - landed: true once the signature is confirmed on-chain at all
 *     (whether it succeeded or failed on-chain), false if it's genuinely
 *     not found, null if the check itself couldn't complete (treat this as
 *     "still unknown" — do NOT refund/retry on a null result either).
 *   - success: true only if it landed AND had no on-chain error.
 */
export async function getTransferFinalStatus(signature) {
  if (!signature) return { landed: false, success: false, err: null }
  try {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    const info = status?.value
    if (!info) return { landed: false, success: false, err: null }
    const confirmed = info.confirmationStatus === 'confirmed' || info.confirmationStatus === 'finalized'
    return { landed: confirmed, success: confirmed && !info.err, err: info.err ?? null }
  } catch (error) {
    return { landed: null, success: null, err: null, checkError: error.message }
  }
}

/** Reads the admin wallet's current LSVP balance (whole tokens) — used by the admin dashboard as a sanity check before approving payouts. */
export async function getAdminLsvpBalance() {
  const admin = requireAdminKeypair()
  const mint = requireLsvpMint()
  const programId = await getLsvpProgramId()
  const adminTokenAddress = await getAssociatedTokenAddress(mint, admin.publicKey, false, programId)
  try {
    const account = await connection.getTokenAccountBalance(adminTokenAddress)
    return Number(account.value.uiAmount ?? 0)
  } catch {
    // No token account yet == balance of zero, not an error.
    return 0
  }
}

/** Reads any wallet's LSVP balance (whole tokens) — used to show a player their real on-chain balance. */
export async function getWalletLsvpBalance(walletAddress) {
  const mint = requireLsvpMint()
  const programId = await getLsvpProgramId()
  const owner = walletAddress instanceof PublicKey ? walletAddress : new PublicKey(walletAddress)
  const tokenAddress = await getAssociatedTokenAddress(mint, owner, false, programId)
  try {
    const account = await connection.getTokenAccountBalance(tokenAddress)
    return Number(account.value.uiAmount ?? 0)
  } catch {
    return 0
  }
}

/** Exposed so other Solana files (payment verification, the /config route) can build the LSVP ATA address without duplicating the Token-2022 detection above. */
export { getLsvpProgramId }

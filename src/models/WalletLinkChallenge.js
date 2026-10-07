import mongoose from 'mongoose'
import crypto from 'crypto'

/**
 * A short-lived, single-use signing challenge for proving a player
 * actually controls a Solana wallet's private key before it's linked to
 * their account — see routes/blockchainUser.js's POST /wallet/challenge
 * (creates one) and POST /wallet/link (atomically consumes one after
 * verifying an ed25519 signature over its exact `message`).
 *
 * WHY THIS EXISTS: every purchase/claim route used to accept a
 * `walletAddress` in the request body and silently (re)link it to the
 * account on every call, via linkWalletAddress() — never proving the
 * caller actually held that wallet's key, just that they could type/paste
 * an address. That meant a request forged with someone else's public
 * address (trivially discoverable — it's public) could redirect their own
 * future payouts to an attacker-controlled wallet. This challenge is what
 * "linking or changing a wallet requires a valid signature" means: the
 * player's own wallet (Phantom/Solflare) has to sign this exact message —
 * which never leaves their device's private key, costs nothing, and is
 * not a blockchain transaction — before the backend will link it.
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes — long enough to approve a wallet-app signing popup, short enough that a stale, never-signed challenge can't be replayed much later.

const walletLinkChallengeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    walletAddress: {
      type: String,
      required: true,
    },

    nonce: {
      type: String,
      required: true,
      unique: true,
    },

    // The exact text the player's wallet must sign — stored so POST
    // /wallet/link can verify the signature against precisely what was
    // issued, rather than reconstructing it (and risking a mismatch if
    // this file's message format ever changes between issue and verify).
    message: {
      type: String,
      required: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      // TTL index — Mongo garbage-collects expired/used challenges on its
      // own; POST /wallet/link also re-checks expiresAt itself rather than
      // relying on the TTL sweep's timing (same pattern as
      // PasswordResetToken.js).
      index: { expires: 0 },
    },

    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const WalletLinkChallenge = mongoose.model('WalletLinkChallenge', walletLinkChallengeSchema)

/**
 * Issues a fresh challenge for (userId, walletAddress), first invalidating
 * any previous still-unused challenge for this exact pair — so only the
 * most recently requested signing prompt is ever valid, and an old,
 * forgotten browser tab can't complete a stale link.
 */
export async function createWalletLinkChallenge(userId, walletAddress) {
  await WalletLinkChallenge.deleteMany({ userId, walletAddress, usedAt: null })

  const nonce = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  const message =
    'Link this wallet to your VolcanoSpoon account.\n\n' +
    `Wallet: ${walletAddress}\n` +
    `Nonce: ${nonce}\n` +
    `Expires: ${expiresAt.toISOString()}\n\n` +
    'This only proves you hold this wallet — it is not a transaction and costs nothing.'

  return WalletLinkChallenge.create({ userId, walletAddress, nonce, message, expiresAt })
}

/**
 * Atomically claims a challenge by (userId, walletAddress, nonce) — the
 * same optimistic-concurrency "claim" pattern this codebase already uses
 * for password-reset tokens (see models/PasswordResetToken.js):
 * findOneAndUpdate matching the still-unused, still-unexpired state and
 * setting usedAt in that same operation, so a signature can never be
 * verified against (and consumed) more than once. Returns the claimed
 * challenge document, or null if it's missing, expired, or already used —
 * callers should treat null as "start over: request a new challenge".
 */
export async function claimWalletLinkChallenge({ userId, walletAddress, nonce }) {
  return WalletLinkChallenge.findOneAndUpdate(
    { userId, walletAddress, nonce, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  )
}

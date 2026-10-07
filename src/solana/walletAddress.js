import { PublicKey } from '@solana/web3.js'
import { User } from '../models/User.js'

/**
 * Returns true if `value` is a syntactically valid Solana wallet/public
 * address (base58, correct length) — does NOT check that the address has
 * ever been used or holds anything. Used to validate a wallet address a
 * player types in / a wallet extension reports before we save it.
 */
export function isValidSolanaAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    // PublicKey throws on anything that isn't a valid base58 32-byte key.
    new PublicKey(value.trim())
    return true
  } catch {
    return false
  }
}

/** Parses a wallet address string into a PublicKey, or throws a friendly error. */
export function parseWalletAddress(value, label = 'wallet address') {
  if (!isValidSolanaAddress(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return new PublicKey(value.trim())
}

/**
 * Links `walletAddress` to `userId` if it isn't already. Only ever called
 * from ONE place now: routes/blockchainUser.js's POST /wallet/link, after
 * it has independently verified an ed25519 signature over a server-issued,
 * single-use challenge (see models/WalletLinkChallenge.js) — proving the
 * caller actually holds that wallet's private key.
 *
 * This used to be called directly from the request body's `walletAddress`
 * on every purchase/claim route (blockchainUser.js, energy.js, jackpot.js,
 * slotMachine.js, arenaStages.js) with NO signature check at all — a
 * player could send any public address (trivially discoverable; wallet
 * addresses aren't secret) and it would silently become the account's
 * linked wallet, redirecting future payouts there. Every one of those
 * routes now requires `User.solanaWalletAddress` to already be set (via
 * this signed flow) before it will act, and only cross-checks a
 * request-supplied walletAddress against it rather than using it to relink.
 *
 * Returns the address now on file (unchanged if it already matched). Throws
 * an Error with a `.status` (400/409) on a bad or already-claimed address.
 */
export async function linkWalletAddress(userId, walletAddress) {
  walletAddress = walletAddress?.trim()
  if (!walletAddress) {
    const error = new Error('No wallet address provided')
    error.status = 400
    throw error
  }
  if (!isValidSolanaAddress(walletAddress)) {
    const error = new Error('That does not look like a valid Solana wallet address')
    error.status = 400
    throw error
  }

  const current = await User.findById(userId).select('solanaWalletAddress')
  if (current?.solanaWalletAddress === walletAddress) {
    return walletAddress // already linked to this same wallet — nothing to do
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { solanaWalletAddress: walletAddress } },
      { new: true }
    ).select('solanaWalletAddress')
    return user.solanaWalletAddress
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error('That wallet is already linked to another account')
      conflict.status = 409
      throw conflict
    }
    throw error
  }
}

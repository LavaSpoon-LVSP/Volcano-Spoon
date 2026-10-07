import express from 'express'
import { User } from '../models/User.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { getWalletLsvpBalance } from '../solana/tokenService.js'

/**
 * Builds the /api/cashout router.
 *
 * The Lava Coin -> LSVP Token CONVERSION feature that used to live here
 * (submit a request, get auto-approved or wait on an admin, real on-chain
 * LSVP sent to your wallet) was removed — "Buy LSVP" (routes/blockchainUser.js's
 * /lsvp/buy + LsvpBuyPanel.jsx) does the exact same conversion and was kept
 * instead, so having both was pure duplication. See CashoutRequest.js /
 * CashoutConfig.js for the now-unused models this left behind (kept as
 * historical data, not deleted).
 *
 * What's left is just GET /me — this is the one place several pages
 * (Game.jsx's navbar wallet, ProfilePage, Arena Select's affordability
 * check) read the player's real balances from, so it stays even though the
 * conversion flow it was originally built alongside is gone.
 */
export function createCashoutRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * GET /api/cashout/me
   * Auth required — this player's Lava Coin balance and real on-chain LSVP
   * balance (of their linked wallet), plus the linked wallet address.
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('coins solanaWalletAddress')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      // Real on-chain balance of the player's LINKED wallet — not the old
      // off-chain ledger number.
      const lsvpBalance = user.solanaWalletAddress ? await getWalletLsvpBalance(user.solanaWalletAddress) : 0

      res.json({
        lavaCoins: user.coins || 0,
        lsvpBalance,
        walletAddress: user.solanaWalletAddress,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

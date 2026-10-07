import express from 'express'
import { User } from '../models/User.js'
import { EnergyTransaction } from '../models/EnergyTransaction.js'
import { getEnergyConfig, updateEnergyConfig } from '../models/EnergyConfig.js'
import { settleUserEnergy, purchaseEnergy } from '../game/EnergyService.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'

/**
 * Builds the /api/energy router — the Daily Energy System (additive
 * anti-farming feature). Does not touch existing gameplay/rewards/NFTs/LSVP
 * systems; it only limits and monetizes how many game runs a player starts
 * per day.
 *
 * GET  /me                → auth: current energy state (for the UI's
 *                            Energy section — current/max, next regen time,
 *                            unlimited timer, purchase costs)
 * POST /purchase           → auth: spend LSVP for +5 / +10 / Unlimited Hour
 * GET  /admin/config       → admin: full config
 * PUT  /admin/config       → admin: update config
 *
 * Actually starting/consuming a run is NOT done through this router — that
 * happens server-side inside ClientSession.js at 'game:start'/'game:restart'
 * (the WebSocket message that begins a run), via EnergyService.consumeEnergyForRun,
 * so it can never be bypassed by calling a REST endpoint directly.
 *
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — synced immediately after a
 *   purchase so a connected player's HUD updates without a reconnect.
 */
export function createEnergyRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSession(userId) {
    const session = sessions?.get(String(userId))
    if (session?.pushEnergyState) void session.pushEnergyState()
  }

  /**
   * GET /api/energy/me
   * Auth required — settles regen/daily-reset first (so the returned value
   * is always current, even if the player hasn't started a run since
   * yesterday) then returns the full Energy section payload.
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const state = await settleUserEnergy(req.user.sub)
      if (!state) return res.status(404).json({ message: 'User not found' })
      res.json({ energy: state })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/energy/purchase
   * Auth required — body: { type: 'five' | 'ten' | 'unlimited', txSignature,
   * walletAddress }. Pays for +5 Energy, +10 Energy, or Unlimited Energy
   * for 1 Hour with real on-chain LSVP — same pattern as the Jackpot Orb /
   * Arena Stage purchases: the frontend already sent an LSVP transfer from
   * the player's connected wallet to the admin wallet (payLsvpToAdmin) and
   * hands us the resulting signature here, which is independently verified
   * on-chain before any Energy is granted.
   */
  router.post('/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    try {
      const type = String(req.body?.type ?? '')
      if (!['five', 'ten', 'unlimited'].includes(type)) {
        return res.status(400).json({ message: "type must be 'five', 'ten', or 'unlimited'" })
      }

      // Wallet must already be linked AND verified (see
      // routes/blockchainUser.js's POST /wallet/challenge + /wallet/link)
      // — this route used to silently (re)link whatever address the
      // request body claimed with no proof of ownership. See
      // solana/walletAddress.js's doc comment.
      const user = await User.findById(userId).select('solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before purchasing' })
      }
      if (req.body?.walletAddress && req.body.walletAddress !== user.solanaWalletAddress) {
        return res.status(400).json({ message: 'The connected wallet does not match your linked wallet' })
      }
      const walletAddress = user.solanaWalletAddress

      const config = await getEnergyConfig()
      const cost = type === 'five' ? config.lsvpCostFive
        : type === 'ten' ? config.lsvpCostTen
        : config.lsvpCostUnlimitedHour
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(500).json({ message: 'Energy purchase cost is not configured' })
      }

      // Block (don't just silently no-op) a +5/+10 purchase that would add
      // nothing — Energy is already capped at maxEnergy — BEFORE any
      // payment is verified/claimed below, so the player's LSVP is never
      // spent for zero benefit (handover doc: "Block or explain a purchase
      // that would grant nothing at full capacity"). Unlimited Energy is
      // exempt: buying/stacking time is meaningful even at full Energy,
      // since it's a separate mechanism (see purchaseEnergy's 'unlimited'
      // branch) that keeps paying off after Energy itself would otherwise
      // cap out.
      // Both the +5 and +10 Energy packs are reserved for a low tank: the
      // purchase is only allowed once Energy has dropped to
      // ENERGY_PURCHASE_MAX_THRESHOLD or below (handover: "Energy needs to
      // be 5 or below to buy 5 Energy", applies to both the 5 and 10 pack).
      // This is strictly tighter than the full-tank guard below (since
      // maxEnergy is always >= this threshold), but we keep the full-tank
      // guard in place too as an explicit belt-and-suspenders check so a
      // purchase can never slip through at a full tank even if this
      // threshold is ever reconfigured above maxEnergy.
      const ENERGY_PURCHASE_MAX_THRESHOLD = 5
      if (type === 'five' || type === 'ten') {
        const currentState = await settleUserEnergy(userId)
        if (currentState && currentState.energy >= currentState.maxEnergy) {
          return res.status(400).json({
            message: `Energy is already full (${currentState.maxEnergy}/${currentState.maxEnergy}) — this purchase would not add anything.`,
          })
        }
        if (currentState && currentState.energy > ENERGY_PURCHASE_MAX_THRESHOLD) {
          return res.status(400).json({
            message: `Your Energy needs to be ${ENERGY_PURCHASE_MAX_THRESHOLD} or below to buy 5 Energy or 10 Energy (currently ${currentState.energy}/${currentState.maxEnergy}).`,
          })
        }
      }

      const txSignature = req.body?.txSignature

      const grant = async () => {
        const result = await purchaseEnergy(userId, type)
        if (!result.success) {
          const error = new Error(result.message)
          error.status = 400
          throw error
        }
        syncLiveSession(userId)
        const state = await settleUserEnergy(userId)
        return { message: 'Energy purchase successful', energy: state }
      }

      // cost of 0 means this purchase type is free right now — skip
      // payment verification/claiming entirely and just grant directly.
      if (cost <= 0) {
        return res.json(await grant())
      }

      const verification = await verifyLsvpPayment({
        txSignature,
        expectedAmountLsvp: cost,
        payerWallet: walletAddress,
      })
      if (!verification.ok) {
        return res.status(400).json({ message: verification.reason })
      }

      // claimPaymentAndGrant makes this "pay, then credit Energy" sequence
      // safe to retry with the same signature — see its doc comment in
      // models/LsvpPayment.js. A request that died between claiming the
      // payment and crediting Energy used to leave a player permanently
      // paid-but-empty-handed (a 409 "already used" forever after).
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: walletAddress,
        amountLsvp: cost,
        purpose: 'energy_purchase',
        purposeRefId: type,
        grant,
        getGrantedResponse: async () => {
          const state = await settleUserEnergy(userId)
          return { message: 'Energy purchase successful', energy: state }
        },
      })

      res.json(result)
    } catch (error) {
      if (error?.status === 409 || error?.status === 400) {
        return res.status(error.status).json({ message: error.message })
      }
      console.error(`Energy purchase error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/energy/history
   * Auth required — this user's recent Energy transactions (consume,
   * purchase, regen, daily reset), for the profile/Energy section.
   */
  router.get('/history', auth, async (req, res) => {
    try {
      const history = await EnergyTransaction.find({ userId: req.user.sub })
        .sort({ createdAt: -1 })
        .limit(20)
      res.json({
        history: history.map((h) => ({
          id: String(h._id),
          type: h.type,
          purchaseType: h.purchaseType,
          lsvpSpent: h.lsvpSpent,
          energyAfter: h.energyAfter,
          createdAt: h.createdAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/energy/admin/config
   * Admin only — full live config for the Energy Management admin section.
   */
  router.get('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const config = await getEnergyConfig()
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/energy/admin/config
   * Admin only — update any subset of: maxEnergy, regenEnabled,
   * regenIntervalMinutes, dailyResetEnabled, dailyResetTimezone,
   * lsvpCostFive, lsvpCostTen, lsvpCostUnlimitedHour.
   */
  router.put('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {}
      const patch = {}

      if (body.maxEnergy !== undefined) {
        const n = Number(body.maxEnergy)
        if (!Number.isFinite(n) || n < 1) return res.status(400).json({ message: 'maxEnergy must be at least 1' })
        patch.maxEnergy = n
      }
      if (body.regenEnabled !== undefined) patch.regenEnabled = Boolean(body.regenEnabled)
      if (body.regenIntervalMinutes !== undefined) {
        const n = Number(body.regenIntervalMinutes)
        if (!Number.isFinite(n) || n < 1) return res.status(400).json({ message: 'regenIntervalMinutes must be at least 1' })
        patch.regenIntervalMinutes = n
      }
      if (body.dailyResetEnabled !== undefined) patch.dailyResetEnabled = Boolean(body.dailyResetEnabled)
      if (body.dailyResetTimezone !== undefined) {
        const tz = String(body.dailyResetTimezone)
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: tz }) // throws if invalid
        } catch {
          return res.status(400).json({ message: `Unknown timezone: ${tz}` })
        }
        patch.dailyResetTimezone = tz
      }
      // Whole LSVP Tokens only — see utils/lsvpPricing.js.
      if (body.lsvpCostFive !== undefined) {
        if (!isWholeTokenAmount(body.lsvpCostFive, { allowZero: true })) {
          return res.status(400).json({ message: 'lsvpCostFive must be a whole number of LSVP Tokens (zero or more)' })
        }
        patch.lsvpCostFive = Number(body.lsvpCostFive)
      }
      if (body.lsvpCostTen !== undefined) {
        if (!isWholeTokenAmount(body.lsvpCostTen, { allowZero: true })) {
          return res.status(400).json({ message: 'lsvpCostTen must be a whole number of LSVP Tokens (zero or more)' })
        }
        patch.lsvpCostTen = Number(body.lsvpCostTen)
      }
      if (body.lsvpCostUnlimitedHour !== undefined) {
        if (!isWholeTokenAmount(body.lsvpCostUnlimitedHour, { allowZero: true })) {
          return res.status(400).json({ message: 'lsvpCostUnlimitedHour must be a whole number of LSVP Tokens (zero or more)' })
        }
        patch.lsvpCostUnlimitedHour = Number(body.lsvpCostUnlimitedHour)
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const config = await updateEnergyConfig(patch)
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createEnergyRouter

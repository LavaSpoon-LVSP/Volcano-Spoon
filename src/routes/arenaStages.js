import express from 'express'
import { User } from '../models/User.js'
import {
  getArenaEconomyConfig,
  updateArenaStageUnlockCost,
  updateArenaRewardMultiplier,
  updateArenaRareOrbChance,
} from '../models/ArenaStageConfig.js'
import { ARENA_STAGE_COUNT, ARENA_STAGE_CONFIGS, isValidArenaStage } from '../game/arenaStages.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'

/**
 * Builds the /api/arena-stages router — the Arena Stages progression +
 * economy system. Purely additive: doesn't touch existing gameplay,
 * auth, or navigation. Reads/writes only the User.unlockedArenaStages /
 * User.currentArenaStage / User.lsvpBalance fields plus the
 * ArenaStageConfig singleton (unlock costs, reward multipliers, rare orb
 * chances — all admin-configurable, see PUT/GET /admin/config below).
 *
 * Unlock order is strictly sequential — a user can only ever unlock
 * `Math.max(...unlockedArenaStages) + 1`. Unlocking is a ONE-TIME LSVP
 * Token payment per account: once a stage is in unlockedArenaStages it
 * stays there forever — that stage's reward multiplier and rare orb
 * chance apply every time the player plays it, with no repeat payment.
 *
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — if provided, a connected
 *   player's in-memory GameLogic stage/economy config is kept in sync
 *   immediately after a select/unlock instead of waiting for their next
 *   reconnect.
 */
export function createArenaStagesRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSession(userId, stage, economy) {
    const session = sessions?.get(String(userId))
    if (session?.game?.setArenaStage) {
      // The current GameLogic class only takes the stage number now (its
      // economy-override 2nd argument was dropped when the deterministic-
      // replay work replaced this file with the live client's own
      // GameLogic -- see ClientSession.js's setArenaStage call sites for
      // the same fix). lavaCoinMultiplier is still real (applied post-hoc
      // in ClientSession.saveCoins()), so it's attached directly instead;
      // rareOrbChance is dropped -- nothing in the current OrbSystem/
      // GameLogic ever reads it, confirmed unused even before this change.
      session.game.setArenaStage(stage)
      session.game.stageConfig = { lavaCoinMultiplier: economy?.rewardMultipliers?.[String(stage)] }
    }
  }

  /**
   * Stage 1 must ALWAYS be unlocked, for every account, no exceptions.
   * Some accounts never actually got `unlockedArenaStages: [1]` persisted
   * to MongoDB (Mongoose's schema default only exists in memory until the
   * document is saved — it's never written back just from being read), so
   * a raw `$addToSet` on that field can create it from scratch as e.g.
   * `[2]`, silently losing stage 1. Every read of unlockedArenaStages goes
   * through this normalizer so that can never lock a player out of Stage 1
   * again, regardless of what's actually stored in the DB.
   */
  function normalizeUnlockedStages(unlockedStages) {
    const stages = Array.isArray(unlockedStages) ? unlockedStages : []
    return Array.from(new Set([1, ...stages])).sort((a, b) => a - b)
  }

  function serializeStages(unlockedStages, currentStage, economy) {
    const maxUnlocked = Math.max(...unlockedStages, 1)
    return ARENA_STAGE_CONFIGS.map((cfg) => {
      const unlocked = unlockedStages.includes(cfg.stage)
      return {
        stage: cfg.stage,
        name: cfg.name,
        unlocked,
        active: cfg.stage === currentStage,
        // Only the very next sequential stage is unlockable right now.
        isNextToUnlock: !unlocked && cfg.stage === maxUnlocked + 1,
        // Unlock fee is a ONE-TIME LSVP Token payment — null once unlocked.
        unlockCost: unlocked ? null : (economy.unlockCosts[String(cfg.stage)] ?? null),
        rewardMultiplier: economy.rewardMultipliers[String(cfg.stage)] ?? 1,
        rareOrbChance: economy.rareOrbChances[String(cfg.stage)] ?? 0,
        // Which powerup-style orbs (shield/combo/magnet/rose/health/freeze/
        // gravity) this stage can actually spawn — see arenaStages.js's
        // stagePowerupRoster/POWERUP_MIN_STAGE, the same list OrbSystem's
        // spawn gating reads from. Was previously only shown via an in-game
        // HUD legend; now surfaced here so the Arena Select screen can show
        // it before the player commits to a stage. Copied (not the frozen
        // original) so nothing downstream can mutate ARENA_STAGE_CONFIGS.
        availablePowerupTypes: [...cfg.availablePowerups],
      }
    })
  }

  /**
   * GET /api/arena-stages/me
   * Auth required — this user's full stage list (locked/unlocked/active,
   * unlock cost in LSVP, reward multiplier, rare orb chance), plus their
   * current Lava Coin balance. LSVP affordability is judged against the
   * player's real on-chain wallet balance (see /api/cashout/me), not
   * anything returned from here — unlock costs are paid on-chain (see
   * POST /unlock below).
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('coins unlockedArenaStages currentArenaStage')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const unlockedStages = normalizeUnlockedStages(user.unlockedArenaStages)
      const currentStage = user.currentArenaStage || 1
      const economy = await getArenaEconomyConfig()

      res.json({
        lavaCoins: user.coins || 0,
        currentStage,
        unlockedStages,
        stages: serializeStages(unlockedStages, currentStage, economy),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/arena-stages/unlock
   * Auth required — unlock the next sequential Arena Stage using real
   * on-chain LSVP. Same pattern as buying an NFT/Jackpot Orb: the frontend
   * already sent an LSVP transfer from the player's connected wallet to the
   * admin wallet (payLsvpToAdmin) and hands us the signature here.
   * Body: { stage: number, txSignature: string, walletAddress: string }
   *
   * This is a ONE-TIME payment — once unlocked, a stage never needs to be
   * paid for again on this account. Server-side only: sequencing and cost
   * are always re-validated against the DB — the client's displayed
   * cost/eligibility is for display only.
   */
  router.post('/unlock', auth, async (req, res) => {
    const userId = req.user.sub
    try {
      const stage = Number(req.body?.stage)
      const txSignature = req.body?.txSignature

      if (!isValidArenaStage(stage) || stage < 2 || stage > ARENA_STAGE_COUNT) {
        return res.status(400).json({ message: `Stage must be between 2 and ${ARENA_STAGE_COUNT}` })
      }

      // Wallet must already be linked AND verified (see
      // routes/blockchainUser.js's POST /wallet/challenge + /wallet/link)
      // — this route used to silently (re)link whatever address the
      // request body claimed with no proof of ownership. See
      // solana/walletAddress.js's doc comment.
      const user = await User.findById(userId).select('unlockedArenaStages solanaWalletAddress')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }
      if (!user.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before purchasing' })
      }
      if (req.body?.walletAddress && req.body.walletAddress !== user.solanaWalletAddress) {
        return res.status(400).json({ message: 'The connected wallet does not match your linked wallet' })
      }
      const walletAddress = user.solanaWalletAddress

      const unlockedStages = normalizeUnlockedStages(user.unlockedArenaStages)
      const maxUnlocked = Math.max(...unlockedStages)

      if (unlockedStages.includes(stage)) {
        return res.status(409).json({ message: `Arena Stage ${stage} is already unlocked` })
      }

      // Strictly sequential — no skipping stages.
      if (stage !== maxUnlocked + 1) {
        return res.status(400).json({
          message: `You must unlock Arena Stage ${maxUnlocked + 1} before Arena Stage ${stage}`,
        })
      }

      const economy = await getArenaEconomyConfig()
      const cost = economy.unlockCosts[String(stage)]
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(500).json({ message: 'Unlock cost is not configured for this stage' })
      }

      const grant = async () => {
        // $each: [1, stage] (not just `stage`) also self-heals any account
        // whose unlockedArenaStages never actually had [1] persisted to
        // the DB (see normalizeUnlockedStages above).
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $addToSet: { unlockedArenaStages: { $each: [1, stage] } } },
          { new: true }
        )
        return {
          unlockedStages: normalizeUnlockedStages(updatedUser.unlockedArenaStages),
          stage,
          message: `Arena Stage ${stage} unlocked!`,
        }
      }

      // cost of 0 means this stage is free right now — skip payment
      // verification/claiming entirely and just grant directly.
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

      // claimPaymentAndGrant makes this "pay, then unlock the stage"
      // sequence safe to retry with the same signature — see its doc
      // comment in models/LsvpPayment.js.
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: walletAddress,
        amountLsvp: cost,
        purpose: 'arena_stage_unlock',
        purposeRefId: String(stage),
        grant,
        getGrantedResponse: async () => {
          const current = await User.findById(userId).select('unlockedArenaStages')
          return {
            unlockedStages: normalizeUnlockedStages(current?.unlockedArenaStages),
            stage,
            message: `Arena Stage ${stage} unlocked!`,
          }
        },
      })

      res.json(result)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      console.error(`Arena Stage unlock error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/arena-stages/select
   * Auth required — set which unlocked stage is active for this user's
   * next game session. Body: { stage: number }
   */
  router.post('/select', auth, async (req, res) => {
    try {
      const userId = req.user.sub
      const stage = Number(req.body?.stage)

      if (!isValidArenaStage(stage)) {
        return res.status(400).json({ message: `Stage must be between 1 and ${ARENA_STAGE_COUNT}` })
      }

      const user = await User.findById(userId).select('unlockedArenaStages')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const unlockedStages = normalizeUnlockedStages(user.unlockedArenaStages)
      if (!unlockedStages.includes(stage)) {
        return res.status(403).json({ message: `Arena Stage ${stage} is locked` })
      }

      // Self-heal: also persist stage 1 into the DB array if it was
      // missing (see normalizeUnlockedStages), so future reads don't need
      // to rely on this in-memory patch.
      await User.findByIdAndUpdate(userId, {
        $set: { currentArenaStage: stage },
        $addToSet: { unlockedArenaStages: 1 },
      })

      const economy = await getArenaEconomyConfig()
      syncLiveSession(userId, stage, economy)

      res.json({ currentStage: stage })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/arena-stages/admin/config
   * Admin only — the full per-stage economy config (unlock costs, reward
   * multipliers, rare orb chances) for editing in the admin dashboard.
   */
  router.get('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const economy = await getArenaEconomyConfig()
      const stages = ARENA_STAGE_CONFIGS.map((cfg) => ({
        stage: cfg.stage,
        unlockCost: cfg.stage === 1 ? null : (economy.unlockCosts[String(cfg.stage)] ?? null),
        rewardMultiplier: economy.rewardMultipliers[String(cfg.stage)] ?? 1,
        rareOrbChance: economy.rareOrbChances[String(cfg.stage)] ?? 0,
      }))
      res.json({ stages })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/arena-stages/admin/config
   * Admin only — update one stage's unlock cost (LSVP), reward multiplier,
   * and/or rare orb chance (%). Any combination of the three may be
   * provided; omitted fields are left unchanged.
   * Body: { stage: number, unlockCost?: number, rewardMultiplier?: number, rareOrbChance?: number }
   */
  router.put('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const stage = Number(req.body?.stage)
      const { unlockCost, rewardMultiplier, rareOrbChance } = req.body ?? {}

      if (!isValidArenaStage(stage)) {
        return res.status(400).json({ message: `Stage must be between 1 and ${ARENA_STAGE_COUNT}` })
      }

      if (unlockCost !== undefined) {
        if (stage < 2) {
          return res.status(400).json({ message: 'Stage 1 has no unlock cost — it is always free' })
        }
        // Whole LSVP Tokens only — see utils/lsvpPricing.js.
        if (!isWholeTokenAmount(unlockCost, { allowZero: true })) {
          return res.status(400).json({ message: 'unlockCost must be a whole number of LSVP Tokens (zero or more)' })
        }
        await updateArenaStageUnlockCost(stage, Number(unlockCost))
      }

      if (rewardMultiplier !== undefined) {
        const n = Number(rewardMultiplier)
        if (!Number.isFinite(n) || n <= 0) {
          return res.status(400).json({ message: 'rewardMultiplier must be a positive number' })
        }
        await updateArenaRewardMultiplier(stage, n)
      }

      if (rareOrbChance !== undefined) {
        const n = Number(rareOrbChance)
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ message: 'rareOrbChance must be between 0 and 100' })
        }
        await updateArenaRareOrbChance(stage, n)
      }

      if (unlockCost === undefined && rewardMultiplier === undefined && rareOrbChance === undefined) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const economy = await getArenaEconomyConfig()
      res.json({
        stage,
        unlockCost: economy.unlockCosts[String(stage)] ?? null,
        rewardMultiplier: economy.rewardMultipliers[String(stage)] ?? 1,
        rareOrbChance: economy.rareOrbChances[String(stage)] ?? 0,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createArenaStagesRouter

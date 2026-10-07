import express from 'express'
import { randomInt } from 'crypto'
import { User } from '../models/User.js'
import { NftCollection } from '../models/NftCollection.js'
import { NftMint } from '../models/NftMint.js'
import { SlotSpinTransaction } from '../models/SlotSpinTransaction.js'
import {
  getSlotMachineConfig,
  updateSlotMachineCost,
  updateSlotMachineRewardCategory,
} from '../models/SlotMachineConfig.js'
import { transferNftFromAdmin } from '../solana/nftService.js'
import { getTransferFinalStatus } from '../solana/tokenService.js'
import { drawSlotNftReward } from '../game/slotNftReward.js'
import { explorerTxUrl } from '../config/solana.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { requirePayoutsNotPaused } from '../models/PayoutConfig.js'

/**
 * Builds the /api/slot-machine router — the Jackpot Slot Machine feature.
 *
 * Players spend Jackpot Tokens (earned by collecting natural in-game
 * Jackpot Orbs — see GameLogic.js's 'jackpot' orb-collision case and
 * ClientSession.saveJackpotTokens()) to spin, and win Lava Coins or a real,
 * on-chain NFT. Completely separate from the purchasable Jackpot Orb
 * feature (routes/jackpot.js), which spends LSVP instead and draws from its
 * own lavaCoin/nft/cosmetic pool.
 *
 * LSVP was removed as a slot reward category — see the doc comment on
 * SlotMachineConfig.js for why.
 *
 * The nft category draws a real, on-chain NFT from a Blockchain-admin-
 * configured NftCollection budget (see game/slotNftReward.js) — never the
 * manual/admin-curated catalog (models/Nft.js), which is reserved for the
 * artifact-perk marketplace. Like the Jackpot Orb's own nft/lsvp rewards,
 * winning an NFT here only RESERVES it — the actual on-chain transfer is a
 * separate claim step (see POST /claim/:transactionId below), since it
 * needs a destination wallet the player may not have connected yet.
 *
 * GET  /me                    → auth: Jackpot Token balance, live reward-
 *                                pool preview, cost per spin, recent history
 * POST /spin                  → auth: spend costPerSpin tokens, run the draw
 * POST /claim/:transactionId  → auth: claim a drawn NFT reward — sends the
 *                                real on-chain transfer immediately, no
 *                                admin approval step
 * GET  /admin/config          → admin: full config (cost + reward pool)
 * PUT  /admin/config          → admin: update cost and/or one reward category
 *
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — kept in sync immediately
 *   after a coin payout so a connected player's in-memory HUD balance
 *   updates without waiting for a reconnect (same pattern as jackpot.js).
 */
export function createSlotMachineRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSessionCoins(userId, coins) {
    const session = sessions?.get(String(userId))
    if (session?.game?.setTotalCoins && Number.isFinite(coins)) {
      session.game.setTotalCoins(coins)
    }
  }

  // See routes/jackpot.js's identical pickWeighted for why this uses
  // crypto.randomInt instead of Math.random (real-money draw).
  const RANDOM_SCALE = 1_000_000

  /** Weighted random pick among enabled categories, drawn with crypto.randomInt. Returns the category key or null if none enabled. */
  function pickWeighted(entries) {
    const pool = entries.filter((e) => e.weight > 0)
    const total = pool.reduce((sum, e) => sum + e.weight, 0)
    if (total <= 0) return null
    const scaledTotal = Math.round(total * RANDOM_SCALE)
    let roll = randomInt(0, scaledTotal)
    for (const entry of pool) {
      roll -= Math.round(entry.weight * RANDOM_SCALE)
      if (roll < 0) return entry.key
    }
    return pool[pool.length - 1]?.key ?? null
  }

  /** crypto.randomInt-backed inclusive integer draw in [min, max] — see routes/jackpot.js's identical secureRandomAmount. */
  function secureRandomAmount(min, max) {
    const lo = Math.round(Math.min(min, max))
    const hi = Math.round(Math.max(min, max))
    if (hi <= lo) return lo
    return randomInt(lo, hi + 1)
  }

  /**
   * Builds the public-safe reward pool preview: which categories are
   * enabled, their relative odds (as a percentage of enabled weight), and
   * category-specific display info (coin range, NFT count).
   */
  async function buildRewardPreview(config, userId) {
    const { coins, nft } = config.rewards

    // Personalized eligibility — MUST match /spin's own nftCategoryHasStock
    // check exactly, so the odds shown here are this specific player's real
    // odds (excluding collections they already own one from), not a
    // generic figure. See routes/jackpot.js's identical fix.
    let ownedCollections = []
    if (userId && nft.enabled) {
      ownedCollections = await NftMint.find({ ownerUserId: userId, status: 'sold' }).distinct('collectionMintAddress')
    }

    let eligibleNftCount = 0
    if (nft.enabled) {
      const eligibleCollections = await NftCollection.find({
        slotEligible: true,
        collectionMintAddress: { $nin: ownedCollections },
        $expr: { $lt: ['$slotRewardsGranted', '$slotRewardQuantity'] },
      }).select('collectionMintAddress')
      const addresses = eligibleCollections.map((c) => c.collectionMintAddress)
      eligibleNftCount = addresses.length
        ? await NftMint.countDocuments({ collectionMintAddress: { $in: addresses }, status: 'in_admin_wallet' })
        : 0
    }

    const enabledWeights = [
      coins.enabled ? coins.weight : 0,
      nft.enabled && eligibleNftCount > 0 ? nft.weight : 0,
    ]
    const totalWeight = enabledWeights.reduce((a, b) => a + b, 0) || 1

    return {
      coins: {
        enabled: coins.enabled,
        chancePercent: coins.enabled ? Math.round((enabledWeights[0] / totalWeight) * 1000) / 10 : 0,
        min: coins.min,
        max: coins.max,
      },
      nft: {
        enabled: nft.enabled,
        chancePercent: Math.round((enabledWeights[1] / totalWeight) * 1000) / 10,
        eligibleCount: eligibleNftCount,
      },
    }
  }

  /**
   * GET /api/slot-machine/me
   * Auth required — everything the Slot Machine page needs: Jackpot Token
   * balance (so "Spin" can be disabled client-side before even trying), the
   * live admin-configured reward pool preview, spin cost, and this user's
   * recent spin history.
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('jackpotTokens')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const config = await getSlotMachineConfig()
      const [rewardPreview, history] = await Promise.all([
        buildRewardPreview(config, req.user.sub),
        SlotSpinTransaction.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(20),
      ])

      res.json({
        jackpotTokens: user.jackpotTokens || 0,
        costPerSpin: config.costPerSpin,
        rewardPreview,
        history: history.map((h) => ({
          id: String(h._id),
          tokensSpent: h.tokensSpent,
          rewardType: h.rewardType,
          rewardDetail: h.rewardDetail,
          claimStatus: h.claimStatus,
          claimWalletAddress: h.claimWalletAddress,
          claimTxSignature: h.claimTxSignature,
          createdAt: h.createdAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/slot-machine/spin
   * Auth required — consume `costPerSpin` Jackpot Tokens and run a fully
   * server-side, weighted random draw over the configured reward pool
   * (Lava Coins / real on-chain NFT). Tokens are decremented atomically
   * (guarded by `jackpotTokens: { $gte: cost }`) BEFORE the draw runs, so a
   * double-submit can never trigger two draws off one balance.
   *
   * Reward selection never trusts the client in any way. The nft category
   * draws a real, on-chain NFT (see game/slotNftReward.js) — never the
   * manual/admin-curated catalog. If nothing is currently drawable in that
   * category (every eligible collection is quota-exhausted, out of stock,
   * or already owned by this player), the draw falls back to the remaining
   * enabled categories instead of granting nothing.
   */
  router.post('/spin', auth, async (req, res) => {
    const userId = req.user.sub
    try {
      const config = await getSlotMachineConfig()
      const cost = config.costPerSpin
      if (!Number.isFinite(cost) || cost < 1) {
        return res.status(500).json({ message: 'Slot Machine cost is not configured' })
      }

      const consumedUser = await User.findOneAndUpdate(
        { _id: userId, jackpotTokens: { $gte: cost } },
        { $inc: { jackpotTokens: -cost } },
        { new: true }
      )

      if (!consumedUser) {
        return res.status(400).json({ message: 'Not enough Jackpot Tokens to spin' })
      }

      const { coins, nft } = config.rewards

      // Whether the nft category has ANYTHING drawable right now — checked
      // here, before weighting, same pattern as routes/jackpot.js's POST
      // /use, so it can be dynamically zeroed out for this draw rather than
      // ever awarding nothing.
      let nftCategoryHasStock = false
      if (nft.enabled) {
        const ownedCollections = await NftMint.find({ ownerUserId: userId, status: 'sold' }).distinct('collectionMintAddress')
        const eligibleCollections = await NftCollection.find({
          slotEligible: true,
          collectionMintAddress: { $nin: ownedCollections },
          $expr: { $lt: ['$slotRewardsGranted', '$slotRewardQuantity'] },
        }).select('collectionMintAddress')
        if (eligibleCollections.length) {
          nftCategoryHasStock = await NftMint.exists({
            collectionMintAddress: { $in: eligibleCollections.map((c) => c.collectionMintAddress) },
            status: 'in_admin_wallet',
          })
        }
      }

      const weightEntries = [
        { key: 'coins', weight: coins.enabled ? coins.weight : 0 },
        { key: 'nft', weight: nft.enabled && nftCategoryHasStock ? nft.weight : 0 },
      ]

      let rewardType = pickWeighted(weightEntries)

      // Nothing at all is drawable (e.g. an admin disabled everything, or
      // the nft pool is exhausted and coins is disabled) — refund the
      // tokens rather than silently consuming them for nothing.
      if (!rewardType) {
        await User.findByIdAndUpdate(userId, { $inc: { jackpotTokens: cost } })
        return res.status(409).json({ message: 'No rewards are currently available — your Jackpot Tokens were not spent' })
      }

      let rewardDetail = null
      let responsePayload = {}

      if (rewardType === 'coins') {
        const amount = secureRandomAmount(coins.min, coins.max)
        const updated = await User.findByIdAndUpdate(userId, { $inc: { coins: amount } }, { new: true }).select('coins')
        rewardDetail = { amount }
        responsePayload = { coins: updated.coins }
        syncLiveSessionCoins(userId, updated.coins)
      } else if (rewardType === 'nft') {
        // Real, on-chain NFT — this only RESERVES it (NftMint flips to
        // 'sold', ownerUserId = this player) via drawSlotNftReward. The
        // actual on-chain transfer happens at claim time (POST
        // /claim/:transactionId) since it needs a destination wallet.
        const awarded = await drawSlotNftReward(userId)
        if (!awarded) {
          // Lost a last-second race against a concurrent draw for the same
          // stock this check already confirmed existed — refund the
          // tokens rather than award nothing.
          await User.findByIdAndUpdate(userId, { $inc: { jackpotTokens: cost } })
          return res.status(409).json({ message: 'That NFT reward just became unavailable — your Jackpot Tokens were not spent' })
        }
        rewardDetail = awarded
        responsePayload = { nft: rewardDetail }
      }

      const transaction = await SlotSpinTransaction.create({
        userId,
        tokensSpent: cost,
        rewardType,
        rewardDetail,
        claimStatus: rewardType === 'nft' ? 'unclaimed' : 'not_applicable',
      })

      console.log(`Slot Machine spin: user ${userId} drew ${rewardType}`, rewardDetail)

      res.json({
        rewardType,
        rewardDetail,
        jackpotTokens: consumedUser.jackpotTokens,
        transactionId: String(transaction._id),
        claimStatus: transaction.claimStatus,
        ...responsePayload,
      })
    } catch (error) {
      console.error(`Slot Machine spin error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/slot-machine/claim/:transactionId
   * Auth required — claim a drawn NFT reward. This is the ONLY place it
   * ever results in a real on-chain transfer — winning one (POST /spin
   * above) only reserves it as 'unclaimed'. There is no admin approval
   * step: the NFT was already atomically claimed out of admin-wallet stock
   * at draw time, so the transfer always goes out immediately here. Mirrors
   * routes/jackpot.js's POST /claim/:transactionId (nft branch) exactly,
   * just against SlotSpinTransaction instead of JackpotTransaction.
   *
   * Body: { walletAddress: string }
   */
  router.post('/claim/:transactionId', auth, async (req, res) => {
    const userId = req.user.sub
    const { transactionId } = req.params
    try {
      // Atomically claim this reward for processing — see
      // routes/jackpot.js's identical claim route for the full reasoning;
      // closes the race where two concurrent claim requests for the same
      // reward could both trigger a transfer.
      let transaction = await SlotSpinTransaction.findOneAndUpdate(
        { _id: transactionId, userId, claimStatus: 'unclaimed' },
        { $set: { claimStatus: 'processing' } },
        { new: true }
      )

      if (!transaction) {
        const existing = await SlotSpinTransaction.findOne({ _id: transactionId, userId })
        if (!existing) {
          return res.status(404).json({ message: 'Reward not found' })
        }
        if (existing.claimStatus === 'approved') {
          return res.json({
            claimStatus: existing.claimStatus,
            txSignature: existing.claimTxSignature,
            explorerUrl: existing.claimTxSignature ? explorerTxUrl(existing.claimTxSignature) : null,
            message: 'This reward was already claimed.',
          })
        }
        return res.status(409).json({ message: `This reward has already been ${existing.claimStatus}` })
      }

      const releaseBackToUnclaimed = () =>
        SlotSpinTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'unclaimed' } }).catch(() => {})

      if (transaction.rewardType !== 'nft') {
        await releaseBackToUnclaimed()
        return res.status(400).json({ message: 'This reward is not claimable' })
      }

      const user = await User.findById(userId).select('solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        await releaseBackToUnclaimed()
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before claiming' })
      }
      const walletAddress = user.solanaWalletAddress

      try {
        await requirePayoutsNotPaused()
      } catch (pauseError) {
        await releaseBackToUnclaimed()
        return res.status(503).json({ message: pauseError.message })
      }

      // The NftMint was already reserved (status 'sold', ownerUserId =
      // this user) at draw time; only the on-chain transfer itself is
      // deferred to now.
      const mintAddress = transaction.rewardDetail?.mintAddress
      const mint = mintAddress ? await NftMint.findOne({ mintAddress, ownerUserId: userId }) : null
      if (!mint) {
        await releaseBackToUnclaimed()
        return res.status(500).json({ message: 'This NFT reward could not be found' })
      }

      let signature
      try {
        signature = await transferNftFromAdmin(mint.mintAddress, walletAddress)
        mint.transferSignature = signature
        await mint.save()
      } catch (transferError) {
        // UNCERTAIN TRANSFER — check the real on-chain outcome of this
        // exact signature before assuming it failed (see
        // tokenService.js's sendSignedTransfer / getTransferFinalStatus).
        const status = await getTransferFinalStatus(transferError.signature)
        if (status.success) {
          mint.transferSignature = transferError.signature
          mint.transferFailed = false
          await mint.save()
          transaction.claimStatus = 'approved'
          transaction.claimWalletAddress = walletAddress
          transaction.claimTxSignature = transferError.signature
          await transaction.save()
          return res.json({
            claimStatus: transaction.claimStatus,
            txSignature: transferError.signature,
            explorerUrl: explorerTxUrl(transferError.signature),
            message: `${mint.name} sent to your wallet!`,
          })
        }
        // The NFT is already reserved to this player either way — flag it
        // for an admin retry, and leave this claim 'processing' (not
        // 'unclaimed') so a player retry can never race an admin retry
        // and double-send the same NFT.
        mint.transferFailed = true
        await mint.save()
        await SlotSpinTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'processing' } })
        console.error(`Slot Machine NFT claim transfer failed/uncertain for user ${userId}, mint ${mint.mintAddress}:`, transferError)
        return res.status(500).json({ message: `${transferError.message} — your NFT is reserved and an admin will retry the transfer.` })
      }

      transaction.claimStatus = 'approved'
      transaction.claimWalletAddress = walletAddress
      transaction.claimTxSignature = signature
      await transaction.save()

      res.json({
        claimStatus: transaction.claimStatus,
        txSignature: signature,
        explorerUrl: explorerTxUrl(signature),
        message: `${mint.name} sent to your wallet!`,
      })
    } catch (error) {
      console.error(`Slot Machine claim error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/slot-machine/admin/config
   * Admin only — the full live config (cost + every reward category's
   * settings) for editing in the admin dashboard.
   */
  router.get('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const config = await getSlotMachineConfig()
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/slot-machine/admin/config
   * Admin only — update the Jackpot Token cost per spin and/or one reward
   * category.
   * Body: {
   *   costPerSpin?: number,
   *   coins?: { enabled?, weight?, min?, max? },
   *   nft?:   { enabled?, weight? },
   * }
   * Any subset may be provided; omitted fields are left unchanged. nft has
   * no eligibility settings here at all — which NFT Collections are
   * Slot-Machine-eligible, and how many, is configured per-collection from
   * the Blockchain admin tab (NftCollection.slotEligible/slotRewardQuantity).
   */
  router.put('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const { costPerSpin, coins, nft } = req.body ?? {}

      if (costPerSpin !== undefined) {
        const n = Number(costPerSpin)
        if (!Number.isFinite(n) || n < 1) {
          return res.status(400).json({ message: 'costPerSpin must be at least 1' })
        }
        await updateSlotMachineCost(n)
      }

      if (coins !== undefined) {
        const patch = {}
        if (coins.enabled !== undefined) patch.enabled = Boolean(coins.enabled)
        if (coins.weight !== undefined) {
          const n = Number(coins.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'coins.weight must be zero or positive' })
          patch.weight = n
        }
        if (coins.min !== undefined) {
          const n = Number(coins.min)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'coins.min must be zero or positive' })
          patch.min = n
        }
        if (coins.max !== undefined) {
          const n = Number(coins.max)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'coins.max must be zero or positive' })
          patch.max = n
        }
        await updateSlotMachineRewardCategory('coins', patch)
      }

      if (nft !== undefined) {
        const patch = {}
        if (nft.enabled !== undefined) patch.enabled = Boolean(nft.enabled)
        if (nft.weight !== undefined) {
          const n = Number(nft.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'nft.weight must be zero or positive' })
          patch.weight = n
        }
        await updateSlotMachineRewardCategory('nft', patch)
      }

      if (costPerSpin === undefined && coins === undefined && nft === undefined) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const config = await getSlotMachineConfig()
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createSlotMachineRouter

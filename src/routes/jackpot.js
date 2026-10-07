import express from 'express'
import { randomInt } from 'crypto'
import { User } from '../models/User.js'
import { NftCollection } from '../models/NftCollection.js'
import { NftMint } from '../models/NftMint.js'
import { JackpotTransaction } from '../models/JackpotTransaction.js'
import {
  getJackpotConfig,
  updateJackpotCost,
  updateJackpotRewardCategory,
} from '../models/JackpotConfig.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'
import { transferLsvpFromAdmin, getTransferFinalStatus, getAdminLsvpBalance } from '../solana/tokenService.js'
import { transferNftFromAdmin } from '../solana/nftService.js'
import { drawJackpotNftReward } from '../game/jackpotNftReward.js'
import { explorerTxUrl } from '../config/solana.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { requirePayoutsNotPaused } from '../models/PayoutConfig.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'


/**
 * Builds the /api/jackpot router — the PURCHASABLE Jackpot Orb feature.
 *
 * This is a separate system from the existing natural in-game Jackpot Orb
 * spawn/reward (GameLogic.js's 'jackpot' orb-collection case,
 * ClientSession._handleJackpotNftReward) — that keeps spawning at its
 * existing rare rate and running its own draw. This router adds a second,
 * alternative way to obtain a Jackpot Orb: spend LSVP Tokens to buy one
 * into inventory, then "use" it whenever to trigger a separate,
 * server-side reward draw. The two DO share one thing: an NFT win from
 * either path draws from the same real-on-chain-NFT pool and goes through
 * this same POST /claim/:transactionId (see game/jackpotNftReward.js).
 *
 * GET  /me                    → auth: LSVP balance, owned orb count, live
 *                                reward-pool preview, recent history
 * POST /purchase              → auth: spend LSVP, +1 Jackpot Orb (atomic)
 * POST /use                   → auth: consume 1 Jackpot Orb, run the draw
 * POST /claim/:transactionId  → auth: claim a drawn LSVP reward — sends the
 *                                real on-chain transfer immediately, no
 *                                admin approval step
 * GET  /admin/config          → admin: full config (cost + reward pool)
 * PUT  /admin/config          → admin: update cost and/or one reward category
 *
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — kept in sync immediately
 *   after a purchase/use so a connected player's in-memory HUD balance
 *   updates without waiting for a reconnect (same pattern as cashout/nfts).
 */
export function createJackpotRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSessionCoins(userId, coins) {
    const session = sessions?.get(String(userId))
    if (session?.game?.setTotalCoins && Number.isFinite(coins)) {
      session.game.setTotalCoins(coins)
    }
  }

  // Scale factor for turning a weighted roll into an integer range for
  // crypto.randomInt (which requires integer bounds) — fine enough that
  // admin-configured weights with a decimal or two still divide the
  // resulting range fairly.
  const RANDOM_SCALE = 1_000_000

  /**
   * Weighted random pick among enabled categories, drawn with
   * crypto.randomInt instead of Math.random — see the doc comment on
   * secureRandomAmount below for why real-money draws (LSVP, NFTs) should
   * never use Math.random, which is not cryptographically secure and is
   * not intended to be unpredictable. Returns the category key or null if
   * none enabled.
   */
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

  /**
   * crypto.randomInt-backed replacement for `Math.round(min + Math.random()
   * * (max - min))` — an inclusive integer draw in [min, max]. Math.random
   * is a fast, non-cryptographic PRNG never designed to resist prediction;
   * every draw here decides a real LSVP/coin payout, so it uses Node's
   * cryptographically secure randomInt instead, same as pickWeighted above.
   */
  function secureRandomAmount(min, max) {
    const lo = Math.round(Math.min(min, max))
    const hi = Math.round(Math.max(min, max))
    if (hi <= lo) return lo
    return randomInt(lo, hi + 1) // randomInt's upper bound is exclusive
  }

  /**
   * Builds the public-safe reward pool preview: which categories are
   * enabled, their relative odds (as a percentage of enabled weight), and
   * category-specific display info (coin range, NFT count, cosmetic names).
   * Never exposes anything that would let a client compute/predict a draw
   * beyond the same odds an admin has chosen to publish.
   */
  async function buildRewardPreview(config, userId) {
    const { lavaCoin, lsvp, nft, cosmetic } = config.rewards

    // Personalized eligibility — MUST match /use's own eligibility checks
    // exactly (nftCategoryHasStock / eligibleCosmetics below), so the odds
    // shown here are the odds this specific player would actually draw,
    // not a generic figure that ignores what they already own. Previously
    // this preview computed nft eligibility without excluding collections
    // the player already owns one from, and showed the cosmetic pool's
    // full chance regardless of which cosmetics they'd already won —
    // overstating this player's real odds in both categories.
    let ownedCollections = []
    let ownedCosmeticIds = []
    if (userId) {
      const user = await User.findById(userId).select('ownedCosmeticIds')
      ownedCosmeticIds = user?.ownedCosmeticIds ?? []
      ownedCollections = await NftMint.find({ ownerUserId: userId, status: 'sold' }).distinct('collectionMintAddress')
    }

    let eligibleNftCount = 0
    if (nft.enabled) {
      const eligibleCollections = await NftCollection.find({
        jackpotEligible: true,
        collectionMintAddress: { $nin: ownedCollections },
        $expr: { $lt: ['$jackpotRewardsGranted', '$jackpotRewardQuantity'] },
      }).select('collectionMintAddress')
      const addresses = eligibleCollections.map((c) => c.collectionMintAddress)
      eligibleNftCount = addresses.length
        ? await NftMint.countDocuments({ collectionMintAddress: { $in: addresses }, status: 'in_admin_wallet' })
        : 0
    }

    const eligibleCosmetics = cosmetic.enabled
      ? cosmetic.pool.filter((c) => !ownedCosmeticIds.includes(c.id))
      : []

    // The actual draw zeroes out a category's weight when it has nothing
    // left to give this player (see /use below) — mirror that here so the
    // displayed percentages sum to the same 100% the real draw would use,
    // instead of showing a nonzero chance for a category that would
    // silently fall through to something else.
    const enabledWeights = [
      lavaCoin.enabled ? lavaCoin.weight : 0,
      lsvp.enabled ? lsvp.weight : 0,
      nft.enabled && eligibleNftCount > 0 ? nft.weight : 0,
      cosmetic.enabled && eligibleCosmetics.length > 0 ? cosmetic.weight : 0,
    ]
    const totalWeight = enabledWeights.reduce((a, b) => a + b, 0) || 1

    return {
      lavaCoin: {
        enabled: lavaCoin.enabled,
        chancePercent: lavaCoin.enabled ? Math.round((enabledWeights[0] / totalWeight) * 1000) / 10 : 0,
        min: lavaCoin.min,
        max: lavaCoin.max,
      },
      lsvp: {
        enabled: lsvp.enabled,
        chancePercent: lsvp.enabled ? Math.round((enabledWeights[1] / totalWeight) * 1000) / 10 : 0,
        min: lsvp.min,
        max: lsvp.max,
      },
      nft: {
        enabled: nft.enabled,
        chancePercent: Math.round((enabledWeights[2] / totalWeight) * 1000) / 10,
        eligibleCount: eligibleNftCount,
      },
      cosmetic: {
        enabled: cosmetic.enabled,
        chancePercent: Math.round((enabledWeights[3] / totalWeight) * 1000) / 10,
        pool: cosmetic.pool.map((c) => ({ id: c.id, name: c.name, description: c.description })),
      },
    }
  }

  /**
   * GET /api/jackpot/me
   * Auth required — everything the Jackpot section of the UI needs: LSVP
   * balance (so "Buy" can be disabled client-side before even trying),
   * owned orb count, the live admin-configured reward pool preview, and
   * this user's recent purchase/use history.
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('jackpotOrbs')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const config = await getJackpotConfig()
      const [rewardPreview, history] = await Promise.all([
        buildRewardPreview(config, req.user.sub),
        JackpotTransaction.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(20),
      ])

      res.json({
        // No more off-chain lsvpBalance here — the LSVP cost is paid
        // on-chain at purchase time (see POST /purchase below); the
        // frontend shows the real connected-wallet balance instead (see
        // useConnectedLsvpBalance.js).
        jackpotOrbs: user.jackpotOrbs || 0,
        lsvpCost: config.lsvpCost,
        rewardPreview,
        history: history.map((h) => ({
          id: String(h._id),
          type: h.type,
          lsvpSpent: h.lsvpSpent,
          rewardType: h.rewardType,
          rewardDetail: h.rewardDetail,
          claimStatus: h.claimStatus,
          claimWalletAddress: h.claimWalletAddress,
          claimTxSignature: h.claimTxSignature,
          cancelReason: h.cancelReason,
          createdAt: h.createdAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/jackpot/purchase
   * Auth required — buy ONE Jackpot Orb using real on-chain LSVP. Same
   * pattern as buying an NFT (see routes/blockchainUser.js): the frontend
   * already sent an LSVP transfer from the player's connected wallet to the
   * admin wallet (payLsvpToAdmin) and hands us the resulting signature here.
   * Body: { txSignature: string, walletAddress: string }
   *
   * The backend independently re-reads that transaction from Solana
   * (verifyLsvpPayment) before granting anything, and records the signature
   * in LsvpPayment so it can never be replayed to claim a second orb. This
   * purchase only ever grants an inventory orb — it is never a guaranteed
   * reward itself.
   */
  router.post('/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    const txSignature = req.body?.txSignature
    try {
      // The wallet must already be linked AND verified (see POST
      // /api/blockchain/wallet/challenge + /wallet/link) — purchases used
      // to silently (re)link whatever address the request body claimed,
      // with no proof the caller actually held it. See
      // solana/walletAddress.js's doc comment for the full story.
      const user = await User.findById(userId).select('solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before purchasing' })
      }
      if (req.body?.walletAddress && req.body.walletAddress !== user.solanaWalletAddress) {
        return res.status(400).json({ message: 'The connected wallet does not match your linked wallet' })
      }
      const walletAddress = user.solanaWalletAddress

      const config = await getJackpotConfig()
      const cost = config.lsvpCost
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(500).json({ message: 'Jackpot Orb cost is not configured' })
      }

      const grant = async () => {
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $inc: { jackpotOrbs: 1 } },
          { new: true }
        ).select('jackpotOrbs')

        await JackpotTransaction.create({
          userId,
          type: 'purchase',
          lsvpSpent: cost,
        })

        console.log(`Jackpot Orb purchased: user ${userId} paid ${cost} LSVP on-chain, now owns ${updatedUser.jackpotOrbs}`)

        return {
          jackpotOrbs: updatedUser.jackpotOrbs,
          message: 'Jackpot Orb purchased!',
        }
      }

      // cost of 0 means "free right now" (an admin-configured promo) — skip
      // payment verification/claiming entirely rather than demanding a
      // signature for a zero-value transfer, and just grant directly.
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

      // claimPaymentAndGrant makes this whole "pay, then grant the orb"
      // sequence safe to retry with the same signature — see its doc
      // comment in models/LsvpPayment.js for why that matters (a request
      // that dies between claiming the payment and granting the orb used
      // to leave a player permanently paid-but-empty-handed).
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: walletAddress,
        amountLsvp: cost,
        purpose: 'jackpot_orb_purchase',
        purposeRefId: 'jackpot-orb',
        grant,
        getGrantedResponse: async () => {
          const current = await User.findById(userId).select('jackpotOrbs')
          return { jackpotOrbs: current?.jackpotOrbs ?? 0, message: 'Jackpot Orb purchased!' }
        },
      })

      res.json(result)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      console.error(`Jackpot Orb purchase error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/jackpot/use
   * Auth required — consume ONE Jackpot Orb from inventory and run a fully
   * server-side, weighted random draw over the configured reward pool
   * (Lava Coins / Marketplace NFT / cosmetic). The orb is decremented
   * atomically (guarded by `jackpotOrbs: { $gte: 1 }`) BEFORE the draw
   * runs, so a double-submit can never trigger two draws off one orb.
   *
   * Reward selection never trusts the client in any way — category and
   * payout/NFT/cosmetic are all chosen here. NFT/cosmetic rewards are
   * filtered to what the player doesn't already own (never a duplicate
   * claim); if every eligible item in a category is already owned, the
   * draw falls back to a Lava Coin payout instead of granting nothing.
   * The nft category draws a real, on-chain NFT (see
   * game/jackpotNftReward.js) — never the manual/admin-curated catalog.
   */
  router.post('/use', auth, async (req, res) => {
    const userId = req.user.sub
    try {
      const consumedUser = await User.findOneAndUpdate(
        { _id: userId, jackpotOrbs: { $gte: 1 } },
        { $inc: { jackpotOrbs: -1 } },
        { new: true }
      )

      if (!consumedUser) {
        return res.status(400).json({ message: 'You have no Jackpot Orbs to use' })
      }

      const config = await getJackpotConfig()
      const { lavaCoin, lsvp, nft, cosmetic } = config.rewards

      // Whether the nft category has ANYTHING drawable right now (real,
      // on-chain NFT Collections an admin opted into jackpot rewards, with
      // remaining quota and in-wallet stock, that this player doesn't
      // already own one of) — checked here, before weighting, same as
      // every other category, so it can be dynamically zeroed out for this
      // draw rather than ever awarding nothing.
      let nftCategoryHasStock = false
      if (nft.enabled) {
        const ownedCollections = await NftMint.find({ ownerUserId: userId, status: 'sold' }).distinct('collectionMintAddress')
        const eligibleCollections = await NftCollection.find({
          jackpotEligible: true,
          collectionMintAddress: { $nin: ownedCollections },
          $expr: { $lt: ['$jackpotRewardsGranted', '$jackpotRewardQuantity'] },
        }).select('collectionMintAddress')
        if (eligibleCollections.length) {
          nftCategoryHasStock = await NftMint.exists({
            collectionMintAddress: { $in: eligibleCollections.map((c) => c.collectionMintAddress) },
            status: 'in_admin_wallet',
          })
        }
      }

      let eligibleCosmetics = []
      if (cosmetic.enabled) {
        eligibleCosmetics = cosmetic.pool.filter((c) => !consumedUser.ownedCosmeticIds?.includes(c.id))
      }

      const weightEntries = [
        { key: 'lava_coin', weight: lavaCoin.enabled ? lavaCoin.weight : 0 },
        { key: 'lsvp', weight: lsvp.enabled ? lsvp.weight : 0 },
        { key: 'nft', weight: nft.enabled && nftCategoryHasStock ? nft.weight : 0 },
        { key: 'cosmetic', weight: cosmetic.enabled && eligibleCosmetics.length ? cosmetic.weight : 0 },
      ]

      let rewardType = pickWeighted(weightEntries)

      // Nothing at all is drawable (e.g. an admin disabled everything, or
      // every NFT/cosmetic is already owned and lava coin is disabled) —
      // refund the orb rather than silently consuming it for nothing.
      if (!rewardType) {
        await User.findByIdAndUpdate(userId, { $inc: { jackpotOrbs: 1 } })
        return res.status(409).json({ message: 'No rewards are currently available — your Jackpot Orb was not consumed' })
      }

      let rewardDetail = null
      let responsePayload = {}

      if (rewardType === 'lava_coin') {
        const amount = secureRandomAmount(lavaCoin.min, lavaCoin.max)
        const updated = await User.findByIdAndUpdate(userId, { $inc: { coins: amount } }, { new: true }).select('coins')
        rewardDetail = { amount }
        responsePayload = { coins: updated.coins }
        syncLiveSessionCoins(userId, updated.coins)
      } else if (rewardType === 'lsvp') {
        // Real, on-chain LSVP — NOT credited here. The player has to
        // actively claim it (POST /claim/:transactionId below), which is
        // what actually moves anything on-chain. This branch only decides
        // the amount and records it as 'unclaimed'.
        const amount = secureRandomAmount(lsvp.min, lsvp.max)
        rewardDetail = { amount }
        responsePayload = {}
      } else if (rewardType === 'nft') {
        // Real, on-chain NFT — this only RESERVES it (NftMint flips to
        // 'sold', ownerUserId = this player) via drawJackpotNftReward. The
        // actual on-chain transfer, like lsvp above, happens at claim time
        // (POST /claim/:transactionId) since it needs a destination wallet.
        const awarded = await drawJackpotNftReward(userId)
        if (!awarded) {
          // Lost a last-second race against a concurrent draw/purchase for
          // the same stock this check already confirmed existed — refund
          // the orb rather than award nothing.
          await User.findByIdAndUpdate(userId, { $inc: { jackpotOrbs: 1 } })
          return res.status(409).json({ message: 'That NFT reward just became unavailable — your Jackpot Orb was not consumed' })
        }
        rewardDetail = awarded
        responsePayload = { nft: rewardDetail }
      } else if (rewardType === 'cosmetic') {
        const awarded = eligibleCosmetics[randomInt(0, eligibleCosmetics.length)]
        await User.findByIdAndUpdate(userId, { $addToSet: { ownedCosmeticIds: awarded.id } })
        rewardDetail = { cosmeticId: awarded.id, name: awarded.name, description: awarded.description }
        responsePayload = { cosmetic: rewardDetail }
      }

      const transaction = await JackpotTransaction.create({
        userId,
        type: 'use',
        rewardType,
        rewardDetail,
        claimStatus: rewardType === 'lsvp' || rewardType === 'nft' ? 'unclaimed' : 'not_applicable',
      })

      console.log(`Jackpot Orb used: user ${userId} drew ${rewardType}`, rewardDetail)

      res.json({
        rewardType,
        rewardDetail,
        jackpotOrbs: consumedUser.jackpotOrbs,
        transactionId: String(transaction._id),
        claimStatus: transaction.claimStatus,
        ...responsePayload,
      })
    } catch (error) {
      console.error(`Jackpot Orb use error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/jackpot/claim/:transactionId
   * Auth required — claim a drawn LSVP or NFT reward. This is the ONLY
   * place either ever results in a real on-chain transfer — winning one
   * (POST /use above) only reserves it as 'unclaimed'. There is no admin
   * approval step for either: an LSVP amount is already bounded by the
   * reward category's min/max, and an NFT was already atomically claimed
   * out of admin-wallet stock at draw time — so the transfer always goes
   * out immediately here.
   *
   * Body: { walletAddress: string }
   *
   * - Validates the transaction belongs to this user, has a claimable
   *   rewardType ('lsvp' or 'nft'), and is still 'unclaimed' (a claim can
   *   only ever be submitted once — re-submitting an already-'approved'
   *   transaction is rejected).
   * - Links (or confirms) the wallet the same way every other on-chain
   *   payout in this app does.
   * - Transfers the LSVP/NFT from the admin wallet and marks the
   *   transaction 'approved' once the transfer succeeds.
   */
  /**
   * RESERVE CHECK — the running total of every LSVP jackpot reward that's
   * been drawn but not yet paid out: 'unclaimed' (waiting on the player),
   * 'processing' (a claim for it is in flight right now), or
   * 'held_for_review' (already claimed and confirmed, just paused —
   * still genuinely owed). Compared against the admin wallet's real
   * balance (see
   * getAdminLsvpBalance) before a claim is allowed to attempt an on-chain
   * transfer, so one payout can never be approved in a way that leaves
   * every OTHER promised-but-unclaimed reward unable to be paid.
   *
   * 'processing' is included deliberately: the transaction being claimed
   * right now is flipped to 'processing' by the atomic findOneAndUpdate
   * above before this is ever called, so it already counts itself here —
   * this answers "can everything currently owed, including this claim,
   * actually be paid," not just "can this one claim alone be paid."
   */
  async function getReservedUnclaimedLsvpTotal() {
    const rows = await JackpotTransaction.aggregate([
      { $match: { rewardType: 'lsvp', claimStatus: { $in: ['unclaimed', 'processing', 'held_for_review'] } } },
      { $group: { _id: null, total: { $sum: '$rewardDetail.amount' } } },
    ])
    return rows[0]?.total ?? 0
  }

  /**
   * Settles an already-'processing' LSVP transaction: attempts the real
   * on-chain transfer with the same uncertain-transfer-safe handling the
   * claim route has always used, and returns a plain result object
   * instead of writing to `res` directly — shared by POST
   * /claim/:transactionId and the admin retry endpoint below so there is
   * only one place that decides approved vs. needs-release vs. stays
   * processing.
   */
  async function settleLsvpPayout(transaction, walletAddress) {
    const amount = transaction.rewardDetail?.amount
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, status: 500, message: 'This reward has no valid claimable amount', release: true }
    }
    try {
      const signature = await transferLsvpFromAdmin(walletAddress, amount)
      transaction.claimStatus = 'approved'
      transaction.claimWalletAddress = walletAddress
      transaction.claimTxSignature = signature
      transaction.heldReason = null
      await transaction.save()
      return { ok: true, claimStatus: 'approved', txSignature: signature, message: `${amount} LSVP sent to your wallet!` }
    } catch (transferError) {
      const status = await getTransferFinalStatus(transferError.signature)
      if (status.success) {
        transaction.claimStatus = 'approved'
        transaction.claimWalletAddress = walletAddress
        transaction.claimTxSignature = transferError.signature
        transaction.heldReason = null
        await transaction.save()
        return { ok: true, claimStatus: 'approved', txSignature: transferError.signature, message: `${amount} LSVP sent to your wallet!` }
      }
      if (status.landed === null) {
        return { ok: false, status: 500, message: 'Could not confirm this payout — please check back shortly or contact an admin before retrying.', release: false }
      }
      return { ok: false, status: 500, message: transferError.message, release: true }
    }
  }

  router.post('/claim/:transactionId', auth, async (req, res) => {
    const userId = req.user.sub
    const { transactionId } = req.params
    try {
      // Atomically claim this reward for processing — moves
      // unclaimed -> processing in one findOneAndUpdate so two concurrent
      // claim requests for the same reward (a double-tap, two open tabs)
      // can never both trigger a transfer. See models/JackpotTransaction.js.
      let transaction = await JackpotTransaction.findOneAndUpdate(
        { _id: transactionId, userId, claimStatus: 'unclaimed' },
        { $set: { claimStatus: 'processing' } },
        { new: true }
      )

      if (!transaction) {
        const existing = await JackpotTransaction.findOne({ _id: transactionId, userId })
        if (!existing) {
          return res.status(404).json({ message: 'Reward not found' })
        }
        if (existing.claimStatus === 'approved') {
          // Idempotent repeat — an earlier attempt already completed this
          // claim; hand back the same result instead of erroring.
          return res.json({
            claimStatus: existing.claimStatus,
            txSignature: existing.claimTxSignature,
            explorerUrl: existing.claimTxSignature ? explorerTxUrl(existing.claimTxSignature) : null,
            message: 'This reward was already claimed.',
          })
        }
        if (existing.claimStatus === 'held_for_review') {
          // Not an error — the reward is still reserved for this player,
          // just waiting on an admin to top up the wallet and retry it.
          return res.status(202).json({
            claimStatus: existing.claimStatus,
            message: 'Your reward is confirmed and safely on hold while the reward pool is topped up — no action needed, it will be paid once an admin releases it.',
          })
        }
        return res.status(409).json({ message: `This reward has already been ${existing.claimStatus}` })
      }

      const releaseBackToUnclaimed = () =>
        JackpotTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'unclaimed' } }).catch(() => {})

      if (transaction.rewardType !== 'lsvp' && transaction.rewardType !== 'nft') {
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
        // Payouts are paused admin-side — leave this back at 'unclaimed'
        // (not stuck 'processing') so the player can simply retry once
        // payouts resume.
        await releaseBackToUnclaimed()
        return res.status(503).json({ message: pauseError.message })
      }

      if (transaction.rewardType === 'lsvp') {
        const amount = transaction.rewardDetail?.amount
        if (!Number.isFinite(amount) || amount <= 0) {
          await releaseBackToUnclaimed()
          return res.status(500).json({ message: 'This reward has no valid claimable amount' })
        }

        // RESERVE CHECK — see getReservedUnclaimedLsvpTotal's doc comment
        // above. Runs BEFORE ever attempting the transfer: if every
        // unclaimed/in-flight LSVP reward (this one included, since it's
        // already 'processing') adds up to more than the admin wallet
        // actually holds right now, hold this one for admin review
        // instead of letting Solana itself reject (or worse, only
        // partially satisfy) an over-committed payout.
        const [reservedTotal, adminBalance] = await Promise.all([
          getReservedUnclaimedLsvpTotal(),
          getAdminLsvpBalance(),
        ])
        if (reservedTotal > adminBalance) {
          transaction.claimStatus = 'held_for_review'
          transaction.heldReason = `Reserve exceeded at claim time: ${reservedTotal} LSVP owed across pending rewards vs ${adminBalance} LSVP in the admin wallet.`
          await transaction.save()
          console.warn(`Jackpot LSVP claim held for review — user ${userId}, transaction ${transactionId}: reserved ${reservedTotal} > admin balance ${adminBalance}`)
          return res.status(202).json({
            claimStatus: transaction.claimStatus,
            message: 'Your reward is confirmed and safely on hold while the reward pool is topped up — no action needed, it will be paid once an admin releases it.',
          })
        }

        const result = await settleLsvpPayout(transaction, walletAddress)
        if (!result.ok) {
          if (result.release) await releaseBackToUnclaimed()
          console.error(`Jackpot LSVP claim transfer error for user ${userId}, transaction ${transactionId}:`, result.message)
          return res.status(result.status).json({ message: result.message })
        }
        return res.json({
          claimStatus: result.claimStatus,
          txSignature: result.txSignature,
          explorerUrl: explorerTxUrl(result.txSignature),
          message: result.message,
        })
      }

      // rewardType === 'nft' — the NftMint was already reserved (status
      // 'sold', ownerUserId = this user) at draw time; only the on-chain
      // transfer itself is deferred to now.
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
        // The NFT is already reserved to this player either way (won at
        // draw time) — whether it's confirmed-failed or still uncertain,
        // flag it for an admin retry and keep this claim OUT of
        // 'unclaimed' (leave it 'processing') so a player-initiated retry
        // here can never race an eventual admin retry-transfer and
        // double-send the same NFT.
        mint.transferFailed = true
        await mint.save()
        await JackpotTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'processing' } })
        console.error(`Jackpot NFT claim transfer failed/uncertain for user ${userId}, mint ${mint.mintAddress}:`, transferError)
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
      console.error(`Jackpot claim error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/jackpot/admin/config
   * Admin only — the full live config (cost + every reward category's
   * settings) for editing in the admin dashboard.
   */
  router.get('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const config = await getJackpotConfig()
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/jackpot/admin/config
   * Admin only — update the LSVP cost and/or one reward category.
   * Body: {
   *   lsvpCost?: number,
   *   lavaCoin?: { enabled?, weight?, min?, max? },
   *   lsvp?: { enabled?, weight?, min?, max? },
   *   nft?: { enabled?, weight? },
   *   cosmetic?: { enabled?, weight?, pool? },
   * }
   * Any subset may be provided; omitted fields are left unchanged. lsvp's
   * min/max double as the admin-configurable claim withdrawal limits —
   * every claim is instant, so those two numbers are the only thing
   * bounding an LSVP payout. nft has no eligibility settings here at all —
   * which NFT Collections are jackpot-eligible, and how many, is configured
   * per-collection from the Blockchain admin tab (NftCollection.jackpotEligible
   * / jackpotRewardQuantity).
   */
  router.put('/admin/config', auth, requireAdmin, async (req, res) => {
    try {
      const { lsvpCost, lavaCoin, lsvp, nft, cosmetic } = req.body ?? {}

      if (lsvpCost !== undefined) {
        // Whole LSVP Tokens only — see utils/lsvpPricing.js.
        if (!isWholeTokenAmount(lsvpCost, { allowZero: true })) {
          return res.status(400).json({ message: 'lsvpCost must be a whole number of LSVP Tokens (zero or more)' })
        }
        await updateJackpotCost(Number(lsvpCost))
      }

      if (lavaCoin !== undefined) {
        const patch = {}
        if (lavaCoin.enabled !== undefined) patch.enabled = Boolean(lavaCoin.enabled)
        if (lavaCoin.weight !== undefined) {
          const n = Number(lavaCoin.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lavaCoin.weight must be zero or positive' })
          patch.weight = n
        }
        if (lavaCoin.min !== undefined) {
          const n = Number(lavaCoin.min)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lavaCoin.min must be zero or positive' })
          patch.min = n
        }
        if (lavaCoin.max !== undefined) {
          const n = Number(lavaCoin.max)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lavaCoin.max must be zero or positive' })
          patch.max = n
        }
        await updateJackpotRewardCategory('lavaCoin', patch)
      }

      if (lsvp !== undefined) {
        const patch = {}
        if (lsvp.enabled !== undefined) patch.enabled = Boolean(lsvp.enabled)
        if (lsvp.weight !== undefined) {
          const n = Number(lsvp.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lsvp.weight must be zero or positive' })
          patch.weight = n
        }
        if (lsvp.min !== undefined) {
          const n = Number(lsvp.min)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lsvp.min must be zero or positive' })
          patch.min = n
        }
        if (lsvp.max !== undefined) {
          const n = Number(lsvp.max)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'lsvp.max must be zero or positive' })
          patch.max = n
        }
        await updateJackpotRewardCategory('lsvp', patch)
      }

      if (nft !== undefined) {
        const patch = {}
        if (nft.enabled !== undefined) patch.enabled = Boolean(nft.enabled)
        if (nft.weight !== undefined) {
          const n = Number(nft.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'nft.weight must be zero or positive' })
          patch.weight = n
        }
        await updateJackpotRewardCategory('nft', patch)
      }

      if (cosmetic !== undefined) {
        const patch = {}
        if (cosmetic.enabled !== undefined) patch.enabled = Boolean(cosmetic.enabled)
        if (cosmetic.weight !== undefined) {
          const n = Number(cosmetic.weight)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'cosmetic.weight must be zero or positive' })
          patch.weight = n
        }
        if (cosmetic.pool !== undefined) {
          if (!Array.isArray(cosmetic.pool)) {
            return res.status(400).json({ message: 'cosmetic.pool must be an array' })
          }
          for (const item of cosmetic.pool) {
            if (!item?.id || !item?.name) {
              return res.status(400).json({ message: 'Every cosmetic.pool entry needs an id and a name' })
            }
          }
          patch.pool = cosmetic.pool.map((c) => ({ id: String(c.id), name: String(c.name), description: c.description || '' }))
        }
        await updateJackpotRewardCategory('cosmetic', patch)
      }

      if (
        lsvpCost === undefined &&
        lavaCoin === undefined &&
        lsvp === undefined &&
        nft === undefined &&
        cosmetic === undefined
      ) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const config = await getJackpotConfig()
      res.json({ config })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/jackpot/admin/held-payouts
   * Admin only — every LSVP jackpot reward currently sitting in
   * 'held_for_review' (see getReservedUnclaimedLsvpTotal's doc comment on
   * POST /claim/:transactionId above). The reward is still reserved for
   * the player named here; nothing has been paid or lost. Also reports
   * the admin wallet's current LSVP balance and the live reserved total so
   * the dashboard can show at a glance how much of a top-up is needed.
   */
  router.get('/admin/held-payouts', auth, requireAdmin, async (_req, res) => {
    try {
      const [rows, cancelledRows, adminBalance, reservedTotal] = await Promise.all([
        JackpotTransaction.find({ claimStatus: 'held_for_review' })
          .sort({ createdAt: 1 })
          .limit(200)
          .populate('userId', 'username'),
        // Recent write-offs too — not actionable, but an admin cancelling
        // a payout should stay visible/auditable somewhere, not vanish.
        JackpotTransaction.find({ claimStatus: 'cancelled' })
          .sort({ cancelledAt: -1 })
          .limit(50)
          .populate('userId', 'username'),
        getAdminLsvpBalance(),
        getReservedUnclaimedLsvpTotal(),
      ])

      res.json({
        adminBalance,
        reservedTotal,
        payouts: rows.map((t) => ({
          id: String(t._id),
          user: t.userId ? { id: String(t.userId._id), username: t.userId.username } : null,
          amount: t.rewardDetail?.amount ?? null,
          heldReason: t.heldReason,
          createdAt: t.createdAt,
        })),
        recentlyCancelled: cancelledRows.map((t) => ({
          id: String(t._id),
          user: t.userId ? { id: String(t.userId._id), username: t.userId.username } : null,
          amount: t.rewardDetail?.amount ?? null,
          cancelReason: t.cancelReason,
          cancelledByUsername: t.cancelledByUsername,
          cancelledAt: t.cancelledAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/jackpot/admin/held-payouts/:transactionId/retry
   * Admin only — manually re-attempt a held payout (e.g. after topping up
   * the admin wallet). Re-checks the reserve the same way a fresh claim
   * would: if the wallet still can't safely cover everything outstanding,
   * it stays held (this is NOT a bypass of the check — an admin can top
   * up funds, but can't force an over-committed payout through). This is
   * the one lever that keeps the admin in control of this feature: the
   * reserve check can only ever hold a payout back or let it through once
   * funds genuinely cover it — it never auto-pays without this action.
   */
  router.post('/admin/held-payouts/:transactionId/retry', auth, requireAdmin, async (req, res) => {
    const { transactionId } = req.params
    try {
      const transaction = await JackpotTransaction.findOneAndUpdate(
        { _id: transactionId, claimStatus: 'held_for_review' },
        { $set: { claimStatus: 'processing' } },
        { new: true }
      )
      if (!transaction) {
        return res.status(404).json({ message: 'No held payout found with that id' })
      }

      const user = await User.findById(transaction.userId).select('solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        await JackpotTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'held_for_review' } })
        return res.status(400).json({ message: 'This player no longer has a linked wallet — cannot retry yet' })
      }

      const [reservedTotal, adminBalance] = await Promise.all([
        getReservedUnclaimedLsvpTotal(),
        getAdminLsvpBalance(),
      ])
      if (reservedTotal > adminBalance) {
        transaction.claimStatus = 'held_for_review'
        transaction.heldReason = `Still short at retry: ${reservedTotal} LSVP owed across pending rewards vs ${adminBalance} LSVP in the admin wallet.`
        await transaction.save()
        return res.status(409).json({
          message: `Still not enough — ${reservedTotal} LSVP is owed across all pending rewards but the admin wallet only holds ${adminBalance}. Top up the wallet and retry again.`,
        })
      }

      const result = await settleLsvpPayout(transaction, user.solanaWalletAddress)
      if (!result.ok) {
        if (result.release) {
          await JackpotTransaction.findByIdAndUpdate(transaction._id, { $set: { claimStatus: 'held_for_review' } })
        }
        return res.status(result.status).json({ message: result.message })
      }
      res.json({
        claimStatus: result.claimStatus,
        txSignature: result.txSignature,
        explorerUrl: explorerTxUrl(result.txSignature),
        message: result.message,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/jackpot/admin/held-payouts/:transactionId/cancel
   * Admin only — a deliberate write-off: instead of waiting for the admin
   * wallet to be topped up, an admin decides this held reward will never
   * be paid. Requires a reason (same convention as adminPlayers.js's
   * POST /:username/correct) so there's always a record of why. Once
   * cancelled it's excluded from getReservedUnclaimedLsvpTotal (see its
   * $in list above — 'cancelled' is deliberately not in it) and can never
   * be retried or claimed again — this is a one-way door, unlike
   * 'held_for_review'.
   */
  router.post('/admin/held-payouts/:transactionId/cancel', auth, requireAdmin, async (req, res) => {
    const { transactionId } = req.params
    const reason = (req.body?.reason ?? '').toString().trim()
    if (!reason) {
      return res.status(400).json({ message: 'A reason is required to cancel/write off a held payout' })
    }
    try {
      const transaction = await JackpotTransaction.findOneAndUpdate(
        { _id: transactionId, claimStatus: 'held_for_review' },
        {
          $set: {
            claimStatus: 'cancelled',
            cancelReason: reason,
            cancelledByUsername: req.user.username,
            cancelledAt: new Date(),
          },
        },
        { new: true }
      )
      if (!transaction) {
        return res.status(404).json({ message: 'No held payout found with that id (it may have already been retried or cancelled)' })
      }
      console.warn(`Jackpot LSVP payout cancelled/written off — transaction ${transactionId}, by admin ${req.user.username}: ${reason}`)
      res.json({
        id: String(transaction._id),
        claimStatus: transaction.claimStatus,
        cancelReason: transaction.cancelReason,
        message: 'Payout cancelled — the player will see it marked as cancelled, no transfer will ever be attempted for it.',
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createJackpotRouter

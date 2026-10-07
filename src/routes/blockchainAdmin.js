import express from 'express'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { User } from '../models/User.js'
import { NftCollection } from '../models/NftCollection.js'
import { NftMint } from '../models/NftMint.js'
import { LsvpPurchaseRequest } from '../models/LsvpPurchaseRequest.js'
import { getLsvpBuyConfig, updateLsvpBuyConfig } from '../models/LsvpBuyConfig.js'
import { SOLANA_NETWORK, adminPublicKey, connection, explorerTxUrl } from '../config/solana.js'
import { scanAdminWalletNfts, transferNftFromAdmin } from '../solana/nftService.js'
import { transferLsvpFromAdmin, getAdminLsvpBalance, getTransferFinalStatus } from '../solana/tokenService.js'
import { releaseLsvpDailyUsage, todayDateKey } from '../models/LsvpDailyUsage.js'
import { requirePayoutsNotPaused, getPayoutConfig, setPayoutsPaused } from '../models/PayoutConfig.js'
import { LsvpPayment } from '../models/LsvpPayment.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'

/**
 * Builds the /api/admin/blockchain router — everything an admin needs to
 * run the Solana side of the game: see what NFTs the admin wallet holds,
 * publish them for sale, and approve/reject large LSVP purchases.
 *
 * Every route here is admin-only. Nothing in this file is reachable by a
 * regular player — see routes/blockchainUser.js for the player-facing side
 * of the same features.
 *
 * @param {string} jwtSecret
 * @param {Map<string, object>} [sessions] Live WebSocket sessions keyed by
 *   userId — used the same way every other admin-facing router uses it, so
 *   an approved LSVP purchase updates a connected player's coin balance
 *   immediately instead of waiting for a reconnect.
 */
export function createBlockchainAdminRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSessionCoins(userId, coins) {
    const session = sessions?.get(String(userId))
    if (session?.game?.setTotalCoins) {
      session.game.setTotalCoins(coins)
    }
  }

  /** Live published/sold/available counts for one collection, read straight from NftMint (never cached). */
  async function collectionCounts(collectionMintAddress) {
    const [inWallet, published, sold] = await Promise.all([
      NftMint.countDocuments({ collectionMintAddress, status: 'in_admin_wallet' }),
      NftMint.countDocuments({ collectionMintAddress, status: 'published' }),
      NftMint.countDocuments({ collectionMintAddress, status: 'sold' }),
    ])
    return { inWallet, published, sold, totalHeld: inWallet + published + sold }
  }

  function serializeCollection(collection, counts) {
    return {
      collectionMintAddress: collection.collectionMintAddress,
      name: collection.name,
      image: collection.image,
      priceLsvp: collection.priceLsvp,
      verified: collection.verified,
      jackpotEligible: collection.jackpotEligible,
      jackpotRewardQuantity: collection.jackpotRewardQuantity,
      jackpotRewardsGranted: collection.jackpotRewardsGranted,
      slotEligible: collection.slotEligible,
      slotRewardQuantity: collection.slotRewardQuantity,
      slotRewardsGranted: collection.slotRewardsGranted,
      ...counts,
    }
  }

  /**
   * GET /api/admin/blockchain/network
   * The active network, admin wallet address, and its live SOL + LSVP
   * balances — shown at the top of the admin Blockchain tab so it's always
   * obvious whether you're looking at Devnet or Mainnet, and whether the
   * admin wallet is actually funded.
   */
  router.get('/network', auth, requireAdmin, async (_req, res) => {
    try {
      if (!adminPublicKey) {
        return res.status(500).json({ message: 'Admin wallet is not configured (ADMIN_WALLET_SECRET_KEY missing)' })
      }
      const [solLamports, lsvpBalance] = await Promise.all([
        connection.getBalance(adminPublicKey),
        getAdminLsvpBalance(),
      ])
      res.json({
        network: SOLANA_NETWORK,
        adminWallet: adminPublicKey.toBase58(),
        adminSolBalance: solLamports / 1e9,
        adminLsvpBalance: lsvpBalance,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/nft-collections/sync
   * Re-scans the admin wallet on-chain and upserts NftCollection/NftMint
   * rows to match reality: new NFTs the wallet has received since the last
   * sync are added as 'in_admin_wallet'. Nothing already published or sold
   * is touched. This is the "backend returns all the NFTs and their
   * available supply" step — run it whenever new NFTs have been sent to
   * the admin wallet.
   */
  router.post('/nft-collections/sync', auth, requireAdmin, async (_req, res) => {
    try {
      const scanned = await scanAdminWalletNfts()

      for (const group of scanned) {
        await NftCollection.findOneAndUpdate(
          { collectionMintAddress: group.collectionMintAddress },
          {
            $setOnInsert: { collectionMintAddress: group.collectionMintAddress },
            $set: { name: group.collectionName, image: group.collectionImage, verified: group.verified },
          },
          { upsert: true }
        )

        for (const item of group.items) {
          // upsert: if this mint is already known (published or sold),
          // only its display info is refreshed — its status/owner is left
          // exactly as-is. A brand-new mint is inserted as 'in_admin_wallet'.
          await NftMint.findOneAndUpdate(
            { mintAddress: item.mintAddress },
            {
              $setOnInsert: {
                mintAddress: item.mintAddress,
                collectionMintAddress: group.collectionMintAddress,
                status: 'in_admin_wallet',
              },
              $set: { name: item.name, image: item.image },
            },
            { upsert: true }
          )
        }
      }

      const collections = await NftCollection.find().sort({ name: 1 })
      const withCounts = await Promise.all(
        collections.map(async (c) => serializeCollection(c, await collectionCounts(c.collectionMintAddress)))
      )
      res.json({ collections: withCounts })
    } catch (error) {
      console.error('NFT inventory sync failed:', error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/nft-collections
   * Every known collection with live counts, read from the DB (fast —
   * doesn't touch the Solana RPC). Use POST .../sync first to pick up NFTs
   * newly sent to the admin wallet.
   */
  router.get('/nft-collections', auth, requireAdmin, async (_req, res) => {
    try {
      const collections = await NftCollection.find().sort({ name: 1 })
      const withCounts = await Promise.all(
        collections.map(async (c) => serializeCollection(c, await collectionCounts(c.collectionMintAddress)))
      )
      res.json({ collections: withCounts })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/nft-collections/:collectionMintAddress/publish
   * Marks up to `count` currently-in-wallet NFTs from this collection as
   * 'published' (purchasable by players). If the collection has never been
   * priced, `priceLsvp` is required; if it's already priced, `priceLsvp` is
   * optional and only updates the price when provided.
   * Body: { count: number, priceLsvp?: number }
   */
  router.post('/nft-collections/:collectionMintAddress/publish', auth, requireAdmin, async (req, res) => {
    const { collectionMintAddress } = req.params
    const count = Number(req.body?.count)
    const priceLsvp = req.body?.priceLsvp !== undefined ? Number(req.body.priceLsvp) : undefined

    try {
      if (!Number.isInteger(count) || count <= 0) {
        return res.status(400).json({ message: 'count must be a positive whole number' })
      }

      const collection = await NftCollection.findOne({ collectionMintAddress })
      if (!collection) {
        return res.status(404).json({ message: 'Collection not found — run a sync first' })
      }

      if (priceLsvp !== undefined) {
        // Whole LSVP Tokens only — see utils/lsvpPricing.js.
        if (!isWholeTokenAmount(priceLsvp)) {
          return res.status(400).json({ message: 'priceLsvp must be a positive whole number of LSVP Tokens' })
        }
        collection.priceLsvp = priceLsvp
        await collection.save()
      } else if (collection.priceLsvp === null) {
        return res.status(400).json({ message: 'This collection has never been priced — set priceLsvp' })
      }

      const available = await NftMint.find({ collectionMintAddress, status: 'in_admin_wallet' }).limit(count)
      if (available.length === 0) {
        return res.status(400).json({ message: 'No un-published NFTs left in this collection' })
      }

      await NftMint.updateMany(
        { _id: { $in: available.map((m) => m._id) } },
        { $set: { status: 'published', publishedAt: new Date() } }
      )

      const counts = await collectionCounts(collectionMintAddress)
      res.json({
        message: `Published ${available.length} NFT${available.length === 1 ? '' : 's'} from ${collection.name}`,
        collection: serializeCollection(collection, counts),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/nft-collections/:collectionMintAddress/unpublish
   * Reverts up to `count` published-but-unsold NFTs back to
   * 'in_admin_wallet' — undoes an accidental publish. Never touches sold
   * NFTs.
   * Body: { count: number }
   */
  router.post('/nft-collections/:collectionMintAddress/unpublish', auth, requireAdmin, async (req, res) => {
    const { collectionMintAddress } = req.params
    const count = Number(req.body?.count)

    try {
      if (!Number.isInteger(count) || count <= 0) {
        return res.status(400).json({ message: 'count must be a positive whole number' })
      }

      const published = await NftMint.find({ collectionMintAddress, status: 'published' }).limit(count)
      await NftMint.updateMany(
        { _id: { $in: published.map((m) => m._id) } },
        { $set: { status: 'in_admin_wallet', publishedAt: null } }
      )

      const collection = await NftCollection.findOne({ collectionMintAddress })
      const counts = await collectionCounts(collectionMintAddress)
      res.json({
        message: `Unpublished ${published.length} NFT${published.length === 1 ? '' : 's'}`,
        collection: serializeCollection(collection, counts),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/admin/blockchain/nft-collections/:collectionMintAddress/jackpot-reward
   * Opts a collection into (or out of) the Jackpot Orb's real-NFT reward
   * category, and sets how many of its NFTs are budgeted for jackpot
   * rewards in total (see NftCollection.js's jackpotEligible/
   * jackpotRewardQuantity, and game/jackpotNftReward.js for how a draw
   * consumes this). This never touches which NFTs are published for direct
   * sale — the same 'in_admin_wallet' pool feeds both, so an admin should
   * budget the quantity here against whatever isn't also being published.
   * Body: { enabled: boolean, quantity: number }
   */
  router.put('/nft-collections/:collectionMintAddress/jackpot-reward', auth, requireAdmin, async (req, res) => {
    const { collectionMintAddress } = req.params
    const enabled = Boolean(req.body?.enabled)
    const quantity = Number(req.body?.quantity)

    try {
      if (!Number.isFinite(quantity) || quantity < 0) {
        return res.status(400).json({ message: 'quantity must be zero or a positive number' })
      }

      const collection = await NftCollection.findOneAndUpdate(
        { collectionMintAddress },
        { $set: { jackpotEligible: enabled, jackpotRewardQuantity: quantity } },
        { new: true }
      )
      if (!collection) {
        return res.status(404).json({ message: 'Collection not found — run a sync first' })
      }

      const counts = await collectionCounts(collectionMintAddress)
      res.json({ collection: serializeCollection(collection, counts) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/admin/blockchain/nft-collections/:collectionMintAddress/slot-reward
   * Opts a collection into (or out of) the Jackpot Slot Machine's real-NFT
   * reward category, and sets how many of its NFTs are budgeted for slot
   * rewards in total (see NftCollection.js's slotEligible/
   * slotRewardQuantity, and game/slotNftReward.js for how a draw consumes
   * this). This is a SEPARATE budget from the Jackpot Orb's jackpot-reward
   * route above — a collection can be opted into either, both, or neither.
   * Both, and direct-sale publishing, draw from the same 'in_admin_wallet'
   * pool, so an admin should budget quantities across all three together.
   * Body: { enabled: boolean, quantity: number }
   */
  router.put('/nft-collections/:collectionMintAddress/slot-reward', auth, requireAdmin, async (req, res) => {
    const { collectionMintAddress } = req.params
    const enabled = Boolean(req.body?.enabled)
    const quantity = Number(req.body?.quantity)

    try {
      if (!Number.isFinite(quantity) || quantity < 0) {
        return res.status(400).json({ message: 'quantity must be zero or a positive number' })
      }

      const collection = await NftCollection.findOneAndUpdate(
        { collectionMintAddress },
        { $set: { slotEligible: enabled, slotRewardQuantity: quantity } },
        { new: true }
      )
      if (!collection) {
        return res.status(404).json({ message: 'Collection not found — run a sync first' })
      }

      const counts = await collectionCounts(collectionMintAddress)
      res.json({ collection: serializeCollection(collection, counts) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/failed-transfers
   * NFTs that were paid for but whose on-chain transfer to the buyer
   * failed (see transferFailed on NftMint.js) — these need a manual retry.
   */
  router.get('/failed-transfers', auth, requireAdmin, async (_req, res) => {
    try {
      const mints = await NftMint.find({ transferFailed: true }).populate('ownerUserId', 'username')
      res.json({
        mints: mints.map((m) => ({
          mintAddress: m.mintAddress,
          name: m.name,
          collectionMintAddress: m.collectionMintAddress,
          owner: m.ownerUserId ? { id: String(m.ownerUserId._id), username: m.ownerUserId.username } : null,
          soldAt: m.soldAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/nft-mints/:mintAddress/retry-transfer
   * Retries sending an already-sold NFT to its owner's wallet. The buyer
   * already paid for this (see routes/blockchainUser.js's purchase route)
   * — this only re-attempts the on-chain send, it never re-charges anyone.
   */
  router.post('/nft-mints/:mintAddress/retry-transfer', auth, requireAdmin, async (req, res) => {
    try {
      // Atomically claim this mint for a retry attempt — moves
      // transferFailed:true -> 'processing' in one findOneAndUpdate so two
      // admins (or a double-click) can never both fire a transfer for the
      // same NFT. See models/NftMint.js's retryStatus.
      const mint = await NftMint.findOneAndUpdate(
        { mintAddress: req.params.mintAddress, status: 'sold', transferFailed: true, retryStatus: { $ne: 'processing' } },
        { $set: { retryStatus: 'processing' } },
        { new: true }
      )
      if (!mint) {
        const existing = await NftMint.findOne({ mintAddress: req.params.mintAddress })
        if (!existing) {
          return res.status(404).json({ message: 'NFT not found' })
        }
        if (existing.retryStatus === 'processing') {
          return res.status(409).json({ message: 'A retry for this NFT is already in progress' })
        }
        return res.status(409).json({ message: 'This NFT does not have a failed transfer to retry' })
      }

      const releaseRetryClaim = () =>
        NftMint.findByIdAndUpdate(mint._id, { $set: { retryStatus: null } }).catch(() => {})

      try {
        await requirePayoutsNotPaused()
      } catch (pauseError) {
        await releaseRetryClaim()
        return res.status(503).json({ message: pauseError.message })
      }

      const owner = await User.findById(mint.ownerUserId).select('solanaWalletAddress username')
      if (!owner?.solanaWalletAddress) {
        await releaseRetryClaim()
        return res.status(400).json({ message: 'Owner no longer has a linked wallet — cannot retry' })
      }

      let signature
      try {
        signature = await transferNftFromAdmin(mint.mintAddress, owner.solanaWalletAddress)
      } catch (transferError) {
        // UNCERTAIN TRANSFER — see tokenService.js's sendSignedTransfer doc
        // comment. Check the exact signature's real on-chain status before
        // deciding this retry failed: if it actually landed, mark it
        // resolved rather than leaving it retryable (which would risk
        // sending the same NFT twice).
        const status = await getTransferFinalStatus(transferError.signature)
        if (status.success) {
          signature = transferError.signature
        } else if (status.landed === null) {
          // Couldn't confirm either way right now — leave this OUT of
          // 'transferFailed' retry rotation (stay 'processing') so a
          // second retry click can't race an uncertain send.
          console.error(`NFT retry-transfer uncertain for mint ${mint.mintAddress} (signature ${transferError.signature}):`, transferError)
          return res.status(500).json({ message: 'Could not confirm this transfer — please check back shortly before retrying again.' })
        } else {
          await releaseRetryClaim()
          console.error(`Retry transfer failed for mint ${req.params.mintAddress}:`, transferError)
          return res.status(500).json({ message: transferError.message })
        }
      }

      mint.transferSignature = signature
      mint.transferFailed = false
      mint.retryStatus = null
      await mint.save()

      res.json({ message: `Transferred ${mint.name} to ${owner.username}`, txSignature: signature, explorerUrl: explorerTxUrl(signature) })
    } catch (error) {
      console.error(`Retry transfer failed for mint ${req.params.mintAddress}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/lsvp-buy-config
   * PUT /api/admin/blockchain/lsvp-buy-config
   * The coins-per-LSVP rate, the LSVP amount in a single purchase that
   * requires admin approval, and the per-player daily LSVP total that
   * also routes to admin approval once reached (see LsvpBuyConfig.js).
   */
  router.get('/lsvp-buy-config', auth, requireAdmin, async (_req, res) => {
    try {
      const config = await getLsvpBuyConfig()
      res.json({
        coinsPerLsvp: config.coinsPerLsvp,
        approvalThresholdLsvp: config.approvalThresholdLsvp,
        dailyLimitLsvp: config.dailyLimitLsvp,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  router.put('/lsvp-buy-config', auth, requireAdmin, async (req, res) => {
    try {
      const { coinsPerLsvp, approvalThresholdLsvp, dailyLimitLsvp } = req.body ?? {}
      if (coinsPerLsvp !== undefined && (!Number.isFinite(Number(coinsPerLsvp)) || Number(coinsPerLsvp) <= 0)) {
        return res.status(400).json({ message: 'coinsPerLsvp must be a positive number' })
      }
      if (approvalThresholdLsvp !== undefined && (!Number.isFinite(Number(approvalThresholdLsvp)) || Number(approvalThresholdLsvp) <= 0)) {
        return res.status(400).json({ message: 'approvalThresholdLsvp must be a positive number' })
      }
      if (dailyLimitLsvp !== undefined && (!Number.isFinite(Number(dailyLimitLsvp)) || Number(dailyLimitLsvp) <= 0)) {
        return res.status(400).json({ message: 'dailyLimitLsvp must be a positive number' })
      }
      const config = await updateLsvpBuyConfig({
        coinsPerLsvp: coinsPerLsvp !== undefined ? Number(coinsPerLsvp) : undefined,
        approvalThresholdLsvp: approvalThresholdLsvp !== undefined ? Number(approvalThresholdLsvp) : undefined,
        dailyLimitLsvp: dailyLimitLsvp !== undefined ? Number(dailyLimitLsvp) : undefined,
      })
      res.json({
        coinsPerLsvp: config.coinsPerLsvp,
        approvalThresholdLsvp: config.approvalThresholdLsvp,
        dailyLimitLsvp: config.dailyLimitLsvp,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/lsvp-requests?status=pending|approved|rejected|all
   * List LSVP purchase requests (defaults to 'pending', since that's the
   * admin's actual queue — approved/rejected history is available via the
   * status filter).
   */
  router.get('/lsvp-requests', auth, requireAdmin, async (req, res) => {
    try {
      const status = req.query.status || 'pending'
      const filter = status === 'all' ? {} : { status }
      const requests = await LsvpPurchaseRequest.find(filter).sort({ createdAt: -1 }).limit(500)
      res.json({ requests })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/lsvp-requests/:id/approve
   * Approves a pending request: deducts the Lava Coins now (atomic —
   * the `coins: {$gte}` guard means this can never overdraw the player,
   * even if their balance dropped since they submitted the request), then
   * sends the real on-chain LSVP transfer. If the deduction succeeds but
   * the on-chain transfer then fails, the coins are refunded immediately —
   * the player is never charged for a transfer that didn't happen.
   */
  router.post('/lsvp-requests/:id/approve', auth, requireAdmin, async (req, res) => {
    try {
      // Atomically claim this request for processing — moves
      // pending -> processing in one findOneAndUpdate so a concurrent
      // approve (double-click, two admin tabs) and a concurrent reject of
      // the SAME request can never both succeed. See
      // models/LsvpPurchaseRequest.js.
      const claimed = await LsvpPurchaseRequest.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        { $set: { status: 'processing' } },
        { new: true }
      )

      if (!claimed) {
        const existing = await LsvpPurchaseRequest.findById(req.params.id)
        if (!existing) {
          return res.status(404).json({ message: 'Request not found' })
        }
        if (existing.status === 'approved') {
          // Idempotent repeat — an earlier attempt already completed this
          // approval; hand back the same result instead of erroring.
          return res.json({ request: existing, explorerUrl: existing.txSignature ? explorerTxUrl(existing.txSignature) : null })
        }
        return res.status(409).json({ message: `Request is already ${existing.status}` })
      }

      const releaseBackToPending = () =>
        LsvpPurchaseRequest.findByIdAndUpdate(claimed._id, { $set: { status: 'pending' } }).catch(() => {})

      try {
        await requirePayoutsNotPaused()
      } catch (pauseError) {
        // Payouts are paused admin-side — leave this back at 'pending'
        // (not stuck 'processing') so an admin can simply approve again
        // once payouts resume.
        await releaseBackToPending()
        return res.status(503).json({ message: pauseError.message })
      }

      const chargedUser = await User.findOneAndUpdate(
        { _id: claimed.user, coins: { $gte: claimed.coinsSpent } },
        { $inc: { coins: -claimed.coinsSpent } },
        { new: true }
      ).select('coins')

      if (!chargedUser) {
        await releaseBackToPending()
        return res.status(400).json({ message: 'Player no longer has enough Lava Coins to approve this request' })
      }

      let signature
      try {
        signature = await transferLsvpFromAdmin(claimed.walletAddress, claimed.lsvpAmount)
      } catch (transferError) {
        // UNCERTAIN TRANSFER — send/confirm failing does NOT mean nothing
        // was sent (see tokenService.js's sendSignedTransfer doc comment).
        // Check the exact signature's real on-chain status before
        // refunding coins or releasing this back to 'pending' — doing
        // either on a transfer that actually landed would risk a double
        // payout (refund + a retried approval sending a second transfer).
        const status = await getTransferFinalStatus(transferError.signature)
        if (status.success) {
          signature = transferError.signature
        } else if (status.landed === null) {
          // Genuinely unknown right now — leave the coins charged and the
          // request 'processing' (NOT back to 'pending') so a retry can't
          // race an uncertain send. See GET /undelivered-payments-style
          // triage: an admin can check the signature directly on an
          // explorer and resolve this manually.
          console.error(`LSVP approval transfer uncertain for request ${req.params.id} (signature ${transferError.signature}):`, transferError)
          return res.status(500).json({ message: 'Could not confirm this payout — check the signature on an explorer before retrying.' })
        } else {
          // Confirmed failed — refund immediately and reopen for retry.
          const refunded = await User.findByIdAndUpdate(claimed.user, { $inc: { coins: claimed.coinsSpent } }, { new: true }).select('coins')
          syncLiveSessionCoins(claimed.user, refunded?.coins)
          await releaseBackToPending()
          console.error(`LSVP transfer failed while approving request ${req.params.id} — coins refunded:`, transferError)
          return res.status(500).json({ message: `On-chain transfer failed: ${transferError.message} (coins refunded)` })
        }
      }

      // SIGNATURE COLLISION GUARD — same risk as the auto-approve path in
      // blockchainUser.js: Ed25519 signing is deterministic, so two
      // different pending requests (same destination wallet + amount,
      // approved in the same blockhash window) can produce the SAME
      // signature, meaning only one of them is a real new transfer. The
      // 'processing' claim above stops THIS request from being approved
      // twice, but not a different request colliding with it. Check for
      // an existing *other* approved record on this exact signature before
      // saving, and let the unique index on txSignature
      // (models/LsvpPurchaseRequest.js) catch a dead-even race the check
      // misses.
      const existingForSignature = await LsvpPurchaseRequest.findOne({
        txSignature: signature,
        _id: { $ne: claimed._id },
      })
      if (existingForSignature) {
        const refunded = await User.findByIdAndUpdate(claimed.user, { $inc: { coins: claimed.coinsSpent } }, { new: true }).select('coins')
        syncLiveSessionCoins(claimed.user, refunded?.coins)
        await releaseBackToPending()
        console.error(`LSVP approval for request ${req.params.id} collided with an already-recorded transfer (signature ${signature}, existing request ${existingForSignature._id}) — coins refunded, no new transfer was sent for this request.`)
        return res.status(409).json({ message: 'This approval collided with another in-flight request and did not send a new transfer — the player\'s coins have been refunded. Please try approving again.' })
      }

      claimed.status = 'approved'
      claimed.txSignature = signature
      claimed.reviewedBy = req.user.sub
      claimed.reviewedAt = new Date()
      try {
        await claimed.save()
      } catch (saveError) {
        if (saveError?.code === 11000) {
          const refunded = await User.findByIdAndUpdate(claimed.user, { $inc: { coins: claimed.coinsSpent } }, { new: true }).select('coins')
          syncLiveSessionCoins(claimed.user, refunded?.coins)
          await releaseBackToPending()
          console.error(`LSVP approval for request ${req.params.id} lost a race on signature ${signature} (duplicate-key on save) — coins refunded, no new transfer was sent for this request.`)
          return res.status(409).json({ message: 'This approval collided with another in-flight request and did not send a new transfer — the player\'s coins have been refunded. Please try approving again.' })
        }
        throw saveError
      }

      syncLiveSessionCoins(claimed.user, chargedUser.coins)

      res.json({ request: claimed, explorerUrl: explorerTxUrl(signature) })
    } catch (error) {
      console.error(`LSVP request approval failed for ${req.params.id}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/admin/blockchain/lsvp-requests/:id/reject
   * Rejects a pending request. Nothing was ever deducted for a pending
   * request (see LsvpPurchaseRequest.js), so this leaves the player's coin
   * balance completely unchanged — same convention as cashout.js.
   * Body: { reason?: string }
   */
  router.post('/lsvp-requests/:id/reject', auth, requireAdmin, async (req, res) => {
    try {
      // Atomically claim this request — same pending -> processing gate as
      // approve, above, so approve-versus-reject of the SAME request can
      // never both win: whichever findOneAndUpdate lands first takes it
      // out of 'pending', and the other's identical match finds nothing.
      const claimed = await LsvpPurchaseRequest.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        { $set: { status: 'processing' } },
        { new: true }
      )

      if (!claimed) {
        const existing = await LsvpPurchaseRequest.findById(req.params.id)
        if (!existing) {
          return res.status(404).json({ message: 'Request not found' })
        }
        if (existing.status === 'rejected') {
          // Idempotent repeat.
          return res.json({ request: existing })
        }
        return res.status(409).json({ message: `Request is already ${existing.status}` })
      }

      // This request's lsvpAmount was reserved against the player's daily
      // limit at submit time (see routes/blockchainUser.js's POST
      // /lsvp/buy and models/LsvpDailyUsage.js) — a rejection means that
      // purchase never happens, so the reservation must be released back,
      // or the player would be permanently short that amount of their
      // daily allowance for a purchase that was never actually sent.
      // dateKey is derived from when the reservation was made (this
      // request's creation time), not "today" — a request approved/
      // rejected on a later calendar day must still release against the
      // day it was originally reserved for.
      await releaseLsvpDailyUsage(claimed.user, todayDateKey(claimed.createdAt), claimed.lsvpAmount)

      claimed.status = 'rejected'
      claimed.reviewedBy = req.user.sub
      claimed.reviewedAt = new Date()
      claimed.rejectionReason = req.body?.reason?.trim() || null
      await claimed.save()

      res.json({ request: claimed })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/payout-config
   * PUT /api/admin/blockchain/payout-config
   * The payout-pause kill switch (see models/PayoutConfig.js) — when
   * paused, every automatic on-chain payout path in the backend (LSVP
   * auto-buy, jackpot/slot claims, this router's own approve and
   * retry-transfer routes) falls through to a pending/admin-review state
   * instead of sending. Body for PUT: { paused: boolean, reason?: string }
   */
  router.get('/payout-config', auth, requireAdmin, async (_req, res) => {
    try {
      const config = await getPayoutConfig()
      res.json({ paused: config.paused, reason: config.reason, pausedAt: config.pausedAt })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  router.put('/payout-config', auth, requireAdmin, async (req, res) => {
    try {
      const paused = Boolean(req.body?.paused)
      const config = await setPayoutsPaused(paused, req.body?.reason)
      res.json({ paused: config.paused, reason: config.reason, pausedAt: config.pausedAt })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/admin/blockchain/undelivered-payments
   * "Paid but undelivered" admin view: on-chain LSVP payments that were
   * successfully claimed (so the player really did pay — see
   * models/LsvpPayment.js) but whose grant (energy/skin/item/NFT/orb/stage)
   * never finished — grantedAt is still null. This should only ever be a
   * brief in-flight state (see claimPaymentAndGrant's doc comment); a
   * payment sitting here for more than a couple of minutes means a request
   * crashed mid-grant and needs a manual look — usually just having the
   * player retry the same purchase with the same wallet, which will finish
   * the grant instead of bouncing off "already used" (see
   * claimPaymentAndGrant in models/LsvpPayment.js).
   */
  router.get('/undelivered-payments', auth, requireAdmin, async (_req, res) => {
    try {
      const payments = await LsvpPayment.find({ grantedAt: null })
        .sort({ createdAt: 1 })
        .limit(500)
        .populate('user', 'username')

      const now = Date.now()
      res.json({
        payments: payments.map((p) => ({
          id: String(p._id),
          txSignature: p.txSignature,
          user: p.user ? { id: String(p.user._id), username: p.user.username } : null,
          payerWallet: p.payerWallet,
          amountLsvp: p.amountLsvp,
          purpose: p.purpose,
          purposeRefId: p.purposeRefId,
          createdAt: p.createdAt,
          stuckForMs: now - new Date(p.createdAt).getTime(),
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

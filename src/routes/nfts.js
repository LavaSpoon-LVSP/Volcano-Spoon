import express from 'express'
import { Nft, PERK_KEYS } from '../models/Nft.js'
import { User } from '../models/User.js'
import { NftOwnership } from '../models/NftOwnership.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'

/**
 * Builds the /api/nfts router — the ARTIFACTS catalog (see models/Nft.js's
 * header comment for why this is artifacts-only now, not a general NFT
 * marketplace).
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — kept in the signature for
 *   parity with the other catalog routers (skins/items) even though this
 *   router no longer needs it itself: purchases are paid in LSVP now, not
 *   Lava Coins, so there's no in-memory HUD coin total to push to a live
 *   session anymore (see the purchase route below).
 */
export function createNftRouter(jwtSecret, _sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * One-time migration for a user who owned NFTs before the active/inactive
   * feature existed: back-fill activeNftIds with everything they already own
   * so those NFTs read as "active" (matching "always active from the
   * start") instead of silently defaulting to inactive just because they
   * were never explicitly added to activeNftIds. Guarded by
   * nftActiveInitialized so it only ever runs once per user — after that,
   * an empty activeNftIds legitimately means "the player turned everything
   * off", and this must not stomp on that.
   */
  async function ensureActiveNftIdsInitialized(user) {
    if (user.nftActiveInitialized) return user
    const owned = user.ownedNftIds ?? []
    const active = new Set(user.activeNftIds ?? [])
    owned.forEach((id) => active.add(id))
    user.activeNftIds = Array.from(active)
    user.nftActiveInitialized = true
    await user.save()
    return user
  }

  /**
   * GET /api/nfts/admin/all
   * Admin only — returns the FULL artifact catalog, including disabled ones.
   */
  router.get('/admin/all', auth, requireAdmin, async (_req, res) => {
    try {
      const nfts = await Nft.find().sort({ createdAt: -1 })
      res.json({ nfts })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/nfts
   * Public — returns enabled artifacts in the catalog.
   * Pass ?all=true to return all artifacts.
   */
  router.get('/', async (req, res) => {
    try {
      const filter = req.query.all === 'true' ? {} : { enabled: { $ne: false } }
      const nfts = await Nft.find(filter).sort({ createdAt: -1 })
      res.json({ nfts })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/nfts
   * Admin only — add a new artifact to the catalog.
   * Body: { name, description?, price, rarity, image, perkKey, enabled? }
   * `perkKey` is required — every entry in this catalog grants a gameplay
   * perk now (see models/Nft.js's header comment).
   */
  router.post('/', auth, requireAdmin, async (req, res) => {
    try {
      const { name, description, price, rarity, image, perkKey, enabled } = req.body ?? {}

      if (!name?.trim()) {
        return res.status(400).json({ message: 'Name is required' })
      }
      // Whole LSVP Tokens only — see utils/lsvpPricing.js.
      if (!isWholeTokenAmount(price)) {
        return res.status(400).json({ message: 'Price must be a positive whole number of LSVP Tokens' })
      }
      if (!image) {
        return res.status(400).json({ message: 'Image is required' })
      }
      if (!PERK_KEYS.includes(perkKey)) {
        return res.status(400).json({ message: `perkKey must be one of: ${PERK_KEYS.join(', ')}` })
      }

      const nft = await Nft.create({
        name: name.trim(),
        description: description?.trim() || undefined,
        price: Number(price),
        rarity: rarity || 'common',
        image,
        perkKey,
        enabled: enabled !== undefined ? Boolean(enabled) : true,
        createdBy: req.user.sub,
      })

      res.status(201).json({ nft })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/nfts/:id (or /admin/:id)
   * Admin only — edit an existing artifact in the catalog.
   * Body: { name?, description?, price?, rarity?, image?, perkKey?, enabled? }
   */
  async function handleUpdateNft(req, res) {
    try {
      const { name, description, price, rarity, image, perkKey, enabled } = req.body ?? {}
      const $set = {}

      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ message: 'Name cannot be empty' })
        $set.name = name.trim()
      }
      if (description !== undefined) {
        $set.description = description.trim()
      }
      if (price !== undefined) {
        if (!isWholeTokenAmount(price)) {
          return res.status(400).json({ message: 'Price must be a positive whole number of LSVP Tokens' })
        }
        $set.price = Number(price)
      }
      if (rarity !== undefined) {
        if (!['common', 'rare', 'epic', 'legendary'].includes(rarity)) {
          return res.status(400).json({ message: 'Invalid rarity' })
        }
        $set.rarity = rarity
      }
      if (image !== undefined) {
        if (!image) return res.status(400).json({ message: 'Image cannot be empty' })
        $set.image = image
      }
      if (perkKey !== undefined) {
        if (!PERK_KEYS.includes(perkKey)) {
          return res.status(400).json({ message: `perkKey must be one of: ${PERK_KEYS.join(', ')}` })
        }
        $set.perkKey = perkKey
      }
      if (enabled !== undefined) {
        $set.enabled = Boolean(enabled)
      }

      if (Object.keys($set).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const nft = await Nft.findByIdAndUpdate(req.params.id, { $set }, { new: true })
      if (!nft) {
        return res.status(404).json({ message: 'NFT not found' })
      }

      res.json({ nft })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.put('/admin/:id', auth, requireAdmin, handleUpdateNft)
  router.put('/:id', auth, requireAdmin, handleUpdateNft)

  /**
   * PATCH /api/nfts/:id/enabled (or /admin/:id/enabled)
   * Admin only — enable or disable an artifact in the catalog without deleting it.
   * Body: { enabled: boolean }
   */
  async function handleToggleNftEnabled(req, res) {
    try {
      const enabled = Boolean(req.body?.enabled)
      const nft = await Nft.findByIdAndUpdate(req.params.id, { $set: { enabled } }, { new: true })
      if (!nft) {
        return res.status(404).json({ message: 'NFT not found' })
      }
      res.json({ nft })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.patch('/admin/:id/enabled', auth, requireAdmin, handleToggleNftEnabled)
  router.patch('/:id/enabled', auth, requireAdmin, handleToggleNftEnabled)

  /**
   * DELETE /api/nfts/:id (or /admin/:id)
   * Admin only — permanently delete an artifact from the catalog.
   * Blocked server-side if any player already owns it.
   */
  async function handleDeleteNft(req, res) {
    try {
      // Block deletion once any player owns it
      const owned = await User.exists({ ownedNftIds: req.params.id })
      if (owned) {
        return res.status(409).json({ message: 'This NFT is owned by at least one player and cannot be deleted. Disable it instead to stop new purchases.' })
      }
      const deleted = await Nft.findByIdAndDelete(req.params.id)
      if (!deleted) {
        return res.status(404).json({ message: 'NFT not found' })
      }
      res.json({ message: 'NFT deleted', id: req.params.id })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.delete('/admin/:id', auth, requireAdmin, handleDeleteNft)
  router.delete('/:id', auth, requireAdmin, handleDeleteNft)

  /**
   * GET /api/nfts/me/owned
   * Auth required — the server-side source of truth for "what does this
   * user own, and which of those are active". Used by the Marketplace/
   * Profile/in-game HUD so ownership AND active/inactive state survive
   * logout/login, a different device, or a server restart instead of
   * living only in this browser's localStorage.
   */
  router.get('/me/owned', auth, async (req, res) => {
    try {
      let user = await User.findById(req.user.sub).select('ownedNftIds activeNftIds nftActiveInitialized')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }
      user = await ensureActiveNftIdsInitialized(user)
      res.json({ ownedIds: user.ownedNftIds ?? [], activeIds: user.activeNftIds ?? [] })
    } catch (error) {
      console.error('GET /api/nfts/me/owned failed:', error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PATCH /api/nfts/:id/active
   * Auth required — switch one owned NFT active or inactive. This is the
   * server-side backing for the Profile page's "Set Active"/"Deactivate"
   * button: persisted on User.activeNftIds so every device shows the same
   * active/inactive set, not just whichever browser last toggled it.
   * Body: { active: boolean }
   */
  router.patch('/:id/active', auth, async (req, res) => {
    const userId = req.user.sub
    const nftId = req.params.id
    const active = Boolean(req.body?.active)

    try {
      // Must own the NFT to toggle it — otherwise a player could "activate"
      // (and get perks/cosmetics from) something they never bought.
      const owner = await User.findOne({ _id: userId, ownedNftIds: nftId }).select('_id')
      if (!owner) {
        console.warn(`NFT active-toggle rejected: user ${userId} does not own ${nftId}`)
        return res.status(403).json({ message: 'You do not own this NFT' })
      }

      const update = active
        ? { $addToSet: { activeNftIds: nftId } }
        : { $pull: { activeNftIds: nftId } }

      const updatedUser = await User.findByIdAndUpdate(userId, {
        ...update,
        $set: { nftActiveInitialized: true },
      }, { new: true }).select('activeNftIds')

      console.log(`NFT active-toggle: user ${userId} set ${nftId} to ${active ? 'active' : 'inactive'}`)
      res.json({ activeIds: updatedUser.activeNftIds ?? [] })
    } catch (error) {
      console.error(`NFT active-toggle failed for user ${userId}, nft ${nftId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/nfts/:id/purchase
   * Auth required — the Volcanic Artifacts page's "Buy" action for a
   * catalog NFT. This is the only place that actually persists ownership.
   *
   * Priced and paid in LSVP Tokens, on-chain — same pattern as
   * routes/skins.js and routes/items.js (see those for the fuller
   * explanation of why: real on-chain NFT Collections, Spoon Skins and
   * Items all moved off Lava Coins so purchases carry real value, leaving
   * Lava Coins for everyday in-game spending only). `nft.price` is
   * denominated in whole LSVP Tokens, not coins, despite the historical
   * field name.
   *
   * Body: { txSignature } — the signature of an LSVP transfer the
   * player's own connected wallet already sent to the admin wallet. The
   * backend verifies that transfer actually happened on-chain for the
   * right amount before granting ownership; it never trusts the client's
   * word for it. `txSignature` can only ever be used once (see
   * models/LsvpPayment.js's unique index), so replaying the same payment
   * can't grant a second NFT.
   *
   * On success: adds the NFT id to User.ownedNftIds AND User.activeNftIds
   * — every NFT is active from the moment it's bought, on every device,
   * until the player explicitly deactivates it from Profile. The
   * `ownedNftIds: {$ne: nftId}` guard on the granting update makes it
   * atomic, so a double-submit (or two tabs racing) can never double-grant
   * from the same payment.
   *
   * A matching NftOwnership audit record (userId/nftId/purchaseDate/
   * transactionStatus/ownershipStatus) is created right after. Since this
   * DB isn't running as a replica set, true multi-document transactions
   * aren't available here — the LSVP payment is already spent and can't be
   * un-spent at that point, so if the audit write fails the ownership
   * grant is NOT rolled back (unlike the old Lava-Coin flow); it's logged
   * as an admin-visible edge case instead, exactly as skins.js's
   * race-branch does, since silently taking real on-chain payment and then
   * refusing to grant the NFT would be worse than a missing audit row.
   */
  router.post('/:id/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    const nftId = req.params.id
    const txSignature = req.body?.txSignature

    try {
      const [nft, user] = await Promise.all([
        Nft.findById(nftId),
        User.findById(userId).select('solanaWalletAddress ownedNftIds'),
      ])

      if (!nft) {
        console.warn(`NFT purchase failed: nft ${nftId} not found (user ${userId})`)
        return res.status(404).json({ message: 'NFT not found' })
      }
      if (nft.enabled === false) {
        return res.status(403).json({ message: 'This artifact is not currently available for purchase' })
      }
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link a Solana wallet before purchasing' })
      }
      if (user.ownedNftIds?.includes(nftId)) {
        return res.status(409).json({ message: 'You already own this NFT' })
      }

      const verification = await verifyLsvpPayment({
        txSignature,
        expectedAmountLsvp: nft.price,
        payerWallet: user.solanaWalletAddress,
      })
      if (!verification.ok) {
        return res.status(400).json({ message: verification.reason })
      }

      const nftSummary = () => ({
        id: String(nft._id),
        name: nft.name,
        description: nft.description,
        rarity: nft.rarity,
        image: nft.image,
        price: nft.price,
        perkKey: nft.perkKey,
      })

      // claimPaymentAndGrant makes this "pay, then own the NFT" sequence
      // safe to retry with the same signature — see its doc comment in
      // models/LsvpPayment.js. A request that died between claiming the
      // payment and granting ownership used to leave a player permanently
      // paid-but-empty-handed (409 "already used" forever after).
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: user.solanaWalletAddress,
        amountLsvp: nft.price,
        purpose: 'catalog_nft_purchase',
        purposeRefId: nftId,
        grant: async () => {
          const updatedUser = await User.findOneAndUpdate(
            { _id: userId, ownedNftIds: { $ne: nftId } },
            {
              $addToSet: { ownedNftIds: nftId, activeNftIds: nftId },
              $set: { nftActiveInitialized: true },
            },
            { new: true }
          )

          if (!updatedUser) {
            // Lost a race against a second concurrent purchase of the
            // same NFT — the payment is already spent and can't be
            // un-spent, so this is an admin-visible edge case rather than
            // a silent loss.
            console.error(`NFT purchase race: user ${userId} paid for ${nftId} but already owned it by the time the grant ran`)
            const error = new Error('You already own this NFT (payment recorded, contact support if it is missing)')
            error.status = 409
            throw error
          }

          try {
            const ownership = await NftOwnership.create({
              user: userId,
              nft: nftId,
              price: nft.price,
              purchaseDate: new Date(),
              transactionStatus: 'completed',
              ownershipStatus: 'owned',
            })

            console.log(`NFT purchase completed: user ${userId} bought ${nftId} for ${nft.price} LSVP`)

            return {
              message: `Purchased ${nft.name}!`,
              nft: nftSummary(),
              ownedIds: updatedUser.ownedNftIds,
              activeIds: updatedUser.activeNftIds,
              purchase: {
                id: String(ownership._id),
                purchaseDate: ownership.purchaseDate,
                transactionStatus: ownership.transactionStatus,
                ownershipStatus: ownership.ownershipStatus,
              },
            }
          } catch (auditError) {
            // The payment is already claimed and ownership already
            // granted — see the doc comment above for why this is logged
            // rather than rolled back. The player still got what they
            // paid for.
            console.error(`NFT purchase audit log failed for user ${userId}, nft ${nftId} (ownership was still granted):`, auditError)
            return {
              message: `Purchased ${nft.name}!`,
              nft: nftSummary(),
              ownedIds: updatedUser.ownedNftIds,
              activeIds: updatedUser.activeNftIds,
            }
          }
        },
        getGrantedResponse: async () => {
          const current = await User.findById(userId).select('ownedNftIds activeNftIds')
          return {
            message: `Purchased ${nft.name}!`,
            nft: nftSummary(),
            ownedIds: current?.ownedNftIds ?? [],
            activeIds: current?.activeNftIds ?? [],
          }
        },
      })

      res.status(201).json(result)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      console.error(`NFT purchase error for user ${userId}, nft ${nftId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

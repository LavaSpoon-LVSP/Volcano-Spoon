import express from 'express'
import { Skin } from '../models/Skin.js'
import { User } from '../models/User.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'

/**
 * Builds the /api/skins router — the "Spoon Skins" purchasable-cosmetic
 * feature (Volcanic Artifacts page → Spoon Skins section). Modeled on
 * routes/nfts.js (server-authoritative catalog + ownership, atomic
 * findOneAndUpdate purchase guard) but single-select rather than
 * multi-active: a user can own many skins but only ever has ONE equipped
 * (User.equippedSkinId), closer to arenaStages.js's currentArenaStage
 * pattern than to NFT's activeNftIds set. No separate audit collection
 * (unlike NftOwnership) — same lighter pattern as arena-stage unlocks,
 * since ownership already lives durably on User.ownedSkinIds.
 *
 * Equipping a skin ONLY changes what GameLogic._resolvePlayerSkin falls
 * back to when no temporary orb/powerup skin swap is active — it never
 * touches that existing temporary-swap behavior.
 *
 * Purchases are paid in LSVP Tokens, on-chain — see the purchase route
 * below and solana/paymentVerification.js — not Lava Coins.
 *
 * @param {string} jwtSecret
 * @param {Map<string, import('../game/ClientSession.js').ClientSession>} [sessions]
 *   Live WebSocket sessions keyed by userId — used so a connected player's
 *   equipped skin updates immediately in-game instead of waiting for their
 *   next reconnect.
 */
export function createSkinsRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSession(userId, { coins, equippedSkinId } = {}) {
    const session = sessions?.get(String(userId))
    if (!session?.game) return
    if (coins !== undefined && session.game.setTotalCoins) {
      session.game.setTotalCoins(coins)
    }
    if (equippedSkinId !== undefined && session.game.setEquippedSkin) {
      session.game.setEquippedSkin(equippedSkinId)
    }
  }

  /**
   * GET /api/skins/admin/all
   * Admin only — returns the FULL Spoon Skins catalog, including disabled ones.
   */
  router.get('/admin/all', auth, requireAdmin, async (_req, res) => {
    try {
      const skins = await Skin.find().sort({ createdAt: -1 })
      res.json({ skins })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/skins
   * Public — returns enabled skins in the catalog.
   * Pass ?all=true to return all skins.
   */
  router.get('/', async (req, res) => {
    try {
      const filter = req.query.all === 'true' ? {} : { enabled: { $ne: false } }
      const skins = await Skin.find(filter).sort({ createdAt: -1 })
      res.json({ skins })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/skins
   * Admin only — add a new Spoon Skin to the catalog.
   * Body: { name, description?, price, rarity, image, spriteKey, enabled? }
   */
  router.post('/', auth, requireAdmin, async (req, res) => {
    try {
      const { name, description, price, rarity, image, spriteKey, enabled } = req.body ?? {}

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
      if (!spriteKey?.trim()) {
        return res.status(400).json({ message: 'spriteKey is required' })
      }

      const skin = await Skin.create({
        name: name.trim(),
        description: description?.trim() || undefined,
        price: Number(price),
        rarity: rarity || 'common',
        image,
        spriteKey: spriteKey.trim(),
        enabled: enabled !== undefined ? Boolean(enabled) : true,
        createdBy: req.user.sub,
      })

      res.status(201).json({ skin })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/skins/:id (or /admin/:id)
   * Admin only — edit an existing Spoon Skin in the catalog.
   * Body: { name?, description?, price?, rarity?, image?, spriteKey?, enabled? }
   */
  async function handleUpdateSkin(req, res) {
    try {
      const { name, description, price, rarity, image, spriteKey, enabled } = req.body ?? {}
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
      if (spriteKey !== undefined) {
        const sk = spriteKey.trim()
        if (!sk) return res.status(400).json({ message: 'spriteKey cannot be empty' })
        const conflict = await Skin.exists({ spriteKey: sk, _id: { $ne: req.params.id } })
        if (conflict) {
          return res.status(400).json({ message: `Another skin already uses spriteKey "${sk}"` })
        }
        $set.spriteKey = sk
      }
      if (enabled !== undefined) {
        $set.enabled = Boolean(enabled)
      }

      if (Object.keys($set).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const skin = await Skin.findByIdAndUpdate(req.params.id, { $set }, { new: true })
      if (!skin) {
        return res.status(404).json({ message: 'Skin not found' })
      }

      res.json({ skin })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.put('/admin/:id', auth, requireAdmin, handleUpdateSkin)
  router.put('/:id', auth, requireAdmin, handleUpdateSkin)

  /**
   * PATCH /api/skins/:id/enabled (or /admin/:id/enabled)
   * Admin only — enable or disable a Spoon Skin without deleting it.
   * Body: { enabled: boolean }
   */
  async function handleToggleSkinEnabled(req, res) {
    try {
      const enabled = Boolean(req.body?.enabled)
      const skin = await Skin.findByIdAndUpdate(req.params.id, { $set: { enabled } }, { new: true })
      if (!skin) {
        return res.status(404).json({ message: 'Skin not found' })
      }
      res.json({ skin })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.patch('/admin/:id/enabled', auth, requireAdmin, handleToggleSkinEnabled)
  router.patch('/:id/enabled', auth, requireAdmin, handleToggleSkinEnabled)

  /**
   * DELETE /api/skins/:id (or /admin/:id)
   * Admin only — permanently remove a Spoon Skin from the catalog.
   * Blocked server-side if any player already owns it.
   */
  async function handleDeleteSkin(req, res) {
    try {
      const owned = await User.exists({ ownedSkinIds: req.params.id })
      if (owned) {
        return res.status(409).json({ message: 'This skin is owned by at least one player and cannot be deleted. Disable it instead to stop new purchases.' })
      }
      const deleted = await Skin.findByIdAndDelete(req.params.id)
      if (!deleted) {
        return res.status(404).json({ message: 'Skin not found' })
      }
      res.json({ message: 'Skin deleted', id: req.params.id })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  }

  router.delete('/admin/:id', auth, requireAdmin, handleDeleteSkin)
  router.delete('/:id', auth, requireAdmin, handleDeleteSkin)

  /**
   * GET /api/skins/me/owned
   * Auth required — server-side source of truth for which skins this user
   * owns and which one is equipped. `equippedSpriteKey` (not a Mongo id —
   * see the equip route below for why) is what the frontend compares
   * against each catalog skin's own `spriteKey` field to know which card to
   * mark EQUIPPED.
   */
  router.get('/me/owned', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('ownedSkinIds equippedSkinId')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }
      res.json({ ownedIds: user.ownedSkinIds ?? [], equippedSpriteKey: user.equippedSkinId ?? null })
    } catch (error) {
      console.error('GET /api/skins/me/owned failed:', error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/skins/:id/purchase
   * Auth required — buy a Spoon Skin with LSVP Tokens (paid on-chain, same
   * as NFTs — see routes/blockchainUser.js's NFT purchase route for the
   * full explanation of why). `skin.price` is denominated in whole LSVP
   * Tokens.
   *
   * Body: { txSignature } — the signature of an LSVP transfer the
   * player's own connected wallet already sent to the admin wallet. The
   * backend verifies that transfer actually happened on-chain for the
   * right amount before granting ownership; it never trusts the client's
   * word for it. `txSignature` can only ever be used once (see
   * models/LsvpPayment.js), so replaying the same payment can't grant a
   * second skin.
   *
   * The `ownedSkinIds: {$ne: skinId}` guard makes granting atomic, so a
   * double-submit can never double-grant. Purchasing does NOT auto-equip —
   * that's a separate, explicit step (POST /:id/equip).
   */
  router.post('/:id/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    const skinId = req.params.id
    const txSignature = req.body?.txSignature

    try {
      const [skin, user] = await Promise.all([
        Skin.findById(skinId),
        User.findById(userId).select('solanaWalletAddress ownedSkinIds'),
      ])

      if (!skin) {
        console.warn(`Skin purchase failed: skin ${skinId} not found (user ${userId})`)
        return res.status(404).json({ message: 'Skin not found' })
      }
      if (skin.enabled === false) {
        return res.status(403).json({ message: 'This skin is not currently available for purchase' })
      }
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link a Solana wallet before purchasing' })
      }
      if (user.ownedSkinIds?.includes(skinId)) {
        return res.status(409).json({ message: 'You already own this skin' })
      }

      const verification = await verifyLsvpPayment({
        txSignature,
        expectedAmountLsvp: skin.price,
        payerWallet: user.solanaWalletAddress,
      })
      if (!verification.ok) {
        return res.status(400).json({ message: verification.reason })
      }

      const skinResponse = (updatedUser) => ({
        message: `Purchased ${skin.name}!`,
        skin: {
          id: String(skin._id),
          name: skin.name,
          description: skin.description,
          rarity: skin.rarity,
          image: skin.image,
          spriteKey: skin.spriteKey,
          price: skin.price,
        },
        ownedIds: updatedUser.ownedSkinIds,
      })

      // claimPaymentAndGrant makes this "pay, then own the skin" sequence
      // safe to retry with the same signature — see its doc comment in
      // models/LsvpPayment.js. A request that died between claiming the
      // payment and granting the skin used to leave a player permanently
      // paid-but-empty-handed (409 "already used" forever after).
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: user.solanaWalletAddress,
        amountLsvp: skin.price,
        purpose: 'skin_purchase',
        purposeRefId: skinId,
        grant: async () => {
          const updatedUser = await User.findOneAndUpdate(
            { _id: userId, ownedSkinIds: { $ne: skinId } },
            { $addToSet: { ownedSkinIds: skinId } },
            { new: true }
          )

          if (!updatedUser) {
            // Lost a race against a second concurrent purchase of the
            // same skin — the payment is already spent and can't be
            // un-spent, so this is an admin-visible edge case rather than
            // a silent loss.
            console.error(`Skin purchase race: user ${userId} paid for ${skinId} but already owned it by the time the grant ran`)
            const error = new Error('You already own this skin (payment recorded, contact support if the skin is missing)')
            error.status = 409
            throw error
          }

          console.log(`Skin purchase completed: user ${userId} bought ${skinId} for ${skin.price} LSVP`)
          return skinResponse(updatedUser)
        },
        getGrantedResponse: async () => {
          const current = await User.findById(userId).select('ownedSkinIds')
          return skinResponse(current)
        },
      })

      res.status(201).json(result)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      console.error(`Skin purchase error for user ${userId}, skin ${skinId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/skins/:id/equip
   * Auth required — set this owned skin as the default equipped spoon
   * look. Must already own it. Single-select: equipping one implicitly
   * un-equips whatever was equipped before (no explicit "unequip" call
   * needed — passing the already-equipped id again is a harmless no-op).
   * If a live WS session is connected, the equipped skin is pushed to it
   * immediately so the change is visible without a reconnect.
   *
   * IMPORTANT: `:id` here is the Skin's Mongo _id (matches ownedSkinIds'
   * convention, and how the URL is built from the catalog). But what gets
   * stored on User.equippedSkinId — and what GameLogic._resolvePlayerSkin /
   * GameEngine's PLAYER_SPRITES map actually key on — is the skin's
   * `spriteKey` slug (e.g. 'thunderwhisper'), NOT the Mongo id. Storing the
   * raw Mongo id here was the original bug: PLAYER_SPRITES[<mongo id>] is
   * always undefined, so the equipped skin silently fell back to the
   * default spoon everywhere, in-game included.
   */
  router.post('/:id/equip', auth, async (req, res) => {
    const userId = req.user.sub
    const skinId = req.params.id

    try {
      const skin = await Skin.findById(skinId).select('spriteKey')
      if (!skin) {
        console.warn(`Skin equip failed: skin ${skinId} not found (user ${userId})`)
        return res.status(404).json({ message: 'Skin not found' })
      }

      const owner = await User.findOne({ _id: userId, ownedSkinIds: skinId }).select('_id')
      if (!owner) {
        console.warn(`Skin equip rejected: user ${userId} does not own ${skinId}`)
        return res.status(403).json({ message: 'You do not own this skin' })
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: { equippedSkinId: skin.spriteKey } },
        { new: true }
      ).select('equippedSkinId')

      syncLiveSession(userId, { equippedSkinId: updatedUser.equippedSkinId })

      console.log(`Skin equip: user ${userId} equipped ${skinId} (spriteKey: ${skin.spriteKey})`)
      res.json({ equippedSpriteKey: updatedUser.equippedSkinId })
    } catch (error) {
      console.error(`Skin equip failed for user ${userId}, skin ${skinId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/skins/unequip
   * Auth required — revert to the built-in default spoon look.
   */
  router.post('/unequip', auth, async (req, res) => {
    const userId = req.user.sub
    try {
      await User.findByIdAndUpdate(userId, { $set: { equippedSkinId: null } })
      syncLiveSession(userId, { equippedSkinId: null })
      res.json({ equippedSpriteKey: null })
    } catch (error) {
      console.error(`Skin unequip failed for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createSkinsRouter

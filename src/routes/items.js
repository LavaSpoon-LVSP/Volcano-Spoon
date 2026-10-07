import express from 'express'
import { Item } from '../models/Item.js'
import { ItemInventory } from '../models/ItemInventory.js'
import { User } from '../models/User.js'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { isWholeTokenAmount } from '../utils/lsvpPricing.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { verifyLsvpPayment } from '../solana/paymentVerification.js'
import { getImplementedEffectSummary, applyItemEffect } from '../game/itemEffects.js'

/**
 * Builds the /api/items router — the In-Game Items System. A NEW, separate,
 * expandable feature: does not read from or write to Nft.js, the
 * Marketplace, power-ups, or any existing reward/inventory system. Every
 * item is fully defined in the DB (see Item.js) and every change an admin
 * makes here is visible immediately — nothing is cached, every route reads
 * straight from Mongo.
 *
 * GET  /                        → public: enabled items catalog
 * GET  /me                      → auth: this user's inventory
 * POST /:id/purchase            → auth: buy an item with LSVP Tokens (paid on-chain)
 * POST /use                     → auth: generic consume-from-inventory hook
 * GET  /admin/all               → admin: full catalog (incl. disabled)
 * POST /admin                   → admin: create an item
 * PUT  /admin/:id                → admin: edit an item
 * PATCH /admin/:id/enabled       → admin: enable/disable without deleting
 * DELETE /admin/:id              → admin: delete an item
 * POST /admin/grant              → admin: grant an item (+ qty) to a user
 *
 * @param {string} jwtSecret
 */
export function createItemsRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * `effect` is the boundary described in game/itemEffects.js: non-null
   * only when this item's `properties.effect` is a type the server can
   * actually deliver. The frontend uses this (not `properties` directly,
   * and not the free-text `description`) to decide whether to show a
   * "Use" action at all — see A25: no item may promise an effect it does
   * not deliver.
   */
  function serializeItem(item) {
    return {
      id: String(item._id),
      name: item.name,
      description: item.description,
      icon: item.icon,
      rarity: item.rarity,
      price: item.price ?? 0,
      properties: item.properties ?? {},
      effect: getImplementedEffectSummary(item.properties),
      enabled: item.enabled,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  }

  /**
   * Reusable grant helper — ANY future acquisition path (Marketplace
   * purchase, gameplay reward, event drop, quest completion) should call
   * this instead of writing to ItemInventory directly, so quantity
   * accounting stays consistent everywhere. Atomic: $inc + upsert means
   * concurrent grants for the same (user, item) can never race/clobber
   * each other or create duplicate rows (see the unique index in
   * ItemInventory.js).
   */
  async function grantItemToUser(userId, itemId, quantity = 1, source = 'admin_grant') {
    return ItemInventory.findOneAndUpdate(
      { userId, itemId },
      {
        $inc: { quantity },
        $setOnInsert: { status: 'active' },
        $set: { source },
      },
      { upsert: true, new: true }
    )
  }

  /**
   * GET /api/items
   * Public — the live, enabled items catalog. Used by the game/Marketplace
   * to browse what items exist; always reads straight from the DB so an
   * admin's changes show up immediately, with no deploy or restart.
   */
  router.get('/', async (_req, res) => {
    try {
      const items = await Item.find({ enabled: true }).sort({ createdAt: -1 })
      res.json({ items: items.map(serializeItem) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/items/me
   * Auth required — this user's inventory: every (item, quantity, status)
   * row with quantity > 0, joined with the item's current catalog display
   * info (icon/name/description/rarity). If an item was deleted from the
   * catalog after being granted, that row is skipped (never shown as a
   * broken/blank entry).
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const rows = await ItemInventory.find({ userId: req.user.sub, quantity: { $gt: 0 } }).sort({ updatedAt: -1 })
      const itemIds = rows.map((r) => r.itemId)
      const items = await Item.find({ _id: { $in: itemIds } })
      const itemById = new Map(items.map((i) => [String(i._id), i]))

      const inventory = rows
        .map((row) => {
          const item = itemById.get(String(row.itemId))
          if (!item) return null
          return {
            itemId: String(item._id),
            name: item.name,
            description: item.description,
            icon: item.icon,
            rarity: item.rarity,
            price: item.price ?? 0,
            properties: item.properties ?? {},
            effect: getImplementedEffectSummary(item.properties),
            enabled: item.enabled,
            quantity: row.quantity,
            status: row.status,
            source: row.source,
            updatedAt: row.updatedAt,
          }
        })
        .filter(Boolean)

      res.json({ inventory })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/items/:id/purchase
   * Auth required — buy an in-game item with LSVP Tokens, paid on-chain
   * (same pattern as Spoon Skins and NFTs — see routes/skins.js and
   * routes/blockchainUser.js for the full explanation). `item.price` is
   * denominated in whole LSVP Tokens.
   *
   * Body: { txSignature } — the signature of an LSVP transfer the
   * player's connected wallet already sent to the admin wallet, verified
   * on-chain before the item is granted. A signature can only ever be
   * used once (models/LsvpPayment.js), so replaying a payment can't grant
   * a second item.
   *
   * Unlike NFTs (one copy per account), items STACK: buying the same item
   * again increments its quantity, matching how grants/drops already work.
   */
  router.post('/:id/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    const itemId = req.params.id
    const txSignature = req.body?.txSignature

    try {
      const [item, user] = await Promise.all([
        Item.findById(itemId),
        User.findById(userId).select('solanaWalletAddress'),
      ])

      if (!item) {
        return res.status(404).json({ message: 'Item not found' })
      }
      if (!item.enabled) {
        return res.status(403).json({ message: 'This item is not currently available' })
      }

      const price = Number(item.price ?? 0)
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(403).json({ message: 'This item is not for sale' })
      }
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link a Solana wallet before purchasing' })
      }

      const verification = await verifyLsvpPayment({
        txSignature,
        expectedAmountLsvp: price,
        payerWallet: user.solanaWalletAddress,
      })
      if (!verification.ok) {
        return res.status(400).json({ message: verification.reason })
      }

      // claimPaymentAndGrant makes this "pay, then receive the item"
      // sequence safe to retry with the same signature — see its doc
      // comment in models/LsvpPayment.js. A request that died between
      // claiming the payment and granting the item used to leave a player
      // permanently paid-but-empty-handed (409 "already used" forever
      // after).
      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: user.solanaWalletAddress,
        amountLsvp: price,
        purpose: 'item_purchase',
        purposeRefId: itemId,
        grant: async () => {
          const inventoryRow = await grantItemToUser(userId, itemId, 1, 'purchase')
          return {
            message: `Purchased ${item.name}!`,
            item: serializeItem(item),
            quantity: inventoryRow.quantity,
          }
        },
        getGrantedResponse: async () => {
          const current = await ItemInventory.findOne({ userId, itemId })
          return {
            message: `Purchased ${item.name}!`,
            item: serializeItem(item),
            quantity: current?.quantity ?? 0,
          }
        },
      })

      res.json(result)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/items/use
   * Auth required — "consume N of this item from my inventory AND deliver
   * its effect." Per A25 (reviewed handover): the "use" action must be
   * refused for any item with no implemented effect — quantity is never
   * decremented for a no-op "use," so a player can never be told an item
   * was consumed when nothing actually happened. See game/itemEffects.js
   * for what counts as "implemented."
   *
   * Ordering: the effect is applied FIRST, the inventory decrement second
   * (both still atomic/guarded individually). If the effect fails
   * (e.g. a concurrent request already changed something it depends on),
   * nothing is decremented. If decrementing fails after a successful
   * effect (should only happen on a genuine race where quantity ran out
   * between the two steps), the granted effect is not reversed — same
   * "never take back something already delivered" principle as every
   * other grant path in this codebase (see LsvpPayment.js's doc comment).
   *
   * Body: { itemId: string, quantity?: number (default 1) }
   */
  router.post('/use', auth, async (req, res) => {
    const userId = req.user.sub
    const itemId = req.body?.itemId
    const quantity = Number(req.body?.quantity ?? 1)

    if (!itemId) {
      return res.status(400).json({ message: 'itemId is required' })
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive integer' })
    }
    if (quantity !== 1) {
      // Every implemented effect today is a one-shot ("use one, get the
      // effect once") — using more than one at a time isn't meaningfully
      // defined yet, so reject rather than silently applying the effect
      // once while decrementing more than one.
      return res.status(400).json({ message: 'Items can only be used one at a time right now' })
    }

    try {
      const item = await Item.findById(itemId)
      if (!item) {
        return res.status(404).json({ message: 'Item not found' })
      }

      const effectSummary = getImplementedEffectSummary(item.properties)
      if (!effectSummary) {
        return res.status(400).json({ message: 'This item has no usable effect' })
      }

      const owned = await ItemInventory.findOne({ userId, itemId, quantity: { $gte: quantity } })
      if (!owned) {
        return res.status(400).json({ message: 'You do not own enough of this item' })
      }

      const effectResult = await applyItemEffect(userId, item.properties)

      const updated = await ItemInventory.findOneAndUpdate(
        { userId, itemId, quantity: { $gte: quantity } },
        { $inc: { quantity: -quantity } },
        { new: true }
      )

      res.json({
        itemId,
        quantityRemaining: updated?.quantity ?? owned.quantity,
        effect: effectSummary,
        ...effectResult,
      })
    } catch (error) {
      const status = error?.status && Number.isInteger(error.status) ? error.status : 500
      res.status(status).json({ message: error.message })
    }
  })

  /**
   * GET /api/items/admin/config  (aliased at /admin/all)
   * Admin only — the FULL catalog, including disabled items, for the
   * Admin Dashboard's management table.
   */
  router.get('/admin/all', auth, requireAdmin, async (req, res) => {
    try {
      const items = await Item.find().sort({ createdAt: -1 })
      res.json({ items: items.map(serializeItem) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/items/admin
   * Admin only — create a new in-game item.
   * Body: { name, description?, icon, rarity?, price?, properties? }
   */
  router.post('/admin', auth, requireAdmin, async (req, res) => {
    try {
      const { name, description, icon, rarity, price, properties } = req.body ?? {}

      if (!name?.trim()) {
        return res.status(400).json({ message: 'Name is required' })
      }
      if (!icon) {
        return res.status(400).json({ message: 'Icon is required' })
      }
      if (properties !== undefined && (typeof properties !== 'object' || Array.isArray(properties))) {
        return res.status(400).json({ message: 'properties must be an object' })
      }
      // Whole LSVP Tokens only (see /:id/purchase below — this is an
      // on-chain LSVP price, not Lava Coins, despite this field's name).
      // Optional — omitting it (or 0) means "not for sale", which keeps
      // the item grant-only, same as before this field existed.
      if (price !== undefined && !isWholeTokenAmount(price, { allowZero: true })) {
        return res.status(400).json({ message: 'price must be a whole number of LSVP Tokens (zero or more)' })
      }

      const item = await Item.create({
        name: name.trim(),
        description: description?.trim() || '',
        icon,
        rarity: rarity || 'common',
        price: price === undefined ? 0 : Number(price),
        properties: properties ?? {},
        createdBy: req.user.sub,
      })

      res.status(201).json({ item: serializeItem(item) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PUT /api/items/admin/:id
   * Admin only — edit any subset of an item's fields.
   * Body: { name?, description?, icon?, rarity?, price?, properties?, enabled? }
   */
  router.put('/admin/:id', auth, requireAdmin, async (req, res) => {
    try {
      const { name, description, icon, rarity, price, properties, enabled } = req.body ?? {}
      const $set = {}

      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ message: 'Name cannot be empty' })
        $set.name = name.trim()
      }
      if (description !== undefined) $set.description = description.trim()
      if (icon !== undefined) {
        if (!icon) return res.status(400).json({ message: 'Icon cannot be empty' })
        $set.icon = icon
      }
      if (rarity !== undefined) $set.rarity = rarity
      if (price !== undefined) {
        if (!isWholeTokenAmount(price, { allowZero: true })) {
          return res.status(400).json({ message: 'price must be a whole number of LSVP Tokens (zero or more)' })
        }
        $set.price = Number(price)
      }
      if (properties !== undefined) {
        if (typeof properties !== 'object' || Array.isArray(properties)) {
          return res.status(400).json({ message: 'properties must be an object' })
        }
        $set.properties = properties
      }
      if (enabled !== undefined) $set.enabled = Boolean(enabled)

      if (Object.keys($set).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' })
      }

      const item = await Item.findByIdAndUpdate(req.params.id, { $set }, { new: true })
      if (!item) {
        return res.status(404).json({ message: 'Item not found' })
      }

      res.json({ item: serializeItem(item) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PATCH /api/items/admin/:id/enabled
   * Admin only — enable/disable an item without deleting it (existing
   * owners keep whatever they already have; it just disappears from the
   * public catalog for new acquisitions).
   * Body: { enabled: boolean }
   */
  router.patch('/admin/:id/enabled', auth, requireAdmin, async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled)
      const item = await Item.findByIdAndUpdate(req.params.id, { $set: { enabled } }, { new: true })
      if (!item) {
        return res.status(404).json({ message: 'Item not found' })
      }
      res.json({ item: serializeItem(item) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * DELETE /api/items/admin/:id
   * Admin only — permanently remove an item from the catalog. Any
   * ItemInventory rows referencing it are left as-is (GET /me silently
   * skips rows whose item no longer exists) rather than silently deleting
   * a record of what a player used to own.
   */
  router.delete('/admin/:id', auth, requireAdmin, async (req, res) => {
    try {
      // Block deletion once any player owns at least one — an admin
      // handover-doc requirement ("Admin panel safety"): deleting a
      // catalog item out from under existing inventory rows would silently
      // orphan what players already paid for (GET /me would just stop
      // showing it). Disable it via setItemEnabled instead, which stops
      // new sales/grants without touching what's already owned.
      const owned = await ItemInventory.exists({ itemId: req.params.id, quantity: { $gt: 0 } })
      if (owned) {
        return res.status(409).json({ message: 'This item is owned by at least one player and cannot be deleted. Disable it instead to stop new purchases.' })
      }
      const deleted = await Item.findByIdAndDelete(req.params.id)
      if (!deleted) {
        return res.status(404).json({ message: 'Item not found' })
      }
      res.json({ message: 'Item deleted', id: req.params.id })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/items/admin/grant
   * Admin only — grant a quantity of an item directly to a user (by
   * username). This is the "Granted by the admin" acquisition path from
   * the spec, and it goes through the same grantItemToUser() helper any
   * future acquisition path (purchase/reward/quest/gameplay) would use.
   * Body: { username: string, itemId: string, quantity?: number (default 1) }
   */
  router.post('/admin/grant', auth, requireAdmin, async (req, res) => {
    try {
      const { username, itemId } = req.body ?? {}
      const quantity = Number(req.body?.quantity ?? 1)

      if (!username?.trim()) {
        return res.status(400).json({ message: 'username is required' })
      }
      if (!itemId) {
        return res.status(400).json({ message: 'itemId is required' })
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ message: 'quantity must be a positive integer' })
      }

      const [user, item] = await Promise.all([
        User.findOne({ username: username.trim() }).select('_id username'),
        Item.findById(itemId),
      ])

      if (!user) {
        return res.status(404).json({ message: `No user found with username "${username}"` })
      }
      if (!item) {
        return res.status(404).json({ message: 'Item not found' })
      }

      const row = await grantItemToUser(user._id, item._id, quantity, 'admin_grant')

      res.json({
        message: `Granted ${quantity}x "${item.name}" to ${user.username}`,
        username: user.username,
        itemId: String(item._id),
        quantity: row.quantity,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createItemsRouter

import mongoose from 'mongoose'

/**
 * In-Game Items catalog — a NEW, separate, expandable system. Distinct from
 * Nft.js (Marketplace collectibles) and JackpotConfig.js's cosmetic pool —
 * this is a generic catalog of consumable/ownable in-game items (potions,
 * boosters, tickets, event drops, quest rewards, etc.) that admins define
 * entirely through the Admin Dashboard, with no code changes required to
 * add a new item or a new item type.
 *
 * `properties` is deliberately a free-form object (Mixed) rather than a
 * fixed set of fields — an admin can attach whatever key/values a given
 * item needs (e.g. { effect: 'heal', amount: 25 }, { boost: 'coinMult',
 * multiplier: 2, durationSec: 300 }, or nothing at all for a purely
 * cosmetic/collectible item). Nothing in gameplay code is required to
 * understand any particular key — this is intentionally future-proof
 * scaffolding, not a finished effect system.
 *
 * IMPORTANT (see game/itemEffects.js): setting `properties.effect` here
 * does NOT by itself make the item do anything when a player "uses" it.
 * Only effect types actually implemented in game/itemEffects.js's
 * EFFECT_HANDLERS registry are delivered — right now that's just
 * `{ effect: 'energy_refill', amount: <1-25> }`. Any other value (or no
 * `effect` key) means the item has no usable effect: routes/items.js
 * hides its "Use" action from players rather than let its `description`
 * promise a benefit the game doesn't actually deliver (A25).
 */
const itemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: '',
      trim: true,
    },

    // Either a base64 data URL or a hosted image URL — same convention as Nft.image.
    icon: {
      type: String,
      required: true,
    },

    rarity: {
      type: String,
      enum: ['common', 'rare', 'epic', 'legendary'],
      default: 'common',
    },

    // LSVP Token cost to buy this item from the Volcanic Artifacts page,
    // paid on-chain (see routes/items.js POST /:id/purchase and
    // solana/paymentVerification.js).
    //
    // 0 means "not for sale" — the item still exists and can be granted by
    // an admin or awarded through gameplay, it just isn't purchasable.
    // Defaults to 0 so every pre-existing item stays non-purchasable until
    // an admin sets a price, rather than silently becoming free.
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/items.js's POST/PUT /admin (request level) via
    // utils/lsvpPricing.js.
    price: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },

    // Free-form, admin-defined key/value properties (effect, duration,
    // stack size, boost amount, etc.) — see class doc comment above.
    properties: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Whether this item is currently obtainable/visible via the public
    // catalog (GET /api/items). Disabling an item hides it from new
    // acquisition paths WITHOUT deleting it or touching anything already
    // in a player's inventory (see ItemInventory.js) — existing owned
    // copies are unaffected.
    enabled: {
      type: Boolean,
      default: true,
    },

    // A plain string, not an ObjectId ref — the admin dashboard logs in with
    // a single shared password (see server.js's POST /admin/login), not a
    // real User document, so there's no admin ObjectId to reference here.
    createdBy: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
)

export const Item = mongoose.model('Item', itemSchema)

export default Item

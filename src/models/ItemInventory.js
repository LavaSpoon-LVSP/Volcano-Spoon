import mongoose from 'mongoose'

/**
 * Per-user In-Game Items ownership ledger — one row per (user, item) pair,
 * with a `quantity` count rather than one document per unit owned. This is
 * the generic, reusable "does this user own this item, and how many"
 * source of truth that ANY acquisition path can write to: admin grants
 * today, and — without any schema change — future Marketplace purchases,
 * gameplay rewards, event drops, or quest completions (see
 * grantItemToUser() in routes/items.js, which every one of those paths
 * would call).
 *
 * Deliberately a separate collection from User.ownedNftIds/ownedCosmeticIds
 * (which are simple id arrays) because items need a quantity and a status,
 * not just a boolean "owned" — a player can hold N of the same item.
 */
const itemInventorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Item',
      required: true,
      index: true,
    },

    quantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Free-form status string — 'active' covers every case today; future
    // gameplay could introduce 'equipped', 'expired', etc. without a schema
    // change (no enum constraint, intentionally).
    status: {
      type: String,
      default: 'active',
    },

    // How this row's items were most recently acquired — purely
    // informational (shown in the inventory UI / admin tooling).
    // 'admin_grant' | 'purchase' | 'reward' | 'quest' | 'gameplay'
    source: {
      type: String,
      default: 'admin_grant',
    },
  },
  {
    timestamps: true,
  }
)

// One row per (user, item) — quantity is incremented in place rather than
// creating duplicate rows for repeat grants/purchases of the same item.
itemInventorySchema.index({ userId: 1, itemId: 1 }, { unique: true })

export const ItemInventory = mongoose.model('ItemInventory', itemInventorySchema)

export default ItemInventory

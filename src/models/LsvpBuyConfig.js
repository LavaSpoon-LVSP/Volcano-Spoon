import mongoose from 'mongoose'

/**
 * Singleton settings document controlling "buy LSVP Tokens with Lava
 * Coins" (see routes/blockchainUser.js POST /lsvp/buy). Same
 * singleton-by-key pattern as CashoutConfig.js — always exactly one
 * document, matched by `key: 'default'`.
 *
 * This is a DIFFERENT feature from the existing Lava Coin -> LSVP cash-out
 * (CashoutConfig.js / routes/cashout.js): that one credits an off-chain
 * `User.lsvpBalance` ledger number. This one sends real LSVP SPL tokens
 * on-chain to the player's connected wallet. Both currently exist side by
 * side — see the migration note in routes/blockchainUser.js.
 */
const lsvpBuyConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // How many Lava Coins buy 1 LSVP Token.
    coinsPerLsvp: {
      type: Number,
      required: true,
      min: 1,
      default: 100,
    },

    // Buying this many LSVP Tokens or more in a single purchase requires
    // manual admin approval instead of an instant on-chain transfer.
    approvalThresholdLsvp: {
      type: Number,
      required: true,
      min: 1,
      default: 100,
    },

    // Once a player's running total for the current calendar day
    // (server-local time) reaches this many LSVP Tokens, further
    // purchases that day are routed to admin approval instead of being
    // sent instantly -- whether that total is reached by one purchase or
    // several smaller ones added together. The running total counts both
    // instantly-approved purchases and requests still pending admin
    // approval (a rejected request frees its amount back up). This never
    // blocks a purchase outright; see routes/blockchainUser.js's
    // POST /lsvp/buy.
    dailyLimitLsvp: {
      type: Number,
      required: true,
      min: 1,
      default: 100,
    },

    // ── Treasury protection (see routes/blockchainUser.js POST /lsvp/buy) ──
    // Hard cap on LSVP in a single purchase; larger requests are rejected outright.
    maxLsvpPerTransaction: { type: Number, default: 1000, min: 1 },
    // Total LSVP across ALL players per calendar day; once reached, further
    // purchases route to admin approval instead of auto-sending.
    globalDailyLimitLsvp: { type: Number, default: 10000, min: 1 },

    // ── Ratio-change safety guard (see routes/blockchainAdmin.js PUT) ──
    // A single change larger than this % of the current rate (or outside
    // min/max) is refused unless the admin explicitly confirms an override.
    maxRateChangePercent: { type: Number, default: 50, min: 1 },
    minCoinsPerLsvp: { type: Number, default: 1, min: 1 },
    maxCoinsPerLsvp: { type: Number, default: 100000, min: 1 },
  },
  {
    timestamps: true,
  }
)

export const LsvpBuyConfig = mongoose.model('LsvpBuyConfig', lsvpBuyConfigSchema)

/** Fetch the singleton config, creating it with defaults on first use. */
export async function getLsvpBuyConfig() {
  return LsvpBuyConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Update the singleton config. Only the provided fields are changed. */
export const LSVP_BUY_CONFIG_FIELDS = [
  'coinsPerLsvp',
  'approvalThresholdLsvp',
  'dailyLimitLsvp',
  'maxLsvpPerTransaction',
  'globalDailyLimitLsvp',
  'maxRateChangePercent',
  'minCoinsPerLsvp',
  'maxCoinsPerLsvp',
]

export async function updateLsvpBuyConfig(patch = {}) {
  const update = {}
  for (const f of LSVP_BUY_CONFIG_FIELDS) {
    if (patch[f] !== undefined) update[f] = patch[f]
  }

  return LsvpBuyConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: update, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

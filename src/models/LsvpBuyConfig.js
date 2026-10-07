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
export async function updateLsvpBuyConfig({ coinsPerLsvp, approvalThresholdLsvp, dailyLimitLsvp } = {}) {
  const update = {}
  if (coinsPerLsvp !== undefined) update.coinsPerLsvp = coinsPerLsvp
  if (approvalThresholdLsvp !== undefined) update.approvalThresholdLsvp = approvalThresholdLsvp
  if (dailyLimitLsvp !== undefined) update.dailyLimitLsvp = dailyLimitLsvp

  return LsvpBuyConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: update, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

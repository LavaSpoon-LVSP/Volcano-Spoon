import mongoose from 'mongoose'

/**
 * Singleton settings document controlling the Lava Coin -> LSVP Token
 * cash-out system. There is always exactly one document, matched by
 * `key: 'default'`. Read/updated via getCashoutConfig()/updateCashoutConfig()
 * below rather than the model directly, so callers never need to worry
 * about the singleton/upsert mechanics.
 *
 * IMPORTANT: this is the ONLY place the conversion rate and daily
 * auto-approval limit live. Nothing in the codebase should hardcode
 * "100 Lava Coins = 1 LSVP Token" — always read it from here so admin
 * changes take effect immediately for every future conversion.
 */
const cashoutConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // How many Lava Coins are worth 1 LSVP Token.
    lavaPerLsvp: {
      type: Number,
      required: true,
      min: 1,
      default: 100,
    },

    // Max LSVP Tokens a single user can have auto-approved (no admin
    // review) within a single calendar day (UTC).
    dailyAutoApproveLimit: {
      type: Number,
      required: true,
      min: 0,
      default: 100,
    },
  },
  {
    timestamps: true,
  }
)

export const CashoutConfig = mongoose.model('CashoutConfig', cashoutConfigSchema)

/** Fetch the singleton config, creating it with defaults on first use. */
export async function getCashoutConfig() {
  const config = await CashoutConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return config
}

/**
 * Update the singleton config. Only the provided fields are changed —
 * omit a field to leave it as-is. Returns the updated document.
 */
export async function updateCashoutConfig({ lavaPerLsvp, dailyAutoApproveLimit } = {}) {
  const update = {}
  if (lavaPerLsvp !== undefined) update.lavaPerLsvp = lavaPerLsvp
  if (dailyAutoApproveLimit !== undefined) update.dailyAutoApproveLimit = dailyAutoApproveLimit

  const config = await CashoutConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: update, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return config
}

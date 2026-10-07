import mongoose from 'mongoose'

/**
 * Singleton admin flag: when `paused` is true, every automatic on-chain
 * payout path in the backend queues its request as pending instead of
 * sending — see requirePayoutsNotPaused() below, and its call sites in
 * routes/blockchainUser.js (POST /lsvp/buy's auto-approve path),
 * routes/blockchainAdmin.js (approve, retry-transfer), routes/jackpot.js
 * and routes/slotMachine.js (claim). Same singleton-by-key pattern as
 * every other *Config.js model in this codebase (findOneAndUpdate against
 * key:'default', upsert:true).
 *
 * This is a hard kill switch for a suspected exploit, a Solana outage, or
 * simply running low on admin-wallet funds — an admin can flip it on
 * without touching any other config, and every in-flight purchase attempt
 * degrades gracefully to "queued for admin approval" rather than either
 * failing outright or (worse) draining the admin wallet while something is
 * wrong.
 */
const payoutConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    paused: {
      type: Boolean,
      default: false,
    },

    // Optional free-text note an admin can leave for why payouts are
    // paused — shown in the admin dashboard, purely informational.
    reason: {
      type: String,
      default: null,
    },

    pausedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const PayoutConfig = mongoose.model('PayoutConfig', payoutConfigSchema)

/** Fetch the singleton config, creating it with defaults on first use. */
export async function getPayoutConfig() {
  return PayoutConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Pause or resume automatic payouts. */
export async function setPayoutsPaused(paused, reason) {
  return PayoutConfig.findOneAndUpdate(
    { key: 'default' },
    {
      $set: {
        paused: Boolean(paused),
        reason: paused ? (reason?.trim() || null) : null,
        pausedAt: paused ? new Date() : null,
      },
      $setOnInsert: { key: 'default' },
    },
    { upsert: true, new: true }
  )
}

/**
 * Throws a friendly Error (with `.paused = true` so callers can tell this
 * apart from any other error) if automatic payouts are currently paused.
 * Call this right before any automatic (non-admin-reviewed) on-chain
 * transfer would fire — NOT before something that was already going to
 * admin approval anyway, since that path is unaffected by the pause.
 */
export async function requirePayoutsNotPaused() {
  const config = await getPayoutConfig()
  if (config.paused) {
    const error = new Error(
      config.reason
        ? `Automatic payouts are temporarily paused (${config.reason}) — this request has been queued for admin approval instead.`
        : 'Automatic payouts are temporarily paused — this request has been queued for admin approval instead.'
    )
    error.paused = true
    throw error
  }
}

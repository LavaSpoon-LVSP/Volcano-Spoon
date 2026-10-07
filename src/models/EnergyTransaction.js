import mongoose from 'mongoose'

/**
 * Audit log for the Daily Energy System (see EnergyConfig.js /
 * EnergyService.js / routes/energy.js). One row per consume (game run
 * started), purchase (LSVP -> Energy or Unlimited Energy), or daily/admin
 * reset. Purely additive/logging — never read by gameplay logic, only by
 * the admin dashboard.
 */
const energyTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // 'consume'   — 1 Energy spent starting a game run.
    // 'purchase'  — LSVP spent for +5 / +10 / unlimited-hour.
    // 'regen'     — passive +1-per-interval recovery ticked (logged in
    //               aggregate, not per-tick, to avoid flooding the log).
    // 'daily_reset' — the daily full refill fired.
    // 'item_grant' — Energy granted by using an in-game Item with an
    //               implemented energy_refill effect (see game/itemEffects.js).
    // 'refund'    — a 'consume' above was reversed because its round never
    //               actually started (see EnergyService.refundEnergyForFailedStart
    //               / ClientSession's RUN_START_REFUND_WINDOW_MS usage).
    type: {
      type: String,
      enum: ['consume', 'purchase', 'regen', 'daily_reset', 'refund', 'item_grant'],
      required: true,
    },

    // Only set on 'purchase' transactions.
    lsvpSpent: {
      type: Number,
      default: 0,
    },

    // 'five' | 'ten' | 'unlimited' — only set on 'purchase' transactions.
    purchaseType: {
      type: String,
      enum: ['five', 'ten', 'unlimited', null],
      default: null,
    },

    // Energy value immediately after this transaction, for quick history
    // display without needing to re-derive it.
    energyAfter: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const EnergyTransaction = mongoose.model('EnergyTransaction', energyTransactionSchema)

export default EnergyTransaction

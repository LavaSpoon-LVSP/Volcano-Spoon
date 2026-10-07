import mongoose from 'mongoose'

/**
 * Tracks how many LSVP Tokens each player has RESERVED against the daily
 * auto-release limit (LsvpBuyConfig.dailyLimitLsvp) for one calendar day —
 * see routes/blockchainUser.js's POST /lsvp/buy.
 *
 * WHY THIS EXISTS: the daily limit used to be enforced by reading the sum
 * of today's LsvpPurchaseRequest rows, deciding auto-approve vs pending,
 * and only THEN creating a new row. That read-decide-write sequence isn't
 * atomic, so several parallel requests could each read the same "total so
 * far", each independently decide they're still under the limit, and all
 * get auto-approved — together sending well past the daily limit. This
 * collection closes that race: reserving a purchase's amount is now one
 * atomic `$inc`, so concurrent requests are strictly serialized by Mongo
 * itself and the running total can never be read stale.
 *
 * One document per (user, calendar day) — `key` is `${userId}_${dateKey}`
 * so a plain unique index is enough (no compound-unique-index juggling).
 * A reservation is made for EVERY purchase attempt that gets far enough to
 * matter (whether it ends up auto-approved or pending), and released again
 * if that attempt doesn't pan out (insufficient coins, failed transfer, or
 * a pending request later rejected) — see reserveLsvpDailyUsage/
 * releaseLsvpDailyUsage below and their call sites.
 */
const lsvpDailyUsageSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // YYYY-MM-DD, server-local time — matches the existing "calendar day"
    // convention POST /lsvp/buy already used for its (now-replaced) daily
    // total aggregate.
    dateKey: {
      type: String,
      required: true,
    },

    totalLsvp: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
)

export const LsvpDailyUsage = mongoose.model('LsvpDailyUsage', lsvpDailyUsageSchema)

/** Today's date key (server-local calendar day), matching the format reserveLsvpDailyUsage/releaseLsvpDailyUsage expect. */
export function todayDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Atomically adds `amountLsvp` to this user's running total for `dateKey`
 * and returns the document AFTER the increment — so the caller can decide
 * "does this purchase, plus everything already reserved today, cross the
 * daily limit?" from a number that can never be stale relative to another
 * concurrent reservation. Always succeeds (this never blocks a purchase by
 * itself — see POST /lsvp/buy for what happens once it does cross the
 * limit); call releaseLsvpDailyUsage to undo a reservation that didn't end
 * up going through.
 */
export async function reserveLsvpDailyUsage(userId, dateKey, amountLsvp) {
  const key = `${userId}_${dateKey}`
  return LsvpDailyUsage.findOneAndUpdate(
    { key },
    { $inc: { totalLsvp: amountLsvp }, $setOnInsert: { key, user: userId, dateKey } },
    { upsert: true, new: true }
  )
}

/** Undoes a reservation made by reserveLsvpDailyUsage — call this whenever the purchase attempt it was reserved for did NOT end up happening (insufficient balance, failed on-chain transfer, or an admin rejecting a pending request). */
export async function releaseLsvpDailyUsage(userId, dateKey, amountLsvp) {
  const key = `${userId}_${dateKey}`
  return LsvpDailyUsage.findOneAndUpdate(
    { key },
    { $inc: { totalLsvp: -amountLsvp } }
  )
}

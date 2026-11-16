import mongoose from 'mongoose'

/**
 * Global (all players) LSVP reservation total for one calendar day, checked
 * against LsvpBuyConfig.globalDailyLimitLsvp in POST /lsvp/buy. Same atomic
 * $inc reserve/release pattern as LsvpDailyUsage.js, same dateKey format.
 */
const schema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    totalLsvp: { type: Number, default: 0 },
  },
  { timestamps: true }
)

export const LsvpGlobalDailyUsage = mongoose.model('LsvpGlobalDailyUsage', schema)

export async function reserveGlobalLsvpUsage(dateKey, amountLsvp) {
  return LsvpGlobalDailyUsage.findOneAndUpdate(
    { dateKey },
    { $inc: { totalLsvp: amountLsvp }, $setOnInsert: { dateKey } },
    { upsert: true, new: true }
  )
}

export async function releaseGlobalLsvpUsage(dateKey, amountLsvp) {
  return LsvpGlobalDailyUsage.findOneAndUpdate({ dateKey }, { $inc: { totalLsvp: -amountLsvp } })
}

export async function getGlobalLsvpUsage(dateKey) {
  const doc = await LsvpGlobalDailyUsage.findOne({ dateKey })
  return doc?.totalLsvp || 0
}

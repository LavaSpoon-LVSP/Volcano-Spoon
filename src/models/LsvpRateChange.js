import mongoose from 'mongoose'

/**
 * Append-only audit trail of every admin change to the LSVP buy settings
 * (coins-per-LSVP rate, approval threshold, daily/global/per-transaction
 * limits, rate-change guard) and to the reward caps (Diamond Orb payout etc).
 * One document per changed field, written by routes/blockchainAdmin.js.
 */
const lsvpRateChangeSchema = new mongoose.Schema(
  {
    // 'coinsPerLsvp' | 'approvalThresholdLsvp' | 'dailyLimitLsvp' | ...
    field: { type: String, required: true },
    // Which config document the field belongs to: 'lsvpBuy' | 'rewardCaps'.
    scope: { type: String, default: 'lsvpBuy' },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    // Only meaningful for numeric fields: (new - old) / old * 100.
    changePercent: { type: Number, default: null },
    changedBy: { type: String, default: null },
    note: { type: String, default: null },
    overrideUsed: { type: Boolean, default: false },
  },
  { timestamps: true }
)

lsvpRateChangeSchema.index({ createdAt: -1 })

export const LsvpRateChange = mongoose.model('LsvpRateChange', lsvpRateChangeSchema)

/** Percent change from old to new, rounded to 2 decimals; null if old is 0/not numeric. */
export function percentChange(oldValue, newValue) {
  const o = Number(oldValue)
  const n = Number(newValue)
  if (!Number.isFinite(o) || !Number.isFinite(n) || o === 0) return null
  return Math.round(((n - o) / o) * 10000) / 100
}

/** Writes one audit row per field whose value actually changed. */
export async function logConfigChanges({ scope, before, after, fields, changedBy, note, overrideUsed }) {
  const rows = []
  for (const field of fields) {
    if (before?.[field] === after?.[field]) continue
    rows.push({
      field,
      scope,
      oldValue: before?.[field] ?? null,
      newValue: after?.[field] ?? null,
      changePercent: typeof after?.[field] === 'number' ? percentChange(before?.[field], after?.[field]) : null,
      changedBy: changedBy || null,
      note: note || null,
      overrideUsed: Boolean(overrideUsed),
    })
  }
  if (rows.length) await LsvpRateChange.insertMany(rows)
  return rows.length
}

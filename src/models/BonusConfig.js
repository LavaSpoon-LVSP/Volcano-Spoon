import mongoose from 'mongoose'

/**
 * Singleton settings for the optional DAILY LOGIN COIN BONUS (economy tuning aid).
 * Same `key: 'default'` pattern as EnergyConfig / LsvpBuyConfig.
 *
 * OFF by default: nothing is granted until an admin sets dailyBonusEnabled=true.
 * dailyBonusCoins is capped at MAX_DAILY_BONUS_COINS so a typo cannot hand out
 * a treasury-sized amount (coins convert to LSVP at coinsPerLsvp).
 */
export const MAX_DAILY_BONUS_COINS = 500

const bonusConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    dailyBonusEnabled: { type: Boolean, default: false },
    dailyBonusCoins: { type: Number, default: 25, min: 1, max: MAX_DAILY_BONUS_COINS },
  },
  { timestamps: true },
)

export const BonusConfig = mongoose.models.BonusConfig || mongoose.model('BonusConfig', bonusConfigSchema)

export async function getBonusConfig() {
  return BonusConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
}

export async function updateBonusConfig(patch) {
  return BonusConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: patch, $setOnInsert: { key: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
}

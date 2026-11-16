import mongoose from 'mongoose'
import { DIAMOND_COIN_PAYOUT } from '../game/constants.js'

/**
 * Singleton admin-editable caps on exceptional coin payouts (Diamond Orb).
 * Same `key: 'default'` pattern as every other *Config.js. Defaults reproduce
 * the previous hardcoded behaviour exactly, so nothing changes until an admin
 * edits it.
 */
export const DEFAULT_MAX_COINS_PER_RUN = 1_000_000_000_000

const rewardCapsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    // Raw Lava Coins paid once per run when a Diamond Orb is collected (before the stage multiplier).
    diamondOrbCoinPayout: { type: Number, default: DIAMOND_COIN_PAYOUT, min: 0 },
    // false = the orb still spawns and gives its boost, but pays 0 coins.
    diamondOrbEnabled: { type: Boolean, default: true },
    // Hard clamp on the final coins credited for ONE run (after the stage multiplier).
    maxCoinsPerRun: { type: Number, default: DEFAULT_MAX_COINS_PER_RUN, min: 1 },
  },
  { timestamps: true }
)

export const RewardCapsConfig = mongoose.models.RewardCapsConfig || mongoose.model('RewardCapsConfig', rewardCapsSchema)

export async function getRewardCapsConfig() {
  return RewardCapsConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
}

export async function updateRewardCapsConfig(patch) {
  return RewardCapsConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: patch, $setOnInsert: { key: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
}

// Short-TTL cache so the game server never hits the DB once per run.
const CACHE_TTL_MS = 30_000
let cached = null
let cachedAt = 0

/** Effective values for the game server: { diamondCoinPayout, maxCoinsPerRun }. Falls back to defaults on any DB error. */
export async function getEffectiveRewardCaps({ force = false } = {}) {
  const now = Date.now()
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return cached
  try {
    const c = await getRewardCapsConfig()
    cached = {
      diamondCoinPayout: c.diamondOrbEnabled ? c.diamondOrbCoinPayout : 0,
      maxCoinsPerRun: c.maxCoinsPerRun,
    }
  } catch (err) {
    console.error('reward caps lookup failed, using defaults:', err?.message)
    cached = cached || { diamondCoinPayout: DIAMOND_COIN_PAYOUT, maxCoinsPerRun: DEFAULT_MAX_COINS_PER_RUN }
  }
  cachedAt = now
  return cached
}

export function invalidateRewardCapsCache() {
  cached = null
  cachedAt = 0
}

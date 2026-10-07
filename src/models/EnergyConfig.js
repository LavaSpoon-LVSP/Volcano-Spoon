import mongoose from 'mongoose'

/**
 * Singleton settings document controlling the Daily Energy System (additive
 * anti-farming feature — see src/game/EnergyService.js, src/routes/energy.js,
 * User.energy/energyLastRegenAt/energyLastDailyResetAt/unlimitedEnergyUntil).
 *
 * Same pattern as JackpotConfig.js / CashoutConfig.js / ArenaStageConfig.js:
 * one document matched by `key: 'default'`, read/updated via the getters/
 * setters below so an admin can retune every number/toggle at runtime —
 * nothing here is ever hardcoded in route or game-start code.
 */
const energyConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // Full tank size. Also what a daily reset refills to.
    maxEnergy: {
      type: Number,
      default: 10,
      min: 1,
    },

    // ── Recovery method 1: +1 Energy every N minutes, up to maxEnergy ──
    regenEnabled: {
      type: Boolean,
      default: true,
    },
    regenIntervalMinutes: {
      type: Number,
      default: 30,
      min: 1,
    },

    // ── Recovery method 2: automatic full refill at local midnight ──
    dailyResetEnabled: {
      type: Boolean,
      default: true,
    },
    // IANA timezone name (e.g. 'UTC', 'America/New_York') — the "midnight"
    // boundary for the daily reset is computed in this timezone, not raw
    // server time, so admins in any region get a predictable reset hour.
    dailyResetTimezone: {
      type: String,
      default: 'UTC',
    },

    // ── LSVP purchase costs (never hardcoded in route code) ──
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/energy.js's PUT /admin/config (request level) via
    // utils/lsvpPricing.js.
    lsvpCostFive: {
      type: Number,
      default: 100,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },
    lsvpCostTen: {
      type: Number,
      default: 180,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },
    lsvpCostUnlimitedHour: {
      type: Number,
      default: 300,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },
  },
  {
    timestamps: true,
  }
)

export const EnergyConfig = mongoose.model('EnergyConfig', energyConfigSchema)

/** Always fetches (creating with defaults on first use) the singleton document. */
async function getConfigDoc() {
  return EnergyConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Fetch the full live config as a plain object (safe to JSON-serialize). */
export async function getEnergyConfig() {
  const config = await getConfigDoc()
  return config.toObject({ versionKey: false })
}

/**
 * Update any subset of the Energy config. Body may contain any of:
 * maxEnergy, regenEnabled, regenIntervalMinutes, dailyResetEnabled,
 * dailyResetTimezone, lsvpCostFive, lsvpCostTen, lsvpCostUnlimitedHour.
 * Returns the full updated config.
 */
export async function updateEnergyConfig(patch) {
  const $set = {}
  const fields = [
    'maxEnergy', 'regenEnabled', 'regenIntervalMinutes',
    'dailyResetEnabled', 'dailyResetTimezone',
    'lsvpCostFive', 'lsvpCostTen', 'lsvpCostUnlimitedHour',
  ]
  for (const field of fields) {
    if (patch[field] !== undefined) $set[field] = patch[field]
  }
  await EnergyConfig.findOneAndUpdate(
    { key: 'default' },
    { $set, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return getEnergyConfig()
}

export default EnergyConfig

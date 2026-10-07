import mongoose from 'mongoose'

/**
 * Singleton settings document controlling the Arena Stages economy:
 *   - unlockCosts     — LSVP Token cost to unlock each stage (2-8; Stage 1
 *                       is always unlocked/free for every new user).
 *   - rewardMultipliers — per-stage Lava Coin reward multiplier (1-8).
 *   - rareOrbChances    — per-stage rare-orb (diamond/jackpot/mythic) spawn
 *                       chance, expressed as a whole-number percentage (1-8).
 *
 * Same pattern as CashoutConfig.js: one document matched by `key: 'default'`,
 * read/updated via the getters/setters below so an admin can retune any of
 * these at runtime without a deploy, and nothing in game/route code ever
 * hardcodes a price, multiplier, or rate.
 *
 * NOTE: unlockCosts used to be denominated in Lava Coins; as of the
 * progression/economy rebalance, arena unlocks are paid in LSVP Tokens
 * instead (see routes/arenaStages.js POST /unlock) — only the currency
 * changed, not the mechanism.
 */
const arenaStageConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // LSVP Token cost to unlock each stage, keyed by stage number (as a
    // string — Mongoose Map keys are always strings). No entry for stage 1
    // since it's never purchased.
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/arenaStages.js's PUT /admin/config (request level) via
    // utils/lsvpPricing.js.
    unlockCosts: {
      type: Map,
      of: {
        type: Number,
        validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
      },
      default: () => new Map([
        ['2', 25],
        ['3', 75],
        ['4', 250],
        ['5', 750],
        ['6', 1500],
        ['7', 3500],
        ['8', 7500],
      ]),
    },

    // Lava Coin reward multiplier applied to a run's coin haul, keyed by
    // stage number. Includes stage 1 (baseline, 1.0x — no boost).
    rewardMultipliers: {
      type: Map,
      of: Number,
      default: () => new Map([
        ['1', 1.0],
        ['2', 1.5],
        ['3', 2.5],
        ['4', 4.0],
        ['5', 6.0],
        ['6', 9.0],
        ['7', 13.0],
        ['8', 18.0],
      ]),
    },

    // Rare-orb (diamond/jackpot/mythic) spawn chance per stage, as a
    // whole-number percentage. Includes stage 1 (baseline rate).
    rareOrbChances: {
      type: Map,
      of: Number,
      default: () => new Map([
        ['1', 5],
        ['2', 7],
        ['3', 9],
        ['4', 12],
        ['5', 15],
        ['6', 18],
        ['7', 22],
        ['8', 27],
      ]),
    },
  },
  {
    timestamps: true,
  }
)

export const ArenaStageConfig = mongoose.model('ArenaStageConfig', arenaStageConfigSchema)

/** Always fetches (creating with defaults on first use) the singleton document. */
async function getConfigDoc() {
  return ArenaStageConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Fetch the singleton config (as a plain { [stage]: cost } object). */
export async function getArenaStageUnlockCosts() {
  const config = await getConfigDoc()
  return Object.fromEntries(config.unlockCosts)
}

/** Update a single stage's unlock cost (LSVP). Returns the full updated cost map as a plain object. */
export async function updateArenaStageUnlockCost(stage, cost) {
  const config = await ArenaStageConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: { [`unlockCosts.${stage}`]: cost }, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return Object.fromEntries(config.unlockCosts)
}

/** Fetch the reward-multiplier map (as a plain { [stage]: multiplier } object). */
export async function getArenaRewardMultipliers() {
  const config = await getConfigDoc()
  return Object.fromEntries(config.rewardMultipliers)
}

/** Update a single stage's reward multiplier. Returns the full updated map as a plain object. */
export async function updateArenaRewardMultiplier(stage, multiplier) {
  const config = await ArenaStageConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: { [`rewardMultipliers.${stage}`]: multiplier }, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return Object.fromEntries(config.rewardMultipliers)
}

/** Fetch the rare-orb-chance map (as a plain { [stage]: percent } object). */
export async function getArenaRareOrbChances() {
  const config = await getConfigDoc()
  return Object.fromEntries(config.rareOrbChances)
}

/** Update a single stage's rare orb chance (%). Returns the full updated map as a plain object. */
export async function updateArenaRareOrbChance(stage, percent) {
  const config = await ArenaStageConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: { [`rareOrbChances.${stage}`]: percent }, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return Object.fromEntries(config.rareOrbChances)
}

/** Fetch all three maps at once — used by the admin GET endpoint and by
 *  ClientSession when applying a stage's live economy config to GameLogic. */
export async function getArenaEconomyConfig() {
  const config = await getConfigDoc()
  return {
    unlockCosts:       Object.fromEntries(config.unlockCosts),
    rewardMultipliers: Object.fromEntries(config.rewardMultipliers),
    rareOrbChances:    Object.fromEntries(config.rareOrbChances),
  }
}

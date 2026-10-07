import mongoose from 'mongoose'

/**
 * Singleton settings document controlling the Jackpot Slot Machine — a NEW,
 * additive feature. Players insert Jackpot Tokens (earned by collecting
 * natural in-game Jackpot Orbs — see GameLogic.js's 'jackpot' orb-collision
 * case and ClientSession.saveJackpotTokens()) to spin, and win Lava Coins or
 * a real, on-chain NFT (see routes/slotMachine.js, game/slotNftReward.js).
 *
 * LSVP was removed as a slot reward category (the game only grants real,
 * on-chain LSVP now — see routes/jackpot.js, arenaStages.js, energy.js —
 * and a slot machine can't hand out a real on-chain token, only credit an
 * off-chain balance, which is exactly the "static" LSVP this project moved
 * away from). Its reward weight isn't redistributed anywhere explicitly;
 * removing it from the enabled pool means the remaining categories'
 * relative odds rise automatically (see buildRewardPreview in
 * routes/slotMachine.js — chancePercent is weight ÷ total ENABLED weight).
 *
 * Completely separate from the existing purchasable Jackpot Orb feature
 * (JackpotConfig.js / routes/jackpot.js) — that system spends LSVP to buy
 * an orb, then draws from its own lavaCoin/nft/cosmetic pool. This one
 * spends Jackpot Tokens (a currency earned only by playing, never bought)
 * and draws from coins/nft.
 *
 * Same pattern as JackpotConfig.js: one document matched by `key: 'default'`,
 * read/updated via the getters/setters below so an admin can retune the
 * spin cost, odds, and payouts at runtime — nothing here is hardcoded in
 * route code.
 */
const slotMachineConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // Jackpot Tokens spent per spin.
    costPerSpin: {
      type: Number,
      default: 1,
      min: 1,
    },

    rewards: {
      // Lava Coin payout — a random amount in [min, max].
      coins: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 55, min: 0 },
        min:     { type: Number, default: 100, min: 0 },
        max:     { type: Number, default: 1000, min: 0 },
      },

      // A real, on-chain NFT drawn from real blockchain NFT Collections an
      // admin has opted into Slot Machine rewards (see
      // NftCollection.slotEligible/slotRewardQuantity, configured from the
      // Blockchain admin tab, and game/slotNftReward.js) — never the
      // manual/admin-curated catalog (models/Nft.js). No eligibility list
      // lives here; only enabled/weight.
      nft: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 15, min: 0 },
      },
    },
  },
  {
    timestamps: true,
  }
)

export const SlotMachineConfig = mongoose.model('SlotMachineConfig', slotMachineConfigSchema)

/** Always fetches (creating with defaults on first use) the singleton document. */
async function getConfigDoc() {
  return SlotMachineConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Fetch the full live config as a plain object (safe to JSON-serialize). */
export async function getSlotMachineConfig() {
  const config = await getConfigDoc()
  return config.toObject({ versionKey: false })
}

/** Update the Jackpot Token cost per spin. Returns the full updated config. */
export async function updateSlotMachineCost(costPerSpin) {
  await SlotMachineConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: { costPerSpin }, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return getSlotMachineConfig()
}

/**
 * Update one reward category's config. `category` is 'coins' | 'nft'.
 * `patch` may set any subset of that category's fields (e.g.
 * { enabled, weight, min, max } for coins; { enabled, weight,
 * eligibleNftIds } for nft). Returns the full updated config.
 */
export async function updateSlotMachineRewardCategory(category, patch) {
  if (!['coins', 'nft'].includes(category)) {
    throw new Error(`Unknown reward category: ${category}`)
  }
  const $set = {}
  for (const [field, value] of Object.entries(patch ?? {})) {
    $set[`rewards.${category}.${field}`] = value
  }
  await SlotMachineConfig.findOneAndUpdate(
    { key: 'default' },
    { $set, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return getSlotMachineConfig()
}

export default SlotMachineConfig

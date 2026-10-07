import mongoose from 'mongoose'

/**
 * Singleton settings document controlling the (purchasable) Jackpot Orb
 * system — a NEW, additive feature. This is completely separate from the
 * existing natural in-game Jackpot Orb spawn/reward (see GameLogic.js's
 * 'jackpot' orb-collection case and ClientSession._handleJackpotNftReward),
 * which is untouched by this file and keeps awarding its own Lava Coins +
 * NFT chance exactly as before.
 *
 * This config governs ONLY the alternative path: a player spends LSVP
 * Tokens to buy a Jackpot Orb into their inventory, then later "uses" it to
 * trigger a server-side weighted draw from the reward pool below.
 *
 * Same pattern as CashoutConfig.js / ArenaStageConfig.js: one document
 * matched by `key: 'default'`, read/updated via the getters/setters below
 * so an admin can retune the cost, odds, payouts, eligible NFTs, and
 * cosmetic pool at runtime — nothing here is ever hardcoded in route code.
 */
const jackpotConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },

    // LSVP Token cost to purchase one Jackpot Orb.
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/jackpot.js's PUT /admin/config (request level) via
    // utils/lsvpPricing.js.
    lsvpCost: {
      type: Number,
      default: 500,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },

    rewards: {
      // Large Lava Coin payout — a random amount in [min, max].
      lavaCoin: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 50, min: 0 },
        min:     { type: Number, default: 2000, min: 0 },
        max:     { type: Number, default: 10000, min: 0 },
      },

      // Real, on-chain LSVP Token payout — a random amount in [min, max]
      // (both admin-configurable "withdrawal" limits for this category).
      // Winning this does NOT send anything automatically: the player must
      // actively claim it (POST /api/jackpot/claim/:transactionId), which
      // sends the on-chain transfer immediately — no admin approval step.
      lsvp: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 20, min: 0 },
        min:     { type: Number, default: 10, min: 0 },
        max:     { type: Number, default: 200, min: 0 },
      },

      // A real, on-chain NFT — drawn from whichever NFT Collections an
      // admin has opted into jackpot rewards (see NftCollection.js's
      // jackpotEligible/jackpotRewardQuantity, managed from the Blockchain
      // admin tab, NOT here). Same "win now, claim later" pattern as lsvp
      // above: winning only reserves the NFT, the actual on-chain transfer
      // happens when the player claims it. This never draws from the
      // manual/admin-curated catalog (models/Nft.js) — that catalog is
      // reserved for the separate artifact-perk marketplace.
      nft: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 30, min: 0 },
      },

      // Rare cosmetic item — future-proof category for skins/effects/
      // themes/etc. Not consumed by any rendering code yet; purely stored
      // on the winning user's account (see User.ownedCosmeticIds) so the
      // reward pipeline and admin config already support it end-to-end
      // ahead of actual cosmetic effects being built.
      cosmetic: {
        enabled: { type: Boolean, default: true },
        weight:  { type: Number, default: 20, min: 0 },
        pool: {
          type: [
            {
              id:          { type: String, required: true },
              name:        { type: String, required: true },
              description: { type: String, default: '' },
            },
          ],
          default: [],
        },
      },
    },
  },
  {
    timestamps: true,
  }
)

export const JackpotConfig = mongoose.model('JackpotConfig', jackpotConfigSchema)

/** Always fetches (creating with defaults on first use) the singleton document. */
async function getConfigDoc() {
  return JackpotConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
}

/** Fetch the full live config as a plain object (safe to JSON-serialize). */
export async function getJackpotConfig() {
  const config = await getConfigDoc()
  return config.toObject({ versionKey: false })
}

/** Update the LSVP cost of a Jackpot Orb. Returns the full updated config. */
export async function updateJackpotCost(lsvpCost) {
  await JackpotConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: { lsvpCost }, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return getJackpotConfig()
}

/**
 * Update one reward category's config. `category` is 'lavaCoin' | 'lsvp' |
 * 'nft' | 'cosmetic'. `patch` may set any subset of that category's fields
 * (e.g. { enabled, weight, min, max } for lavaCoin/lsvp; { enabled, weight }
 * for nft — its eligible collections/quantity live on NftCollection, not
 * here; { enabled, weight, pool } for cosmetic). Returns the full updated
 * config.
 */
export async function updateJackpotRewardCategory(category, patch) {
  if (!['lavaCoin', 'lsvp', 'nft', 'cosmetic'].includes(category)) {
    throw new Error(`Unknown reward category: ${category}`)
  }
  const $set = {}
  for (const [field, value] of Object.entries(patch ?? {})) {
    $set[`rewards.${category}.${field}`] = value
  }
  await JackpotConfig.findOneAndUpdate(
    { key: 'default' },
    { $set, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true }
  )
  return getJackpotConfig()
}

export default JackpotConfig

import mongoose from 'mongoose'

/**
 * ARTIFACTS — this used to be a general-purpose manual NFT catalog covering
 * both purely cosmetic items and gameplay-perk "artifacts". The cosmetic
 * half was removed once real, on-chain NFT Collections (see NftCollection.js
 * / NftMint.js) made a manually-curated cosmetic catalog redundant — an
 * admin now publishes real NFTs from the wallet instead of typing fake ones
 * in here. What's left, and the only thing this model is for now, is
 * gameplay-perk artifacts: catalog entries that grant a small passive
 * in-game bonus (see `perkKey` below) when owned. Bought with real, on-chain
 * LSVP — see routes/nfts.js's purchase route — never Lava Coins.
 */
const PERK_KEYS = ['healRegen', 'pickupRadiusBonus', 'comboDurationBonus', 'hazardVisibility', 'comboStabilize']

const nftSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: 'A unique artifact from the VolcanoSpoon collection.',
      trim: true,
    },

    // Denominated in whole LSVP Tokens (paid on-chain), not Lava Coins —
    // the field name is historical. See routes/nfts.js's purchase route.
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/nfts.js's POST / (request level) via utils/lsvpPricing.js, so
    // "whole-token pricing" is enforced identically in both places.
    price: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'must be a whole number of LSVP Tokens',
      },
    },

    rarity: {
      type: String,
      enum: ['common', 'rare', 'epic', 'legendary'],
      default: 'common',
    },

    // Either a base64 data URL or a hosted image URL
    image: {
      type: String,
      required: true,
    },

    // Which passive gameplay bonus owning this artifact grants — see
    // game/constants.js's "NFT ARTIFACT PERKS" section for what each key
    // actually does numerically, and frontendMain's nftData.js
    // (getActivePerks/syncArtifactPerksFromServer) for how ownership is
    // resolved into active perks client-side. Required: every entry in this
    // catalog is an artifact now, so every entry must grant something.
    perkKey: {
      type: String,
      enum: PERK_KEYS,
      required: true,
    },

    // Whether this artifact is currently available in the public catalog.
    // Disabling an artifact hides it from new purchases without deleting it
    // or removing it from existing owners.
    enabled: {
      type: Boolean,
      default: true,
    },

    // A plain string, not an ObjectId ref — the admin dashboard logs in with
    // a single shared password (see server.js's POST /admin/login), not a
    // real User document, so there's no admin ObjectId to reference here.
    createdBy: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
)

export const Nft = mongoose.model('Nft', nftSchema)
export { PERK_KEYS }
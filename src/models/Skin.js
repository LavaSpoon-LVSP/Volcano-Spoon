import mongoose from 'mongoose'

/**
 * SPOON SKINS — purchasable cosmetic spoon appearances, sold from the new
 * "Spoon Skins" section on the Volcanic Artifacts page (see
 * VolcanicArtifactsPage.jsx / routes/skins.js).
 *
 * Deliberately its own model rather than reusing Nft: NFTs are "own it,
 * every owned one is active simultaneously" (see Nft.js / User.activeNftIds),
 * whereas skins are mutually exclusive — a player owns any number but only
 * ever has ONE equipped at a time (see User.equippedSkinId). Mixing that
 * single-select semantics into the NFT model/routes would have meant
 * touching the existing NFT activate/deactivate logic; a separate model
 * keeps this entirely additive.
 *
 * `spriteKey` is the bridge to the frontend: GameEngine.js's PLAYER_SPRITES
 * map is keyed by this exact string (see the map's Spoon Skins section) —
 * whatever the player has equipped is looked up there to pick the actual
 * sprite file. Kept separate from Mongo's _id so the frontend sprite map
 * doesn't have to know/guess Mongo ObjectId strings.
 */
const skinSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: 'A unique spoon skin from the VolcanoSpoon collection.',
      trim: true,
    },

    // LSVP Token cost to buy this skin, paid on-chain (see
    // routes/skins.js POST /:id/purchase and solana/paymentVerification.js).
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/skins.js's POST / (request level) via utils/lsvpPricing.js.
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

    // Either a hosted image URL (e.g. /images/Thunderwhisper.png) or a
    // base64 data URL, same convention as Nft.image.
    image: {
      type: String,
      required: true,
    },

    // Key into GameEngine.js's PLAYER_SPRITES map — see the comment above.
    // Unique so two skins can never collide on the same in-game sprite slot.
    spriteKey: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },

    // Whether this skin is currently available in the public catalog.
    // Disabling a skin hides it from new purchases without deleting it
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

export const Skin = mongoose.model('Skin', skinSchema)

import mongoose from 'mongoose'

/**
 * NFT COLLECTION — one row per Metaplex NFT collection the admin wallet
 * holds NFTs from (see solana/nftService.js's scanAdminWalletNfts). This is
 * the "shelf" a player buys from; the individual NFTs living on that shelf
 * are NftMint documents (see NftMint.js).
 *
 * Created/refreshed by POST /api/admin/blockchain/sync (admin action) —
 * never created by hand. `priceLsvp` starts null (not yet published/priced)
 * and is set the first time the admin publishes some of this collection's
 * NFTs for sale.
 */
const nftCollectionSchema = new mongoose.Schema(
  {
    // The on-chain Collection NFT's mint address — the real source of
    // truth for "which collection is this". Unique: syncing never creates
    // a duplicate row for a collection that's already known.
    collectionMintAddress: {
      type: String,
      required: true,
      unique: true,
    },

    name: {
      type: String,
      required: true,
    },

    // The Collection NFT's own off-chain image, used for the catalog card.
    image: {
      type: String,
      default: null,
    },

    // Price to buy ONE NFT from this collection, in whole LSVP tokens.
    // null means "not priced yet" — the admin sets this the first time
    // they publish from this collection (see POST .../publish).
    // Whole LSVP Tokens only — validated here (schema level) and again in
    // routes/blockchainAdmin.js's publish route (request level) via
    // utils/lsvpPricing.js. Skipped when null (not yet priced).
    priceLsvp: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (v) => v === null || Number.isInteger(v),
        message: 'must be a whole number of LSVP Tokens',
      },
    },

    // Whether the Collection NFT's on-chain verification has been run
    // (see nftService.js's file header for what this does and doesn't
    // protect against). Purely informational — an unverified collection
    // can still be published and sold — but the admin dashboard flags it
    // so the admin can go verify it on-chain before selling to real players.
    verified: {
      type: Boolean,
      default: false,
    },

    // ── Jackpot Orb reward eligibility ──
    // The Jackpot Orb's NFT reward category (see routes/jackpot.js,
    // game/jackpotNftReward.js) draws real NFTs from real blockchain
    // collections — never from the manual catalog (models/Nft.js). An admin
    // opts a collection in here and sets how many of its NFTs can ever be
    // given away as jackpot rewards; the rest stay available for direct
    // purchase (see .../publish). This never overlaps with a sale: a jackpot
    // draw only ever claims an 'in_admin_wallet' mint, same pool .../publish
    // draws from, so an admin should budget jackpotRewardQuantity against
    // whatever they're not also publishing for sale.
    jackpotEligible: {
      type: Boolean,
      default: false,
    },

    // How many of this collection's NFTs an admin has budgeted for jackpot
    // rewards, total, ever (not "currently available").
    jackpotRewardQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // How many have actually been drawn as jackpot rewards so far. Once
    // this reaches jackpotRewardQuantity, the collection stops being drawn
    // from even if jackpotEligible is still true — the admin must raise the
    // quantity to make more of it available again.
    jackpotRewardsGranted: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Jackpot Slot Machine reward eligibility ──
    // Same idea as the jackpotEligible/jackpotRewardQuantity/
    // jackpotRewardsGranted trio above, but for the completely separate
    // Jackpot Slot Machine feature (routes/slotMachine.js,
    // game/slotNftReward.js) — its own independent budget, so a collection
    // can be opted into the Jackpot Orb's reward, the Slot Machine's
    // reward, both, or neither. Both draw from the same underlying
    // 'in_admin_wallet' NftMint stock pool that direct-sale publishing also
    // draws from, so an admin should budget across all three uses of a
    // collection's stock (sale / jackpot / slot) together.
    slotEligible: {
      type: Boolean,
      default: false,
    },

    // How many of this collection's NFTs an admin has budgeted for Slot
    // Machine rewards, total, ever (not "currently available").
    slotRewardQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // How many have actually been drawn as Slot Machine rewards so far.
    slotRewardsGranted: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
)

export const NftCollection = mongoose.model('NftCollection', nftCollectionSchema)

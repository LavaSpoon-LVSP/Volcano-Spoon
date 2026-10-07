import mongoose from 'mongoose'

/**
 * NFT MINT — one row per individual NFT the admin wallet holds (or has
 * sold). This is the actual sellable inventory: NftCollection is just the
 * grouping/pricing shelf, this is each physical item on it.
 *
 * Lifecycle: 'in_admin_wallet' (found by the sync scan, not for sale yet)
 * -> 'published' (admin made it purchasable — see POST .../publish)
 * -> 'sold' (a player bought it; ownerUserId + transferSignature are set).
 *
 * Why counts (published/sold/available) are never stored on NftCollection:
 * this table is the single source of truth, and every count is a live
 * `countDocuments` query against it — so there's no cached number that can
 * ever drift out of sync with reality.
 */
const nftMintSchema = new mongoose.Schema(
  {
    mintAddress: {
      type: String,
      required: true,
      unique: true,
    },

    // Matches NftCollection.collectionMintAddress — not a Mongo ref, since
    // both are looked up by their on-chain address everywhere else too.
    collectionMintAddress: {
      type: String,
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
    },

    image: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ['in_admin_wallet', 'published', 'sold'],
      default: 'in_admin_wallet',
      index: true,
    },

    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    soldAt: {
      type: Date,
      default: null,
    },

    // The signature of the on-chain transfer that sent this NFT from the
    // admin wallet to the buyer. Set once the transfer actually succeeds.
    transferSignature: {
      type: String,
      default: null,
    },

    // Set to true if this NFT was marked 'sold' (payment was verified and
    // consumed) but the on-chain transfer to the buyer then failed — e.g. a
    // dropped RPC connection. The buyer already paid, so this NFT is
    // permanently theirs; it just needs an admin to retry the transfer
    // (see GET /api/admin/blockchain/failed-transfers). Never re-sold to
    // anyone else while this is true.
    transferFailed: {
      type: Boolean,
      default: false,
    },

    // Brief in-flight marker used ONLY by the admin retry-transfer route
    // (routes/blockchainAdmin.js's POST /nft-mints/:mintAddress/retry-transfer)
    // to make concurrent retries safe: 'processing' while a retry attempt
    // is in flight, null otherwise. Set via an atomic findOneAndUpdate
    // matching transferFailed:true AND retryStatus not already
    // 'processing', so two admins clicking retry at once (or an uncertain
    // transfer whose outcome isn't known yet) can never both fire a
    // transfer for the same NFT.
    retryStatus: {
      type: String,
      enum: ['processing', null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

// Enforces "one sold NFT per (user, collection)" at the database level —
// this is what makes the one-per-collection rule race-safe: two concurrent
// purchase requests for the same user/collection can never both succeed,
// even if both passed the pre-purchase ownership check at the same instant.
// Partial (only applies to status:'sold') so many NftMint documents can
// share a null ownerUserId without tripping the uniqueness constraint.
nftMintSchema.index(
  { collectionMintAddress: 1, ownerUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'sold' } }
)

export const NftMint = mongoose.model('NftMint', nftMintSchema)

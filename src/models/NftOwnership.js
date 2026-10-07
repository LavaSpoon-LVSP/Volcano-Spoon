import mongoose from 'mongoose'

/**
 * Server-side record of an NFT purchase / ownership grant.
 * This is the audit trail behind User.ownedNftIds — the fast-path array on
 * the user doc is what gets checked at read time, but every change to it
 * that happens through the Marketplace purchase flow is also logged here
 * with the fields the "NFT Purchase Storage" fix requires: who bought what,
 * when, whether the transaction completed, and whether the resulting
 * ownership is still in effect.
 *
 * The unique index on {user, nft} is a second, DB-level guarantee (on top
 * of the $addToSet + $ne guard in the purchase route) that a user can never
 * end up with two ownership records for the same NFT.
 */
const nftOwnershipSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    nft: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Nft',
      required: true,
    },

    // Lava Coin price paid at purchase time (kept even if the catalog price
    // changes later, so history stays accurate).
    price: {
      type: Number,
      required: true,
      min: 0,
    },

    purchaseDate: {
      type: Date,
      default: Date.now,
    },

    transactionStatus: {
      type: String,
      enum: ['completed', 'failed', 'refunded'],
      default: 'completed',
    },

    ownershipStatus: {
      type: String,
      enum: ['owned', 'revoked'],
      default: 'owned',
    },
  },
  {
    timestamps: true,
  }
)

nftOwnershipSchema.index({ user: 1, nft: 1 }, { unique: true })

export const NftOwnership = mongoose.model('NftOwnership', nftOwnershipSchema)

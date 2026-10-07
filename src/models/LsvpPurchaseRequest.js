import mongoose from 'mongoose'

/**
 * A single "buy LSVP Tokens with Lava Coins" request — one document per
 * purchase, whether it was instant or needed admin approval. This is the
 * audit trail shown in the player's profile and the Admin Dashboard's
 * Blockchain tab. Modeled closely on CashoutRequest.js.
 *
 * Lava Coins are deducted at APPROVAL time, not at submit time — same
 * convention as CashoutRequest.js. A 'pending' request hasn't taken
 * anything from the player yet; it's just a reservation waiting on an
 * admin decision. Rejecting one is therefore a pure no-op on the coin
 * balance (nothing to refund), and approving one atomically deducts coins
 * right before sending the on-chain LSVP transfer.
 */
const lsvpPurchaseRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Denormalized for simple admin-dashboard rendering without a join.
    username: {
      type: String,
      required: true,
    },

    // Where the LSVP will be sent — snapshotted at request time, so a
    // player changing their linked wallet later can't redirect a
    // still-pending request.
    walletAddress: {
      type: String,
      required: true,
    },

    lsvpAmount: {
      type: Number,
      required: true,
      min: 1,
    },

    coinsSpent: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      // 'processing' is a brief in-flight state an admin approve/reject
      // action atomically claims a 'pending' request into (findOneAndUpdate
      // matching status:'pending') before doing anything else — see
      // routes/blockchainAdmin.js. It's what makes "never let approve and
      // reject both succeed" true: once one action has moved a request out
      // of 'pending', the other's same atomic match can never find it.
      enum: ['approved', 'pending', 'rejected', 'processing'],
      required: true,
      default: 'pending',
    },

    // true if this cleared the auto-approval threshold and was sent
    // instantly with no admin involvement.
    autoApproved: {
      type: Boolean,
      default: false,
    },

    // Set once the on-chain transfer actually goes through (instantly for
    // auto-approved requests, or when an admin approves a pending one).
    txSignature: {
      type: String,
      default: null,
    },

    // A plain string, not an ObjectId ref — the admin dashboard logs in with
    // a single shared password (see server.js's POST /admin/login), not a
    // real User document, so there's no admin ObjectId to reference here.
    reviewedBy: {
      type: String,
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

lsvpPurchaseRequestSchema.index({ user: 1, createdAt: -1 })
lsvpPurchaseRequestSchema.index({ status: 1, createdAt: -1 })

// Defense in depth against the same on-chain transfer being recorded as
// delivered twice: Ed25519 signing is deterministic, so two requests that
// build a byte-identical transaction (same destination + amount landing in
// the same blockhash window) produce the SAME signature, and only one of
// them is a real new transfer. The route-level check in blockchainUser.js
// (and blockchainAdmin.js's approve handler) looks for an existing record
// with this signature before creating a new one, but that check and this
// create() are not atomic with each other — a unique index is what makes
// a genuine double-insert impossible even under a dead-even race, by
// rejecting the second create() with a duplicate-key error instead of
// silently accepting it. Sparse because most other document types in this
// app that might reuse this collection pattern keep txSignature null
// until a transfer actually lands.
lsvpPurchaseRequestSchema.index({ txSignature: 1 }, { unique: true, sparse: true })

export const LsvpPurchaseRequest = mongoose.model('LsvpPurchaseRequest', lsvpPurchaseRequestSchema)

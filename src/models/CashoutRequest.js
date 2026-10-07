import mongoose from 'mongoose'

/**
 * A single Lava Coin -> LSVP Token cash-out transaction. One document per
 * submitted request — this is the full audit trail shown in both the
 * player's profile ("Cash-out history") and the Admin Dashboard's "Token
 * Conversion Management" section.
 *
 * The LSVP side of this is a REAL on-chain transfer (see routes/cashout.js),
 * not a ledger increment — modeled closely on LsvpPurchaseRequest.js, which
 * is the same "buy LSVP" idea via a different entry point (buying instead of
 * cashing out coins).
 */
const cashoutRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Denormalized for fast/simple admin-dashboard rendering without a join.
    username: {
      type: String,
      required: true,
    },

    // Where the LSVP will actually be sent on-chain — snapshotted at
    // request time (same reasoning as LsvpPurchaseRequest.js's field of the
    // same name), so a player changing their linked wallet later can't
    // redirect a still-pending cash-out.
    walletAddress: {
      type: String,
      required: true,
    },

    lavaCoins: {
      type: Number,
      required: true,
      min: 1,
    },

    lsvpTokens: {
      type: Number,
      required: true,
      min: 1,
    },

    // The lavaPerLsvp rate that was actually applied to this request —
    // recorded so the history stays accurate even if the admin changes
    // the rate later.
    rateUsed: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      enum: ['approved', 'pending', 'rejected'],
      required: true,
      default: 'pending',
    },

    // true if this request cleared the daily auto-approval limit and was
    // processed instantly with no admin involvement.
    autoApproved: {
      type: Boolean,
      default: false,
    },

    // Set once the real on-chain LSVP transfer actually goes through —
    // instantly for an auto-approved request, or when an admin approves a
    // pending one. Null until then (and stays null for a rejected request,
    // since nothing was ever sent).
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

cashoutRequestSchema.index({ user: 1, createdAt: -1 })
cashoutRequestSchema.index({ status: 1, createdAt: -1 })

export const CashoutRequest = mongoose.model('CashoutRequest', cashoutRequestSchema)

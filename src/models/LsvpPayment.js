import mongoose from 'mongoose'

/**
 * Records every on-chain LSVP payment a player has made to buy something
 * (an NFT, a Spoon Skin, an Item — anything priced in LSVP; see
 * solana/paymentVerification.js). The unique index on `txSignature` is
 * what actually enforces "a payment can only ever be used once" — once a
 * transaction signature has a row here, trying to spend it again fails
 * with a duplicate-key error instead of silently granting a second item
 * for the same payment.
 *
 * This is intentionally a flat, generic log shared by every LSVP-priced
 * purchase type (rather than one collection per feature) so replay
 * protection is enforced in exactly one place for all of them.
 */
const lsvpPaymentSchema = new mongoose.Schema(
  {
    txSignature: {
      type: String,
      required: true,
      unique: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    payerWallet: {
      type: String,
      required: true,
    },

    amountLsvp: {
      type: Number,
      required: true,
      min: 1,
    },

    purpose: {
      type: String,
      enum: [
        'nft_purchase', 'skin_purchase', 'item_purchase',
        // Added when Jackpot Orbs / Arena Stage unlocks / Energy refills
        // were converted from the old off-chain lsvpBalance ledger to real
        // on-chain LSVP payments — see routes/jackpot.js, arenaStages.js,
        // and energy.js.
        'jackpot_orb_purchase', 'arena_stage_unlock', 'energy_purchase',
        // The manual/admin-curated NFT catalog (models/Nft.js, routes/nfts.js)
        // switched from spending Lava Coins to real on-chain LSVP — this
        // stays a distinct purpose from 'nft_purchase' (the real blockchain
        // NFT Collections marketplace) since it's a different catalog and
        // never involves an actual on-chain NFT transfer.
        'catalog_nft_purchase',
      ],
      required: true,
    },

    // Whatever this payment was for — a collectionMintAddress for
    // nft_purchase, a Skin/Item Mongo id for the other two, a fixed string
    // for jackpot_orb_purchase, the stage number for arena_stage_unlock, or
    // the purchase type ('five'/'ten'/'unlimited') for energy_purchase.
    purposeRefId: {
      type: String,
      required: true,
    },

    // Set once the grant this payment paid for has actually been applied
    // (energy credited, item/skin/NFT/orb/stage granted, etc.) — see
    // claimPaymentAndGrant() below. null means "paid, not granted yet",
    // which should only ever be a brief in-flight state; if a request
    // dies between claiming the payment and finishing the grant (a crash,
    // a dropped connection), this is what lets a RETRY of the exact same
    // signature finish the grant instead of bouncing off "payment already
    // used" and leaving the player permanently paid-but-empty-handed. See
    // GET /api/admin/blockchain/undelivered-payments for the admin view
    // of any payment still stuck here longer than expected.
    grantedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const LsvpPayment = mongoose.model('LsvpPayment', lsvpPaymentSchema)

/**
 * Atomically claims a transaction signature for one purpose. Returns the
 * created record on success, or null if this signature has already been
 * used (duplicate key) — callers should treat null as "payment already
 * used, reject the purchase" rather than throwing.
 */
export async function claimLsvpPayment({ txSignature, userId, payerWallet, amountLsvp, purpose, purposeRefId }) {
  try {
    return await LsvpPayment.create({
      txSignature,
      user: userId,
      payerWallet,
      amountLsvp,
      purpose,
      purposeRefId,
    })
  } catch (error) {
    if (error?.code === 11000) return null // already claimed
    throw error
  }
}

/**
 * Runs the "claim this payment, then grant what it paid for" sequence in a
 * way that's safe to RETRY with the exact same txSignature — which matters
 * because the two steps aren't one atomic operation: a request can die
 * (crash, dropped connection, process restart) after the payment is
 * claimed but before the grant finishes, or after the grant finishes but
 * before the response reaches the client. Without this, a retried request
 * hits claimLsvpPayment's unique-index rejection and returns 409 "payment
 * already used" forever — the player paid, has nothing to show for it, and
 * can never get it since the signature can't be reused. See
 * routes/energy.js, skins.js, items.js, nfts.js, jackpot.js, arenaStages.js,
 * blockchainUser.js for callers.
 *
 * `grant()` only ever actually runs ONCE per payment, no matter how many
 * times this is called with the same signature — gated by atomically
 * flipping that payment's own `grantedAt` from null to now first (the same
 * findOneAndUpdate "claim" pattern used everywhere else in this codebase),
 * so even two concurrent retries of the same stuck payment can't both
 * apply the grant. If it's already granted, `grant()` is skipped and
 * `getGrantedResponse()` (if provided) is called instead to hand back a
 * normal-looking success response built from current state.
 *
 * Throws an Error with `.status = 409` if the signature belongs to a
 * genuinely different payment (different user/purpose/purposeRefId) —
 * that's a real replay attempt, not a legitimate retry, and must still be
 * rejected.
 */
export async function claimPaymentAndGrant({ txSignature, userId, payerWallet, amountLsvp, purpose, purposeRefId, grant, getGrantedResponse }) {
  let payment = await claimLsvpPayment({ txSignature, userId, payerWallet, amountLsvp, purpose, purposeRefId })

  if (!payment) {
    const existing = await LsvpPayment.findOne({ txSignature })
    const matches = existing &&
      String(existing.user) === String(userId) &&
      existing.purpose === purpose &&
      existing.purposeRefId === String(purposeRefId)

    if (!matches) {
      const error = new Error('This payment has already been used')
      error.status = 409
      throw error
    }
    payment = existing
  }

  const claimedForGrant = await LsvpPayment.findOneAndUpdate(
    { _id: payment._id, grantedAt: null },
    { $set: { grantedAt: new Date() } },
    { new: true }
  )

  if (!claimedForGrant) {
    // Someone already ran the grant for this exact payment (the original
    // request that "died" actually finished server-side before it died,
    // or a concurrent retry got there first) — don't run it again.
    return getGrantedResponse ? await getGrantedResponse() : undefined
  }

  try {
    return await grant()
  } catch (error) {
    // The grant itself failed — release the grantedAt claim so a further
    // retry of this same payment can try again, instead of getting stuck
    // "claimed for granting" forever with nothing actually granted.
    await LsvpPayment.findByIdAndUpdate(payment._id, { $set: { grantedAt: null } }).catch(() => {})
    throw error
  }
}

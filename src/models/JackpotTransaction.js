import mongoose from 'mongoose'

/**
 * Audit log for the purchasable Jackpot Orb feature (see JackpotConfig.js /
 * routes/jackpot.js). One row per purchase (LSVP -> Jackpot Orb), per "use"
 * (Jackpot Orb -> reward draw), or per natural in-game jackpot orb pickup
 * that rolled an NFT (see game/ClientSession.js's _handleJackpotNftReward).
 * Purely additive/logging — never read by gameplay logic itself, only by
 * the Profile/Jackpot page's "recent history"/claim list and the admin
 * dashboard. The natural-orb rows exist here (rather than in their own
 * table) purely so a natural-orb NFT win can go through the exact same
 * claim endpoint (POST /api/jackpot/claim/:transactionId) as a purchased
 * orb's — there's only ever one "claim my NFT" code path.
 */
const jackpotTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // 'purchase'    — spent LSVP to buy a Jackpot Orb.
    // 'use'         — consumed a purchased Jackpot Orb, triggered a reward draw.
    // 'natural_nft' — the existing, separate natural in-game jackpot orb
    //                 pickup rolled an NFT reward (rewardType is always
    //                 'nft' on these rows — see ClientSession.js).
    type: {
      type: String,
      enum: ['purchase', 'use', 'natural_nft'],
      required: true,
    },

    // Only set on 'purchase' transactions.
    lsvpSpent: {
      type: Number,
      default: 0,
    },

    // Only set on 'use' transactions — which reward category was drawn.
    rewardType: {
      type: String,
      enum: ['lava_coin', 'lsvp', 'nft', 'cosmetic', null],
      default: null,
    },

    // Free-form detail about the reward actually granted, e.g.
    // { amount: 4200 } for lava_coin/lsvp, { nftId, name } for nft,
    // { cosmeticId, name } for cosmetic. Kept as Mixed since the shape
    // differs per rewardType and this is log-only (never re-parsed by
    // gameplay code).
    rewardDetail: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── LSVP reward claiming (only meaningful when rewardType === 'lsvp') ──
    // Winning an LSVP reward does NOT send anything automatically — the
    // player has to actively claim it (see routes/jackpot.js's POST
    // /claim/:transactionId), which sends the on-chain transfer immediately.
    // There is no admin approval step for this — the reward pool's min/max
    // (JackpotConfig.rewards.lsvp) is the only thing bounding the payout.
    // 'not_applicable' for every other rewardType; 'unclaimed' right after
    // the draw; 'approved' once the on-chain transfer has gone out.
    claimStatus: {
      type: String,
      // 'processing' is a brief in-flight state POST /claim/:transactionId
      // atomically claims an 'unclaimed' reward into (findOneAndUpdate
      // matching claimStatus:'unclaimed') before sending anything on-chain
      // — see routes/jackpot.js. Closes the race where two concurrent
      // claim requests for the same reward could both read 'unclaimed' and
      // both trigger a transfer.
      //
      // 'held_for_review' — the claim would push the running total of
      // every unclaimed/in-flight LSVP reward above what the admin wallet
      // actually holds right now (see getReservedUnclaimedLsvpTotal in
      // routes/jackpot.js). The reward stays reserved for this player —
      // it is NOT released back to 'unclaimed' — but no transfer is
      // attempted until an admin tops up the wallet and retries it from
      // the admin dashboard (GET/POST /api/jackpot/admin/held-payouts).
      //
      // 'cancelled' — an admin looked at a 'held_for_review' reward and
      // deliberately decided NOT to pay it (a write-off), instead of
      // waiting for the wallet to be topped up. This is the only status
      // that ends a reward's life without a transfer ever happening —
      // once cancelled it is excluded from the reserve total (see
      // getReservedUnclaimedLsvpTotal) and can never be claimed or
      // retried again.
      enum: ['not_applicable', 'unclaimed', 'processing', 'approved', 'held_for_review', 'cancelled'],
      default: 'not_applicable',
    },

    // Only set when claimStatus is 'held_for_review' — why the reserve
    // check held this one back, shown to admins on the held-payouts view.
    heldReason: {
      type: String,
      default: null,
    },

    // ── Set only when claimStatus is 'cancelled' (see enum above) ──
    cancelReason: {
      type: String,
      default: null,
    },
    cancelledByUsername: {
      type: String,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },

    // The wallet the LSVP was sent to — set at claim time, auto-linked to
    // the account the same way every other purchase/payout in this app
    // links a wallet.
    claimWalletAddress: {
      type: String,
      default: null,
    },

    // Set once the on-chain transfer actually goes through.
    claimTxSignature: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const JackpotTransaction = mongoose.model('JackpotTransaction', jackpotTransactionSchema)

export default JackpotTransaction

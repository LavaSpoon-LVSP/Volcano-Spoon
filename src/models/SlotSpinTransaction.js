import mongoose from 'mongoose'

/**
 * Audit log for the Jackpot Slot Machine feature (see SlotMachineConfig.js /
 * routes/slotMachine.js). One row per spin. Mostly a log (read by the Slot
 * Machine page's "recent spins" list and the admin dashboard) — EXCEPT for
 * the claim fields below, which an 'nft' win actually needs: winning a real,
 * on-chain NFT only reserves it (see game/slotNftReward.js); the row here
 * tracks whether that reservation has since been claimed (transferred to
 * the player's wallet), same "win now, claim later" pattern as
 * JackpotTransaction.
 */
const slotSpinTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    tokensSpent: {
      type: Number,
      required: true,
    },

    // Which reward category was drawn on this spin.
    rewardType: {
      type: String,
      enum: ['coins', 'lsvp', 'nft', null],
      default: null,
    },

    // Free-form detail about the reward actually granted, e.g.
    // { amount: 420 } for coins/lsvp, { mintAddress, collectionMintAddress,
    // name, image } for a real on-chain nft win (see game/slotNftReward.js).
    // Kept as Mixed since the shape differs per rewardType.
    rewardDetail: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // 'not_applicable' for a coins win (nothing to claim — already
    // credited). 'unclaimed' for a fresh 'nft' win — the NftMint is already
    // reserved to this player, but the real on-chain transfer hasn't
    // happened yet. 'approved' once the player has claimed it (POST
    // /api/slot-machine/claim/:transactionId) and the transfer succeeded.
    claimStatus: {
      type: String,
      // 'processing' — same atomic in-flight claim state as
      // JackpotTransaction.js's claimStatus; see routes/slotMachine.js's
      // POST /claim/:transactionId.
      enum: ['not_applicable', 'unclaimed', 'processing', 'approved'],
      default: 'not_applicable',
    },

    // The wallet address the reward was actually sent to, set once claimed.
    claimWalletAddress: {
      type: String,
      default: null,
    },

    // The on-chain transaction signature of the claim transfer, set once
    // claimed — lets the player (and support) look it up on an explorer.
    claimTxSignature: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const SlotSpinTransaction = mongoose.model('SlotSpinTransaction', slotSpinTransactionSchema)

export default SlotSpinTransaction

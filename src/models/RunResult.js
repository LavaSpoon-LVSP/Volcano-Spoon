import mongoose from 'mongoose'

/**
 * One row per completed (non-tutorial) round — created before anything is
 * credited (see ClientSession._handleRunReport / _settleRound) and is the
 * durable anchor that makes settlement idempotent and recoverable:
 *
 * - `roundId` (the run's single-use run:token) is unique, so a duplicated
 *   or retried 'game:run_report' for the same round can never create a
 *   second record or be credited twice — see the roundId lookup at the top
 *   of _handleRunReport, which returns the already-saved result instead of
 *   recomputing/re-crediting anything once `status` is 'committed'.
 * - `walletCredited` / `bestScoreSaved` are set only AFTER their respective
 *   writes land, so if the process crashes/restarts mid-settlement, a retry
 *   of this exact round (same roundId) resumes from here instead of
 *   re-applying an already-applied $inc (which would double-pay) or
 *   silently losing the other half of the result.
 * - This document is the "reference ID" shown to the player on a pending/
 *   rejected result screen (see Game.jsx's GameOverlay) and the thing an
 *   admin/support flow can look up for "what actually happened to this
 *   round" independent of whatever the client claimed.
 */
const runResultSchema = new mongoose.Schema(
  {
    roundId: {
      type: String,
      required: true,
      unique: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['settling', 'committed'],
      default: 'settling',
    },

    // Server-derived (replayed) result for this round — see ReplayEngine.js.
    score: { type: Number, default: 0 },
    coinsEarned: { type: Number, default: 0 },
    jackpotTokensCollected: { type: Number, default: 0 },
    xpEarned: { type: Number, default: 0 },

    // Round-start snapshot this round was settled under (see S2 in the
    // handover doc: never the session's live/current values at save time).
    arenaStage: { type: Number, default: 1 },
    lavaCoinMultiplier: { type: Number, default: 1 },

    // Basic anti-bot (Developer Update, 30 Sep 2026) — a fingerprint of this
    // round's discrete input sequence (see game/inputPlausibility.js's
    // hashInputPattern). Compared against this same player's own recent
    // committed rounds to flag an exact repeat (a strong replay/bot
    // signal) for admin review — never used to reject a round on its own.
    // Not unique/required: tutorial rounds and any round with no discrete
    // inputs simply leave this null.
    inputPatternHash: { type: String, default: null, index: true },

    // Recovery/idempotency markers — see the class comment above.
    walletCredited: { type: Boolean, default: false },
    bestScoreSaved: { type: Boolean, default: false },

    // Post-credit snapshots, returned on a retried report without needing
    // to re-read the User/Score documents.
    totalCoinsAfter: { type: Number, default: null },
    jackpotTokensAfter: { type: Number, default: null },
    totalXpAfter: { type: Number, default: null },
    bestScoreAfter: { type: Number, default: null },
  },
  {
    timestamps: true,
  }
)

export const RunResult = mongoose.model('RunResult', runResultSchema)

import mongoose from 'mongoose'

/**
 * Per-game XP log — additive, analytics/history only. Never read by
 * gameplay logic; exists so a game's XP contribution (and the running
 * total right after it) is individually auditable, and so the Profile
 * page could eventually show a "recent XP" list the same way Cash Out/
 * Jackpot show recent transaction history.
 *
 * One row is created every time ClientSession.saveXp() runs (i.e. once
 * per completed, non-tutorial game — see the `wasGameOver`-guarded block
 * in ClientSession.tick(), which already prevents this from firing twice
 * for the same game-over transition).
 */
const xpHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // XP earned by this specific game (currently == that game's final score).
    xpEarned: {
      type: Number,
      required: true,
      min: 0,
    },

    // The user's totalXp immediately after this game's XP was added —
    // lets history rows be displayed without a second lookup.
    totalXpAfter: {
      type: Number,
      required: true,
      min: 0,
    },

    // The final score this XP was derived from (for reference/debugging).
    score: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
)

export const XpHistory = mongoose.model('XpHistory', xpHistorySchema)

export default XpHistory

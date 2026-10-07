import mongoose from 'mongoose'

/**
 * One row per (season, player) — the season-scoped leaderboard record.
 * Deliberately separate from the existing `Score` model (that one is the
 * player's permanent all-time personal best, used to seed the in-session
 * HUD "best score" and completely unaffected by seasons). This model is
 * ONLY ever read/written by the seasonal leaderboard feature.
 *
 * `totalCoinsSnapshot` stays null while the season is active — the live
 * leaderboard reads the player's current `User.coins` instead (see
 * ClientSession.sendLeaderboard()), same as the old all-time leaderboard
 * did. The instant a season is archived (seasonManager.archiveSeason), it
 * gets frozen to that moment's coin balance so the archived standings
 * never silently change after the fact just because a player earned more
 * coins later.
 */
const seasonScoreSchema = new mongoose.Schema(
  {
    seasonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Season',
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    username: {
      type: String,
      required: true,
    },

    bestScore: {
      type: Number,
      default: 0,
    },

    // Leaderboard "games played" / "average score" (see
    // ClientSession.sendLeaderboard()) — incremented on every credited
    // round for this player this season, not just ones that beat their
    // best (see _saveSeasonScore's $inc). Older rows created before this
    // field existed simply read back as 0/undefined; sendLeaderboard()
    // treats that as "at least one game" rather than dividing by zero.
    totalGames: {
      type: Number,
      default: 0,
    },

    totalScore: {
      type: Number,
      default: 0,
    },

    totalCoinsSnapshot: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

// One leaderboard row per player per season — also the index the
// leaderboard sort/lookup relies on.
seasonScoreSchema.index({ seasonId: 1, userId: 1 }, { unique: true })
seasonScoreSchema.index({ seasonId: 1, bestScore: -1 })

export const SeasonScore = mongoose.model('SeasonScore', seasonScoreSchema)

import mongoose from 'mongoose'

/**
 * A leaderboard Season — admin-managed window of time during which
 * gameplay scores accumulate toward the (season-scoped) leaderboard.
 * See src/game/seasonManager.js for the status lifecycle
 * ('upcoming' -> 'active' -> 'ended') and auto-archiving logic, and
 * src/routes/seasons.js for the admin CRUD + public read endpoints.
 *
 * `status` is a stored, queryable mirror of what's really just a function
 * of (startDate, endDate, now) — kept as a real field (rather than computed
 * on every read) so leaderboard queries can filter on `{status: 'active'}`
 * directly, without a full collection scan. It is kept in sync by
 * seasonManager.syncSeasonStatuses(), which every season-touching request
 * calls first (lazy "check on read" instead of a cron dependency — this
 * backend has no scheduler library installed).
 */
const seasonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: '',
    },

    startDate: {
      type: Date,
      required: true,
    },

    endDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ['upcoming', 'active', 'ended'],
      default: 'upcoming',
      index: true,
    },

    // Set once, the instant syncSeasonStatuses() archives this season
    // (rolls it from 'active' to 'ended' and snapshots SeasonScore.coins).
    // Presence of this field is also the idempotency guard against
    // re-archiving the same season twice.
    archivedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

// A season's whole point is a fixed, non-overlapping window — validate at
// the schema level too (routes/seasons.js does the real overlap check
// against sibling documents, this just guards a single doc's own dates).
// Mongoose 8+ removed callback-style (`next`) pre-hooks — a synchronous
// function that throws (or a function returning a rejected Promise) is now
// the correct way to fail validation.
seasonSchema.pre('validate', function guardDateOrder() {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    throw new Error('endDate must be after startDate')
  }
})

export const Season = mongoose.model('Season', seasonSchema)

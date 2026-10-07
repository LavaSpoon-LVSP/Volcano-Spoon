import mongoose from 'mongoose'

/**
 * One row per outstanding "forgot password" request. The RAW reset token
 * is emailed to the player and never stored anywhere server-side — only
 * `tokenHash` (SHA-256 of the raw token, see routes/auth.js) is kept, so a
 * database read/backup leak can't be turned into working reset links the
 * way storing the raw token would allow. Single-use is enforced by
 * `usedAt`: POST /auth/reset-password atomically claims a row with
 * `findOneAndUpdate({_id, usedAt: null}, {usedAt: now})` before trusting
 * it, the same optimistic-concurrency "claim" pattern this codebase
 * already uses for settlement (see RunResult.walletCredited) — so two
 * near-simultaneous uses of the same link (a doubled request, a user
 * clicking an email link twice) can't both succeed.
 *
 * `expiresAt` has a TTL index so Mongo garbage-collects expired/used rows
 * on its own; POST /auth/reset-password also re-checks `expiresAt > now`
 * itself rather than relying on the TTL sweep's timing (that background
 * task runs on its own ~60s cycle, not instantly at the exact expiry
 * moment).
 */
const passwordResetTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      // TTL index — Mongo deletes the document once this date is in the
      // past (checked on its own periodic sweep, not instantaneous).
      index: { expires: 0 },
    },

    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const PasswordResetToken = mongoose.model('PasswordResetToken', passwordResetTokenSchema)

import mongoose from 'mongoose'

/**
 * Full per-admin audit trail — one row per admin-initiated write this
 * project logs through src/admin/adminAuditLog.js's recordAdminAction()
 * helper. Modeled as a sibling of EnergyTransaction.js/XpHistory.js (same
 * "who, what, before/after, when" shape family already used elsewhere in
 * this codebase), not a new invention.
 *
 * adminUsername and targetUsername are DENORMALIZED — copied at write
 * time rather than populated live from AdminUser/User — on purpose: an
 * admin renaming their account, or a player renaming theirs, must never
 * rewrite what a historical audit row says happened. Same reasoning
 * User.badges already uses for earnedAt snapshots.
 *
 * status supports the "durable record before the payout" ordering used by
 * POST /api/admin/players/:username/correct (see routes/adminPlayers.js):
 * a row is created as 'pending' BEFORE the User document is touched, then
 * flipped to 'applied' once that write succeeds (or 'failed' if it
 * didn't) — so a crash mid-correction is always resolvable from this
 * collection alone, instead of silently lost with no record either way.
 */
const adminAuditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      required: true,
      index: true,
    },
    adminUsername: {
      type: String,
      required: true,
    },

    // 'player_correction'   — POST /api/admin/players/:username/correct
    // 'admin_account_create'/'admin_account_update' — src/routes/adminAccounts.js
    // Left open-ended (not a strict mongoose enum) so future admin
    // actions can log here without a schema migration — every reader of
    // this collection (the audit-log endpoints/UI) already treats
    // `action` as a free-form label, not a fixed set.
    action: {
      type: String,
      required: true,
      index: true,
    },

    // Present for actions that target a player (player_correction).
    // Absent for actions whose target isn't a User at all (e.g. an
    // admin-account action targets another AdminUser).
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    targetUsername: {
      type: String,
      default: null,
      index: true,
    },

    // 'energy' | 'coins' | 'totalXp' for a player_correction; null for
    // action types that aren't a single-field correction.
    field: {
      type: String,
      default: null,
    },

    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Required by the API layer for any action type that requires one
    // (every player_correction does) — not enforced with `required: true`
    // here so this model stays reusable for a future action type that
    // genuinely has no reason text (e.g. a routine automated cleanup),
    // matching how EnergyTransaction/XpHistory also leave field-level
    // requiredness to the route handler rather than the schema.
    reason: {
      type: String,
      default: null,
    },

    // Monitoring signal only, same caveat as ClientSession's own clientIp
    // comment — never used to authenticate or identify anyone.
    ip: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ['pending', 'applied', 'failed'],
      default: 'applied',
      index: true,
    },
  },
  {
    timestamps: true,
  }
)

export const AdminAuditLog = mongoose.model('AdminAuditLog', adminAuditLogSchema)

export default AdminAuditLog

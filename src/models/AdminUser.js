import mongoose from 'mongoose'

/**
 * A named admin-dashboard account — replaces the old single shared
 * ADMIN_PASSWORD scheme (see server.js's POST /admin/login and
 * src/auth.js's signAdminToken, both updated alongside this model). Every
 * admin now signs in as themselves, which is what makes the per-admin
 * audit trail (src/models/AdminAuditLog.js) possible at all: before this
 * model existed, every admin session carried the identical hardcoded
 * payload { sub: 'admin', role: 'admin' } and there was no way to tell
 * which person did anything.
 *
 * Roles:
 *   'owner' — everything an 'admin' can do, plus managing admin accounts
 *             themselves (create/deactivate/change role) via
 *             src/routes/adminAccounts.js. There must always be at least
 *             one active owner (enforced in that router, not here).
 *   'admin' — every existing admin-only route (NFTs, items, seasons,
 *             energy config, player corrections, etc.) — everything
 *             except managing other admin accounts.
 *
 * Deactivating (active: false) is the only removal path — there is no
 * delete endpoint anywhere for this model, on purpose: every historical
 * AdminAuditLog row references an adminId, and a real, findable admin
 * account behind that id (even a deactivated one) is what lets old audit
 * rows keep resolving to a real person forever instead of "unknown admin".
 */
const adminUserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    passwordHash: {
      type: String,
      required: true,
    },

    role: {
      type: String,
      enum: ['owner', 'admin'],
      default: 'admin',
    },

    // Deactivate instead of delete — see class comment above for why.
    active: {
      type: Boolean,
      default: true,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

export const AdminUser = mongoose.model('AdminUser', adminUserSchema)

export default AdminUser

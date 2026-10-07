import { AdminAuditLog } from '../models/AdminAuditLog.js'

/**
 * Shared write path for the per-admin audit trail (src/models/
 * AdminAuditLog.js). Every admin write this project logs goes through
 * here — player corrections (routes/adminPlayers.js) and admin-account
 * management (routes/adminAccounts.js) — so there is exactly one place
 * that decides what an audit row looks like.
 *
 * Two usage shapes:
 *
 *   1. Fire-and-forget, already-applied action (e.g. creating an admin
 *      account — there's no separate "apply" step to sequence against):
 *
 *        recordAdminAction({ adminId, adminUsername, action, ... })
 *
 *      Mirrors recordAntiCheatAlert()'s contract exactly: persists best-
 *      effort, never throws, never awaited by the caller's own response.
 *
 *   2. Sequenced action where the audited write and the actual data write
 *      must not disagree (a player correction): create the row as
 *      'pending' BEFORE touching the target document, keep the returned
 *      id, perform the write, then call markApplied()/markFailed(). This
 *      is the "durable record before the payout" ordering described on
 *      the AdminAuditLog model itself — if the process dies between the
 *      two steps, the row is still there as 'pending' proof something was
 *      attempted, instead of vanishing with no record at all.
 *
 *        const log = await createPendingAdminAction({ ... })
 *        try {
 *          // ... perform the User update ...
 *          await markAdminActionApplied(log._id, { after })
 *        } catch (err) {
 *          await markAdminActionFailed(log._id, err.message)
 *          throw err
 *        }
 */

/** Fire-and-forget: create an already-'applied' row. Never throws. */
export function recordAdminAction({ adminId, adminUsername, action, targetUserId = null, targetUsername = null, field = null, before = null, after = null, reason = null, ip = null }) {
  AdminAuditLog.create({
    adminId, adminUsername, action, targetUserId, targetUsername, field, before, after, reason, ip,
    status: 'applied',
  }).catch((err) => {
    console.error('[adminAuditLog] failed to persist audit row (action still happened, see above):', err?.message)
  })
}

/**
 * Create a 'pending' row and return the created document — awaited by the
 * caller (unlike recordAdminAction above) because the caller needs the
 * row's _id to flip it to applied/failed afterward, and because a
 * correction must not proceed at all if its own audit row can't be
 * written in the first place (see routes/adminPlayers.js's POST
 * /:username/correct).
 */
export async function createPendingAdminAction({ adminId, adminUsername, action, targetUserId = null, targetUsername = null, field = null, before = null, reason = null, ip = null }) {
  return AdminAuditLog.create({
    adminId, adminUsername, action, targetUserId, targetUsername, field, before, reason, ip,
    status: 'pending',
  })
}

/** Flip a pending row to 'applied' once the actual data write succeeded. */
export async function markAdminActionApplied(logId, { after = null } = {}) {
  await AdminAuditLog.updateOne({ _id: logId }, { $set: { after, status: 'applied' } })
}

/** Flip a pending row to 'failed' — the data write did NOT go through. */
export async function markAdminActionFailed(logId, errorMessage = null) {
  await AdminAuditLog.updateOne(
    { _id: logId },
    { $set: { status: 'failed', after: errorMessage ? { error: errorMessage } : null } }
  )
}

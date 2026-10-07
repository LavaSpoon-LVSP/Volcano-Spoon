import express from 'express'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { AdminAuditLog } from '../models/AdminAuditLog.js'

function serializeAuditRow(row) {
  return {
    id: String(row._id),
    adminUsername: row.adminUsername,
    action: row.action,
    targetUsername: row.targetUsername,
    field: row.field,
    before: row.before,
    after: row.after,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
  }
}

/**
 * Builds the /api/admin/audit-log router — the global "what has every
 * admin done" view. The per-player equivalent (pre-filtered to one
 * player) lives at GET /api/admin/players/:username/audit-log instead
 * (see routes/adminPlayers.js) since that one hangs off a player lookup
 * rather than a standalone browse/filter view.
 *
 * @param {string} jwtSecret
 */
export function createAuditLogRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  /**
   * GET /?adminUsername=&targetUsername=&action=&from=&to=&page=&limit=
   * All filters optional. from/to are ISO date strings, inclusive,
   * compared against createdAt. Paginated (default limit 50, capped 200)
   * newest first.
   */
  router.get('/', auth, requireAdmin, async (req, res) => {
    try {
      const { adminUsername, targetUsername, action, from, to } = req.query
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

      const filter = {}
      if (adminUsername) filter.adminUsername = adminUsername
      if (targetUsername) filter.targetUsername = targetUsername
      if (action) filter.action = action
      if (from || to) {
        filter.createdAt = {}
        if (from) filter.createdAt.$gte = new Date(from)
        if (to) filter.createdAt.$lte = new Date(to)
      }

      const [rows, total] = await Promise.all([
        AdminAuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        AdminAuditLog.countDocuments(filter),
      ])

      res.json({
        entries: rows.map(serializeAuditRow),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

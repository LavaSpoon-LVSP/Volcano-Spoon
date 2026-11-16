import express from 'express'
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js'
import { AdminAuditLog } from '../models/AdminAuditLog.js'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parses a YYYY-MM-DD (or full ISO) date. A bare date is treated as a UTC
 * day: start-of-day for "from", end-of-day (23:59:59.999) for "to".
 */
function parseDayBoundary(value, endOfDay) {
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? null : d
}

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
    ip: row.ip ?? null,
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
      const { adminUsername, targetUsername, action, from, to, status } = req.query
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

      const filter = {}
      const partial = (value) => new RegExp(escapeRegExp(String(value).trim()), 'i')
      if (adminUsername?.trim()) filter.adminUsername = partial(adminUsername)
      if (targetUsername?.trim()) filter.targetUsername = partial(targetUsername)
      if (action?.trim()) filter.action = partial(action)
      if (status) filter.status = String(status)
      if (from || to) {
        filter.createdAt = {}
        if (from) {
          const start = parseDayBoundary(from, false)
          if (start) filter.createdAt.$gte = start
        }
        if (to) {
          // Inclusive of the whole "to" day — a bare YYYY-MM-DD would otherwise
          // mean midnight at the START of that day and hide everything on it.
          const end = parseDayBoundary(to, true)
          if (end) filter.createdAt.$lte = end
        }
        if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt
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

  /**
   * GET /actions
   * Distinct action labels ever recorded — feeds the ACTION filter dropdown.
   */
  router.get('/actions', auth, requireAdmin, async (_req, res) => {
    try {
      const actions = await AdminAuditLog.distinct('action')
      res.json({ actions: actions.sort() })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

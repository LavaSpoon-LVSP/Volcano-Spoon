import bcrypt from 'bcryptjs'
import express from 'express'
import { requireAuth, requireAdmin, requireOwner } from '../middleware/requireAuth.js'
import { AdminUser } from '../models/AdminUser.js'
import { recordAdminAction } from '../admin/adminAuditLog.js'

/**
 * Builds the /api/admin/admins router — managing named admin-dashboard
 * accounts themselves (src/models/AdminUser.js). Every route here is
 * owner-only (requireOwner, layered on top of requireAdmin): a plain
 * 'admin' can do everything else in the dashboard, but not create,
 * promote, or deactivate other admin accounts.
 *
 * There is deliberately no DELETE route — see AdminUser.js's class
 * comment for why (a deactivated account is still a real, findable
 * document, so historical AdminAuditLog rows always resolve to a real
 * username).
 *
 * GET   /                → list every admin account (passwordHash never
 *                           included in the response)
 * POST  /                → create a new admin account
 * PATCH /:id              → update role and/or active for an existing
 *                           account
 *
 * @param {string} jwtSecret
 */
export function createAdminAccountsRouter(jwtSecret) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function serializeAdmin(admin) {
    return {
      id: String(admin._id),
      username: admin.username,
      role: admin.role,
      active: admin.active,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    }
  }

  router.get('/', auth, requireAdmin, requireOwner, async (_req, res) => {
    try {
      const admins = await AdminUser.find({}).sort({ createdAt: 1 })
      res.json({ admins: admins.map(serializeAdmin) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /
   * Body: { username: string, password: string, role?: 'owner' | 'admin' (default 'admin') }
   */
  router.post('/', auth, requireAdmin, requireOwner, async (req, res) => {
    try {
      const { username, password, role } = req.body ?? {}

      if (!username?.trim()) {
        return res.status(400).json({ message: 'username is required' })
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ message: 'password is required and must be at least 8 characters' })
      }
      if (role && role !== 'owner' && role !== 'admin') {
        return res.status(400).json({ message: "role must be 'owner' or 'admin'" })
      }

      const existing = await AdminUser.findOne({ username: username.trim() }).select('_id')
      if (existing) {
        return res.status(409).json({ message: `An admin account named "${username}" already exists` })
      }

      const passwordHash = await bcrypt.hash(password, 10)
      const created = await AdminUser.create({
        username: username.trim(),
        passwordHash,
        role: role || 'admin',
      })

      recordAdminAction({
        adminId: req.user.sub,
        adminUsername: req.user.username,
        action: 'admin_account_create',
        targetUsername: created.username,
        after: { username: created.username, role: created.role },
        reason: `Created admin account "${created.username}" with role "${created.role}"`,
        ip: req.ip,
      })

      res.status(201).json({ admin: serializeAdmin(created) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * PATCH /:id
   * Body: { role?: 'owner' | 'admin', active?: boolean }
   * Refuses a change that would leave zero active owners — otherwise an
   * owner could lock every owner (including themselves) out of the only
   * role that can create/restore owner accounts, with no way back in
   * short of direct DB access.
   */
  router.patch('/:id', auth, requireAdmin, requireOwner, async (req, res) => {
    try {
      const { role, active } = req.body ?? {}
      if (role === undefined && active === undefined) {
        return res.status(400).json({ message: 'Provide role and/or active to update' })
      }
      if (role !== undefined && role !== 'owner' && role !== 'admin') {
        return res.status(400).json({ message: "role must be 'owner' or 'admin'" })
      }

      const target = await AdminUser.findById(req.params.id)
      if (!target) {
        return res.status(404).json({ message: 'Admin account not found' })
      }

      const willBeOwner = role !== undefined ? role === 'owner' : target.role === 'owner'
      const willBeActive = active !== undefined ? Boolean(active) : target.active
      const isDemotingOrDeactivatingAnOwner = target.role === 'owner' && (!willBeOwner || !willBeActive)

      if (isDemotingOrDeactivatingAnOwner) {
        const otherActiveOwners = await AdminUser.countDocuments({
          _id: { $ne: target._id },
          role: 'owner',
          active: true,
        })
        if (otherActiveOwners === 0) {
          return res.status(409).json({ message: 'Cannot remove the last active owner account' })
        }
      }

      const before = { role: target.role, active: target.active }
      if (role !== undefined) target.role = role
      if (active !== undefined) target.active = Boolean(active)
      await target.save()

      recordAdminAction({
        adminId: req.user.sub,
        adminUsername: req.user.username,
        action: 'admin_account_update',
        targetUsername: target.username,
        before,
        after: { role: target.role, active: target.active },
        reason: `Updated admin account "${target.username}"`,
        ip: req.ip,
      })

      res.json({ admin: serializeAdmin(target) })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

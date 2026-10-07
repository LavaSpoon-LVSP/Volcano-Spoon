import { verifyAuthToken } from '../auth.js'
import { User } from '../models/User.js'
import { AdminUser } from '../models/AdminUser.js'

/**
 * Verifies the Bearer token and attaches the decoded payload to req.user.
 *
 * Enforces tokenVersion for a player token (role !== 'admin'): a
 * successful password reset bumps User.tokenVersion (see
 * routes — server.js's POST /auth/reset-password), and every token
 * embeds the tokenVersion it was issued under (signAuthToken), so a
 * mismatch here means "this token predates the user's last password
 * reset" — reject it the same as an expired/invalid one. This is what
 * makes a reset actually end existing sessions instead of just changing
 * the password while every already-issued token keeps working for up to
 * its remaining 7-day life.
 *
 * An admin token (signAdminToken) is checked the equivalent way against
 * its own AdminUser document instead: since named admin accounts + roles
 * (src/models/AdminUser.js) replaced the old single shared
 * ADMIN_PASSWORD, an admin token now DOES have a backing document, and
 * silently trusting a 7-day-old admin JWT forever after that account is
 * deactivated (or its role changed) would be the same class of bug the
 * tokenVersion mechanism exists to close for players. req.user.role is
 * refreshed from the live AdminUser doc on every request (not just taken
 * from the token) so a role change/demotion takes effect immediately
 * instead of waiting for the token to expire.
 */
export function requireAuth(jwtSecret) {
  return async (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null

    if (!token) {
      return res.status(401).json({ message: 'Missing auth token' })
    }

    try {
      const payload = verifyAuthToken(token, jwtSecret)

      if (payload.role === 'admin' || payload.isAdmin) {
        const admin = await AdminUser.findById(payload.sub).select('username role active').lean()
        if (!admin || !admin.active) {
          return res.status(401).json({ message: 'Invalid or expired token' })
        }
        req.user = { ...payload, sub: String(admin._id), username: admin.username, role: admin.role, isAdmin: true }
        return next()
      }

      const user = await User.findById(payload.sub).select('tokenVersion').lean()
      if (!user || (payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
        return res.status(401).json({ message: 'Invalid or expired token' })
      }

      req.user = payload
      next()
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' })
    }
  }
}

/**
 * Must be used AFTER requireAuth. Rejects non-admin users. Both admin
 * roles ('admin' and 'owner' — see src/models/AdminUser.js) pass this
 * check, matching how every existing admin-only route worked before named
 * accounts/roles existed (a single shared password meant only one
 * "admin" concept at all). Only the admin-account-management routes
 * (routes/adminAccounts.js) need the stricter requireOwner below.
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'owner') {
    return res.status(403).json({ message: 'Admin access required' })
  }
  next()
}

/**
 * Must be used AFTER requireAuth (and typically alongside requireAdmin).
 * Rejects anyone who isn't an 'owner' — managing other admin accounts
 * (creating one, deactivating one, changing a role) is restricted to
 * owners so a plain 'admin' can't grant themselves — or anyone else —
 * broader access.
 */
export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ message: 'Owner access required' })
  }
  next()
}
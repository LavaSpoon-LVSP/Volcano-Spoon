import jwt from 'jsonwebtoken'

export function signAuthToken(user, jwtSecret) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      email: user.email,
      role: user.role ?? 'user',
      // Embedded so a password reset can invalidate every token issued
      // before it without a server-side session store — see
      // requireAuth()/the WebSocket handshake in server.js, both of which
      // reject a token whose tokenVersion doesn't match the User doc's
      // current value. ?? 0 covers a plain object passed in tests/scripts
      // that doesn't carry the field at all.
      tokenVersion: user.tokenVersion ?? 0,
    },
    jwtSecret,
    { expiresIn: '7d' },
  )
}

export function verifyAuthToken(token, jwtSecret) {
  return jwt.verify(token, jwtSecret)
}

/**
 * Signs an admin-dashboard token for a real, named AdminUser (see
 * src/models/AdminUser.js and server.js's POST /admin/login, which now
 * checks a per-account password hash instead of the old single shared
 * ADMIN_PASSWORD). The payload carries the admin's own id/username/role
 * so every downstream admin route — and, critically, the audit trail
 * (src/admin/adminAuditLog.js) — can attribute an action to a specific
 * person instead of just knowing "someone with admin access did this".
 *
 * role stays whatever the AdminUser document says ('owner' | 'admin');
 * requireAdmin (src/middleware/requireAuth.js) still only checks that a
 * role is present at all, since both roles pass every existing
 * admin-only route — only the admin-account-management routes
 * (routes/adminAccounts.js) additionally require role === 'owner'.
 *
 * @param {string} jwtSecret
 * @param {{_id: any, username: string, role: string}} adminUser
 */
export function signAdminToken(jwtSecret, adminUser) {
  return jwt.sign(
    {
      sub: String(adminUser._id),
      username: adminUser.username,
      role: adminUser.role,
      isAdmin: true,
    },
    jwtSecret,
    { expiresIn: '7d' },
  )
}
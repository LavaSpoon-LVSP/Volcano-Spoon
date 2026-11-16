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

/* ────────────────────────────────────────────────────────────────────
 * auditAdmin() — central Express middleware for admin mutation routes.
 *
 * Add it AFTER `auth, requireAdmin` on any admin write route so that every
 * admin change lands in the audit log without each handler having to
 * remember to log it:
 *
 *   router.put('/admin/:id', auth, requireAdmin,
 *     auditAdmin('item_update', { before: loadById(Item) }),
 *     async (req, res) => { ... })
 *
 * What it records (one AdminAuditLog row per request):
 *   - admin (req.user.sub / req.user.username), action label, IP
 *   - target player, when the route targets one (opts.target, or a
 *     `username` in req.body / req.params)
 *   - before: snapshot loaded BEFORE the handler runs (opts.before)
 *   - after:  { params, request, [result] } — the sanitised request body
 *   - status: 'applied' when the response is < 400, 'failed' otherwise
 *     (with the error message). Failed attempts are logged too.
 *
 * opts.durable = true uses the "durable record before the payout" order:
 * a 'pending' row is written (and awaited) BEFORE the handler runs, and the
 * request is refused if that row cannot be written; it is then flipped to
 * applied/failed once the response finishes. Use it for anything that moves
 * money, tokens, NFTs or player balances. Mongo may be standalone, so no
 * multi-document transaction is assumed.
 *
 * Secrets (passwords, tokens, keys, seeds…) are redacted from snapshots.
 * ──────────────────────────────────────────────────────────────────── */

const SENSITIVE_KEY = /pass(word)?|secret|token|private|mnemonic|seed|authorization|keypair|api[_-]?key/i
const MAX_SNAPSHOT_CHARS = 8000

function sanitizeSnapshot(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null
  if (depth > 6) return '[depth limit]'
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeSnapshot(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if (typeof value.toObject === 'function') return sanitizeSnapshot(value.toObject(), depth + 1)
    if (value._bsontype === 'ObjectId' || typeof value.toHexString === 'function') return String(value)
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitizeSnapshot(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`
  return value
}

function capSnapshot(value) {
  const clean = sanitizeSnapshot(value)
  if (clean === null || clean === undefined) return null
  try {
    const json = JSON.stringify(clean)
    if (json.length <= MAX_SNAPSHOT_CHARS) return clean
    return { truncated: true, preview: json.slice(0, 2000) }
  } catch {
    return { unserialisable: true }
  }
}

/** before-loader: the document with req.params[param] (default 'id'). */
export function loadById(Model, param = 'id') {
  return async (req) => Model.findById(req.params[param]).lean()
}

/** before-loader for singleton config helpers such as getEnergyConfig(). */
export function loadConfig(getter) {
  return async () => {
    const doc = await getter()
    return typeof doc?.toObject === 'function' ? doc.toObject() : doc
  }
}

export function auditAdmin(action, opts = {}) {
  const { before: loadBefore = null, target = null, durable = false } = opts

  return async (req, res, next) => {
    const admin = req.user ?? {}
    const route = `${req.method} ${req.baseUrl ?? ''}${req.path ?? ''}`

    // Resolve target player + before-snapshot up front (best effort — a
    // failure here must never block the real action, except for durable
    // actions below where the audit row itself is mandatory).
    let targetInfo = {}
    try {
      targetInfo = (typeof target === 'function' ? await target(req) : null) ?? {}
    } catch { /* ignore */ }
    const targetUsername =
      targetInfo.targetUsername ?? (typeof req.body?.username === 'string' ? req.body.username.trim() : null) ?? (req.params?.username ?? null)
    const targetUserId = targetInfo.targetUserId ?? null

    let before = null
    if (loadBefore) {
      try { before = capSnapshot(await loadBefore(req)) } catch { before = null }
    }

    const request = capSnapshot({ params: req.params, body: req.body })
    const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim()) || route

    let pendingRow = null
    if (durable) {
      try {
        pendingRow = await createPendingAdminAction({
          adminId: admin.sub, adminUsername: admin.username, action,
          targetUserId, targetUsername: targetUsername || null,
          before, reason, ip: req.ip,
        })
      } catch (err) {
        console.error('[auditAdmin] could not write durable audit row — refusing the action:', err?.message)
        return res.status(500).json({ message: 'Audit log unavailable — action refused' })
      }
    }

    // Capture the response so we can record success/failure + error text.
    let responseBody
    const originalJson = res.json.bind(res)
    res.json = (body) => { responseBody = body; return originalJson(body) }

    res.on('finish', () => {
      const ok = res.statusCode < 400
      const after = ok
        ? { request }
        : { request, error: responseBody?.message ?? `HTTP ${res.statusCode}`, httpStatus: res.statusCode }

      if (pendingRow) {
        AdminAuditLog.updateOne(
          { _id: pendingRow._id },
          { $set: { after, status: ok ? 'applied' : 'failed' } },
        ).catch((err) => console.error('[auditAdmin] failed to finalise audit row:', err?.message))
        return
      }

      AdminAuditLog.create({
        adminId: admin.sub, adminUsername: admin.username, action,
        targetUserId, targetUsername: targetUsername || null,
        before, after, reason, ip: req.ip,
        status: ok ? 'applied' : 'failed',
      }).catch((err) => console.error('[auditAdmin] failed to persist audit row:', err?.message))
    })

    next()
  }
}

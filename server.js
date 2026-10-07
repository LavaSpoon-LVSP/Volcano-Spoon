import 'dotenv/config'
import http from 'node:http'
import crypto from 'node:crypto'

import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { WebSocketServer } from 'ws'

import { connectMongo } from './mongo.js'
import { User } from './src/models/User.js'
import { AdminUser } from './src/models/AdminUser.js'
import { Score } from './src/models/Score.js'
import { PasswordResetToken } from './src/models/PasswordResetToken.js'
import { sendMail } from './src/mail/mailer.js'

import { signAuthToken, verifyAuthToken, signAdminToken } from './src/auth.js'
import { ClientSession } from './src/game/ClientSession.js'
import { createNftRouter } from './src/routes/nfts.js'
import { createSkinsRouter } from './src/routes/skins.js'
import { createCashoutRouter } from './src/routes/cashout.js'
import { createSeasonsRouter } from './src/routes/seasons.js'
import { createArenaStagesRouter } from './src/routes/arenaStages.js'
import { createJackpotRouter } from './src/routes/jackpot.js'
import { createXpRouter } from './src/routes/xp.js'
import { createBadgesRouter } from './src/routes/badges.js'
import { createItemsRouter } from './src/routes/items.js'
import { createSlotMachineRouter } from './src/routes/slotMachine.js'
import { createEnergyRouter } from './src/routes/energy.js'
import { createBlockchainAdminRouter } from './src/routes/blockchainAdmin.js'
import { createBlockchainUserRouter } from './src/routes/blockchainUser.js'
import { createAdminAccountsRouter } from './src/routes/adminAccounts.js'
import { createAdminPlayersRouter } from './src/routes/adminPlayers.js'
import { createAuditLogRouter } from './src/routes/auditLog.js'

const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET

// Allow-listed frontend origins for CORS — used to be a hardcoded array
// here, which meant every new staging URL (this project has been
// redeployed to a new *.infinity-staging.site subdomain many times —
// v5, v6, v7, v12, v13, v18, ...) needed a code change + redeploy just to
// let that origin's browser requests through, and the admin dashboard's
// own origin only ever got added once (adminvolcanospoonv2), so it silently
// stopped working the moment the dashboard moved to a newer subdomain —
// a very plausible cause of "admin login fails" that a code change was
// required to fix. CORS_ORIGINS (comma-separated, in .env) replaces that:
// update the allow-list by editing environment config, no deploy needed.
// Falls back to the previous hardcoded list if CORS_ORIGINS isn't set, so
// nothing breaks for an environment that hasn't been given the new
// variable yet.
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'https://volcanospoonv6.infinity-staging.site',
  'https://volcanospoonv7.infinity-staging.site',
  'https://adminvolcanospoonv2.infinity-staging.site',
  'https://volcanospoonv5.infinity-staging.site',
  'https://volcanospoonv12.infinity-staging.site',
  'https://volcanospoonv13.infinity-staging.site',
  'https://volcanospoonv18.infinity-staging.site',
]
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : DEFAULT_CORS_ORIGINS

console.log('booting...')

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set — check hPanel > Node.js app > Environment Variables')
}
if (!JWT_SECRET) {
  console.error('JWT_SECRET is not set — check hPanel > Node.js app > Environment Variables')
}
if (!process.env.CORS_ORIGINS) {
  console.warn('CORS_ORIGINS is not set — falling back to the built-in default origin list. Set CORS_ORIGINS (comma-separated) in the environment to change allowed origins without a code change.')
}

await connectMongo()
console.log('mongo connected')

const app = express()

// Trust the first reverse-proxy hop (hPanel/Railway/etc. always front this
// with one) so req.ip reflects the real client IP from X-Forwarded-For
// instead of the proxy's own address — needed for the admin-login rate
// limiter below to apply per real visitor rather than one shared bucket
// for everyone. Off by default (Express's own default) since blindly
// trusting X-Forwarded-For when there ISN'T a trusted proxy in front would
// let a client spoof their own IP and dodge the rate limit entirely — set
// TRUST_PROXY=1 in the environment once the deployment's proxy setup is
// confirmed.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY)
}

// Live WebSocket sessions keyed by userId — declared here (before routes)
// so the cashout router can push balance updates to a connected player's
// in-memory HUD state immediately after a conversion.
const sessions = new Map()

app.use(cors({ origin: CORS_ORIGINS }));
// Raise the body limit since NFT images are sent as base64 data URLs
app.use(express.json({ limit: '5mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body ?? {}

    if (!username?.trim()) {
      return res.status(400).json({
        message: 'Username is required',
      })
    }

    if (!email?.trim()) {
      return res.status(400).json({
        message: 'Email is required',
      })
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters',
      })
    }

    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() },
        { username },
      ],
    })

    if (existingUser) {
      return res.status(409).json({
        message: 'User already exists',
      })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    const user = await User.create({
      username,
      email: email.toLowerCase(),
      passwordHash,
    })

    const token = signAuthToken(user, JWT_SECRET)

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        coins: user.coins,
      },
    })
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.post('/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body ?? {}

    if (!email?.trim() || !password?.trim()) {
      return res.status(400).json({
        message: 'Email and password are required',
      })
    }

    const user = await User.findOne({
      email: email.toLowerCase(),
    })

    if (!user) {
      return res.status(401).json({
        message: 'Invalid email or password',
      })
    }

    const ok = await bcrypt.compare(
      password,
      user.passwordHash
    )

    if (!ok) {
      return res.status(401).json({
        message: 'Invalid email or password',
      })
    }

    const token = signAuthToken(user, JWT_SECRET)

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        coins: user.coins,
      },
    })
  } catch (error) {
    res.status(500).json({
      message: error.message,
    })
  }
})

/**
 * Rate limit for /auth/forgot-password — not just abuse prevention (a
 * script could otherwise mail-bomb any address it wants), it also
 * protects the generic-response guarantee just below: without a limit,
 * an attacker can fire many emails quickly and use small timing/behavior
 * differences across attempts to work around a same-response design far
 * more effectively than a single one-off request ever could.
 */
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Try again in a few minutes.' },
})

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000 // 30 minutes

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Always responds 200 with the same generic message, whether or not an
 * account exists for that email — the response must never be usable to
 * enumerate real accounts. If the account exists: any previous unused
 * reset tokens for it are cleared (so only the newest link works), a new
 * single-use token is generated, its SHA-256 hash (never the raw token
 * itself) is stored on a PasswordResetToken row with a 30-minute expiry,
 * and the raw token is emailed via the pluggable mail transport (see
 * src/mail/mailer.js) as a link the frontend's reset-password page reads
 * the token from (FRONTEND_URL in .env controls the link's origin — a
 * reset-password page/route is a separate frontend piece of this feature,
 * not something this backend change includes).
 */
app.post('/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const genericResponse = { message: 'If an account exists for that email, a password reset link has been sent.' }
  try {
    const { email } = req.body ?? {}
    if (!email?.trim()) {
      // Still generic — "email required" would itself be fine to reveal
      // (it reveals nothing about account existence), but staying
      // identical to the success path keeps this endpoint's behavior
      // simple to reason about and impossible to accidentally diverge.
      return res.json(genericResponse)
    }

    const user = await User.findOne({ email: email.toLowerCase() })
    if (user) {
      // Clear any previous outstanding tokens for this user first, so an
      // old emailed link can't still be used once a newer request has
      // gone out — only ever one live reset link per account.
      await PasswordResetToken.deleteMany({ userId: user._id, usedAt: null })

      const rawToken = crypto.randomBytes(32).toString('hex')
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
      await PasswordResetToken.create({
        userId: user._id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      })

      // Root path + query param (NOT /reset-password) — deliberately chosen
      // over a dedicated path so this never depends on the static host
      // that serves Frontend/'s build output being configured with an
      // SPA-fallback/rewrite rule for a sub-path (this app has no
      // server-side routes of its own — see App.jsx, which just renders
      // <Game/> unconditionally — and there was no existing rewrite config
      // anywhere in this repo to build on, nor visibility into whatever
      // static host is actually serving it). `/` always serves index.html
      // on any static host, so this works with zero hosting configuration.
      // See Game.jsx's page-state initializer for where resetToken is read.
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
      const resetLink = `${frontendUrl.replace(/\/+$/, '')}/?resetToken=${rawToken}`
      const mailResult = await sendMail({
        to: user.email,
        subject: 'Reset your password',
        text: `Someone (hopefully you) requested a password reset. This link expires in 30 minutes and can only be used once:\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email — your password hasn't been changed.`,
      })
      if (!mailResult.ok) {
        // Logged for the team, never surfaced to the client — see
        // src/mail/mailer.js's header comment on why.
        console.error('[auth] forgot-password mail send failed', { userId: String(user._id), error: mailResult.error })
      }
    }

    return res.json(genericResponse)
  } catch (error) {
    console.error('[auth] forgot-password error', error)
    // Still the generic response — an internal error is not a reason to
    // start revealing anything different to the caller.
    return res.json(genericResponse)
  }
})

/**
 * POST /auth/reset-password
 * Body: { token, password }
 * Looks the token up by its SHA-256 hash, atomically claims it
 * (findOneAndUpdate usedAt:null → now, the same optimistic-concurrency
 * "claim" pattern _settleRound uses for wallet crediting) so two
 * near-simultaneous uses of the same link can't both succeed, checks it
 * hasn't expired, then updates the password and bumps tokenVersion —
 * which is what "end existing sessions after a reset" means here: every
 * JWT already issued for this user embeds the OLD tokenVersion, and
 * requireAuth/the WebSocket handshake both reject a token whose
 * tokenVersion doesn't match the User doc's current value (see
 * src/middleware/requireAuth.js and this file's WebSocket connection
 * handler), so every previously-issued token stops working the instant
 * this runs. Any other outstanding reset tokens for the same user are
 * cleared too, since they're no longer meaningful once this succeeds.
 */
app.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body ?? {}
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'Reset token is required' })
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' })
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const now = new Date()

    const claimed = await PasswordResetToken.findOneAndUpdate(
      { tokenHash, usedAt: null, expiresAt: { $gt: now } },
      { usedAt: now },
      { new: true }
    )

    if (!claimed) {
      return res.status(400).json({ message: 'This reset link is invalid or has expired.' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    await User.findByIdAndUpdate(claimed.userId, {
      $set: { passwordHash },
      $inc: { tokenVersion: 1 },
    })

    // Cleanup — any other still-outstanding tokens for this user are moot
    // now that the password (and tokenVersion) already changed.
    await PasswordResetToken.deleteMany({ userId: claimed.userId, usedAt: null })

    return res.json({ message: 'Password reset. Please sign in with your new password.' })
  } catch (error) {
    console.error('[auth] reset-password error', error)
    return res.status(500).json({ message: 'Something went wrong. Please try again.' })
  }
})

/**
 * Rate limit for /admin/login — this endpoint guards the whole admin
 * dashboard behind one shared password with no per-account lockout, so
 * without this a script can brute-force it as fast as the network allows.
 * 10 attempts per 15 minutes per IP; failed AND successful requests both
 * count (skipSuccessfulRequests defaults to false) so a correct guess
 * doesn't reset the window for whoever's still guessing. Keyed by IP via
 * express-rate-limit's default keyGenerator (req.ip) — trust proxy should
 * be configured correctly wherever this runs behind a reverse proxy/load
 * balancer, or every request will share one IP and one shared limit.
 */
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again in a few minutes.' },
})

/**
 * POST /admin/login
 * Admin dashboard sign-in — named admin accounts (src/models/AdminUser.js),
 * checked by username + bcrypt-hashed password. Deliberately separate from
 * /auth/signin above, which is player login (email + password against a
 * User document) and is unrelated to dashboard access.
 *
 * Replaces the old single shared ADMIN_PASSWORD scheme: every admin now
 * has their own account, which is what makes the per-admin audit trail
 * (src/models/AdminAuditLog.js) possible — see src/auth.js's
 * signAdminToken() for what changed in the issued token.
 *
 * If no AdminUser documents exist yet at all (fresh install, or an
 * environment that hasn't run scripts/seedAdminUser.mjs yet), this falls
 * back to ADMIN_PASSWORD ONE TIME to let the very first owner account get
 * created without needing shell/DB access — see the fallback branch below.
 * Once at least one AdminUser exists, ADMIN_PASSWORD is never consulted
 * again by this route.
 */
app.post('/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body ?? {}

    if (!password) {
      return res.status(400).json({ message: 'Password is required' })
    }

    const anyAdminExists = await AdminUser.exists({})

    if (!anyAdminExists) {
      // Bootstrap path — see doc comment above. Only reachable while the
      // AdminUser collection is completely empty, so this can't be used to
      // bypass a real admin account that already exists.
      const adminPassword = process.env.ADMIN_PASSWORD
      if (!adminPassword) {
        return res.status(500).json({ message: 'No admin accounts exist yet, and ADMIN_PASSWORD is not configured on the server. Run scripts/seedAdminUser.mjs or set ADMIN_PASSWORD to bootstrap the first owner account.' })
      }
      const given = Buffer.from(password)
      const expected = Buffer.from(adminPassword)
      const matches = given.length === expected.length && crypto.timingSafeEqual(given, expected)
      if (!matches) {
        return res.status(401).json({ message: 'Incorrect password' })
      }
      const bootstrapUsername = (username || '').trim() || 'admin'
      const bootstrapHash = await bcrypt.hash(password, 10)
      const created = await AdminUser.create({ username: bootstrapUsername, passwordHash: bootstrapHash, role: 'owner' })
      created.lastLoginAt = new Date()
      await created.save()
      return res.json({ token: signAdminToken(JWT_SECRET, created) })
    }

    if (!username?.trim()) {
      return res.status(400).json({ message: 'Username is required' })
    }

    const admin = await AdminUser.findOne({ username: username.trim() })
    if (!admin || !admin.active) {
      // Same message whether the account doesn't exist, is deactivated, or
      // the password is wrong — don't leak which one it was.
      return res.status(401).json({ message: 'Incorrect username or password' })
    }

    const matches = await bcrypt.compare(password, admin.passwordHash)
    if (!matches) {
      return res.status(401).json({ message: 'Incorrect username or password' })
    }

    admin.lastLoginAt = new Date()
    await admin.save()

    res.json({ token: signAdminToken(JWT_SECRET, admin) })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ── NFT marketplace routes ──
   GET    /api/nfts             → public catalog
   POST   /api/nfts             → admin: add NFT
   DELETE /api/nfts/:id         → admin: remove NFT
   GET    /api/nfts/me/owned    → auth: this user's server-side owned NFT ids
   POST   /api/nfts/:id/purchase → auth: buy an NFT with LSVP Tokens, on-chain (persists ownership)
*/
app.use('/api/nfts', createNftRouter(JWT_SECRET, sessions))

/* ── Spoon Skins routes (additive — Volcanic Artifacts page's new
   "Spoon Skins" section) ──
   GET    /api/skins             → public catalog
   POST   /api/skins             → admin: add a skin
   DELETE /api/skins/:id         → admin: remove a skin
   GET    /api/skins/me/owned    → auth: this user's owned + equipped skin ids
   POST   /api/skins/:id/purchase → auth: buy a skin with LSVP (paid on-chain)
   POST   /api/skins/:id/equip   → auth: set this owned skin as the default spoon look
   POST   /api/skins/unequip     → auth: revert to the built-in default spoon
   Single-select equip, unlike NFTs' multi-active set — see routes/skins.js.
*/
app.use('/api/skins', createSkinsRouter(JWT_SECRET, sessions))

/* ── Cash-out routes ──
   GET  /api/cashout/me → auth: Lava Coin + real on-chain LSVP balances.
   The actual Lava Coin -> LSVP Token conversion flow that used to live here
   was removed — Buy LSVP (routes/blockchainUser.js's /lsvp/buy) does the
   same conversion and was kept instead. GET /me stays because several pages
   read the player's balances from it.
*/
app.use('/api/cashout', createCashoutRouter(JWT_SECRET))

/* ── Seasonal Leaderboard routes ──
   GET  /api/seasons/current              → public: active season + live top-10 (or next upcoming)
   GET  /api/seasons/history              → public: list of ended/archived seasons
   GET  /api/seasons/:id/leaderboard      → public: one season's standings (frozen if ended)
   GET  /api/seasons/admin/all            → admin: every season, any status
   POST /api/seasons/admin                → admin: create a season
   PUT  /api/seasons/admin/:id            → admin: edit an upcoming season
   POST /api/seasons/admin/:id/end        → admin: end + archive a season immediately
   DELETE /api/seasons/admin/:id          → admin: delete an upcoming (not-yet-started) season
*/
app.use('/api/seasons', createSeasonsRouter(JWT_SECRET))

/* ── Arena Stages routes ──
   GET  /api/arena-stages/me             → auth: this user's stage list + unlock costs
   POST /api/arena-stages/unlock         → auth: unlock the next sequential stage (spends Lava Coins)
   POST /api/arena-stages/select         → auth: set the active stage for the next session
   PUT  /api/arena-stages/admin/config   → admin: change a stage's unlock cost
   Additive only — existing gameplay is Arena Stage 2 unchanged; stages 1
   and 3-8 currently share the same config (see src/game/arenaStages.js).
*/
app.use('/api/arena-stages', createArenaStagesRouter(JWT_SECRET, sessions))

/* ── Jackpot Orb Purchase routes (additive — separate from the existing
   natural in-game Jackpot Orb spawn/reward, which is unchanged) ──
   GET  /api/jackpot/me                → auth: LSVP balance, owned orb count,
                                          reward-pool preview, recent history
   POST /api/jackpot/purchase          → auth: spend LSVP for +1 Jackpot Orb
   POST /api/jackpot/use               → auth: consume 1 orb, run the reward draw
   GET  /api/jackpot/admin/config      → admin: full cost + reward pool config
   PUT  /api/jackpot/admin/config      → admin: update cost/reward pool
*/
app.use('/api/jackpot', createJackpotRouter(JWT_SECRET, sessions))

/* ── Persistent XP System routes (additive) ──
   GET /api/xp/me → auth: totalXp, derived Account Level info,
                    lastXpUpdate, recent per-game XP history.
   XP itself is written server-side at the end of every non-tutorial game
   (see ClientSession.saveXp()) — this route only ever reads the live value.
*/
app.use('/api/xp', createXpRouter(JWT_SECRET))

/* ── Badges / Achievements routes (additive — migrated off browser-only
   localStorage, see src/routes/badges.js) ──
   GET  /api/badges/me   → auth: this user's earned badges.
   POST /api/badges/earn → auth: { badgeId } — idempotently records a
                            client-detected badge as earned.
*/
app.use('/api/badges', createBadgesRouter(JWT_SECRET))

/* ── In-Game Items System routes (additive — a new, separate, expandable
   system; does not touch NFTs/Marketplace/power-ups/existing rewards) ──
   GET    /api/items                  → public: enabled items catalog
   GET    /api/items/me                → auth: this user's inventory
   POST   /api/items/:id/purchase      → auth: buy an item with LSVP (paid on-chain)
   POST   /api/items/use               → auth: consume N of an owned item
   GET    /api/items/admin/all         → admin: full catalog (incl. disabled)
   POST   /api/items/admin             → admin: create an item
   PUT    /api/items/admin/:id         → admin: edit an item
   PATCH  /api/items/admin/:id/enabled → admin: enable/disable
   DELETE /api/items/admin/:id         → admin: delete an item
   POST   /api/items/admin/grant       → admin: grant item+qty to a user
*/
app.use('/api/items', createItemsRouter(JWT_SECRET))

/* ── Jackpot Slot Machine routes (additive) ──
   GET  /api/slot-machine/me            → auth: Jackpot Token balance, reward
                                           preview, cost per spin, history
   POST /api/slot-machine/spin          → auth: spend tokens, run the draw
   GET  /api/slot-machine/admin/config  → admin: full cost + reward pool config
   PUT  /api/slot-machine/admin/config  → admin: update cost/reward pool
*/
app.use('/api/slot-machine', createSlotMachineRouter(JWT_SECRET, sessions))

/* ── Daily Energy System routes (additive anti-farming feature — does not
   touch existing gameplay/rewards/NFTs/LSVP/arena progression) ──
   GET  /api/energy/me                 → auth: current energy/max/regen/unlimited state
   POST /api/energy/purchase           → auth: spend LSVP for +5 / +10 / Unlimited Hour
   GET  /api/energy/history            → auth: recent energy transaction history
   GET  /api/energy/admin/config       → admin: full config
   PUT  /api/energy/admin/config       → admin: update config
   Actually consuming Energy to start a run happens server-side in
   ClientSession.js at the 'game:start'/'game:restart' WebSocket messages
   (see EnergyService.consumeEnergyForRun), not through this router.
*/
app.use('/api/energy', createEnergyRouter(JWT_SECRET, sessions))

/* ── Solana Blockchain routes (additive — see src/config/solana.js,
   src/solana/*, src/models/NftCollection.js, NftMint.js,
   LsvpPurchaseRequest.js, LsvpBuyConfig.js, LsvpPayment.js) ──
   GET  /api/blockchain/config                  → public: network/mint/rate info
   GET  /api/blockchain/wallet                  → auth: linked wallet + LSVP balance
   POST /api/blockchain/wallet                  → auth: link/change wallet address
   GET  /api/blockchain/nft-collections          → public: published collections catalog
   GET  /api/blockchain/nft-collections/me/owned → auth: which collections this user owns
   POST /api/blockchain/nft-collections/:addr/purchase → auth: buy one NFT with LSVP
   POST /api/blockchain/lsvp/buy                 → auth: buy LSVP with Lava Coins
   GET  /api/blockchain/lsvp/requests/me         → auth: this user's LSVP purchase history
   ── admin-only, under /api/admin/blockchain ──
   GET  /network, POST /nft-collections/sync, GET /nft-collections,
   POST /nft-collections/:addr/publish, POST /nft-collections/:addr/unpublish,
   GET /failed-transfers, POST /nft-mints/:mint/retry-transfer,
   GET+PUT /lsvp-buy-config, GET /lsvp-requests,
   POST /lsvp-requests/:id/approve, POST /lsvp-requests/:id/reject
   See routes/blockchainAdmin.js and routes/blockchainUser.js for details.
   SOLANA_NETWORK in .env controls whether all of this talks to Devnet or
   Mainnet — see src/config/solana.js.
*/
app.use('/api/blockchain', createBlockchainUserRouter(JWT_SECRET, sessions))
app.use('/api/admin/blockchain', createBlockchainAdminRouter(JWT_SECRET, sessions))
app.use('/api/admin/admins', createAdminAccountsRouter(JWT_SECRET))
app.use('/api/admin/players', createAdminPlayersRouter(JWT_SECRET))
app.use('/api/admin/audit-log', createAuditLogRouter(JWT_SECRET))

const server = http.createServer(app)

const wss = new WebSocketServer({
  server,
  path: '/ws',
})

wss.on('connection', async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)

    const token = url.searchParams.get('token')

    if (!token) {
      ws.close(4001, 'Missing token')
      return
    }

    const payload = verifyAuthToken(token, JWT_SECRET)

    // Best-effort client IP for anti-cheat monitoring only (see
    // ClientSession.js / antiCheatAlerts.js) — x-forwarded-for first since
    // this typically runs behind a platform proxy/load balancer (that
    // header can be spoofed by the client, but so can any IP source; this
    // is a monitoring signal, never used to authenticate or gate anything
    // on its own), falling back to the raw socket address.
    const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null

    const user = await User.findById(payload.sub)

    if (!user) {
      ws.close(4001, 'Invalid token')
      return
    }

    // Same tokenVersion check requireAuth applies to REST calls (see its
    // own comment in src/middleware/requireAuth.js) — a password reset
    // must end an already-open game session too, not just block new HTTP
    // requests, or "end existing sessions after a reset" wouldn't actually
    // be true for anyone mid-game when the reset happens.
    if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      ws.close(4001, 'Session expired — please sign in again')
      return
    }

    const existing = sessions.get(String(user._id))

    // One active session per account (see "Round settlement and
    // connections" in the handover doc, S4): both branches below attach
    // whichever socket is currently live to the SAME ClientSession for this
    // userId, and each socket's own close handler only tears the session
    // down if it's still the socket that session is actually using. This
    // is what makes a reconnect (page refresh, brief network drop, a
    // second tab taking over) safe — an OLD socket's close event firing
    // AFTER a new one has already attached (a real race: nothing guarantees
    // close order between two overlapping WS connections for the same
    // user) must never delete a session a newer socket already took over,
    // which used to silently drop the player's connection and any
    // still-pending run-report acknowledgement out from under them.
    if (existing) {
      existing.attachSocket(ws, clientIp)
      // Re-sync coins/bestScore from the DB before resending auth:ok —
      // otherwise a reconnect (page refresh, brief network drop, etc.)
      // would resend the stale totalCoins this session has had cached
      // since it was first created instead of the current balance.
      await existing.refresh()
      existing.start()

      ws.on('message', (raw) => {
        handleSocketMessage(existing, raw)
      })

      ws.on('close', () => {
        if (existing.ws === ws) {
          existing.ws = null
          sessions.delete(String(user._id))
          existing.close()
        }
      })

      return
    }

    const session = new ClientSession({
      ws,
      user,
      ip: clientIp,
    })

    await session.init()

    sessions.set(String(user._id), session)
    session.start()

    ws.on('message', (raw) => {
      handleSocketMessage(session, raw)
    })

    ws.on('close', () => {
      // Only tear the session down if THIS socket is still the one the
      // session is using. If the client reconnected (a new ws attached via
      // the `existing` branch above) before this original socket's close
      // event happened to fire, session.ws already points at the newer
      // socket — this stale close must be a no-op, not a deletion of the
      // still-live session (this was the exact bug: the FIRST socket's
      // close handler unconditionally called sessions.delete(), even after
      // a reconnect had already handed the session off to a new socket).
      if (session.ws === ws) {
        session.ws = null
        sessions.delete(String(user._id))
        session.close()
      }
    })
  } catch {
    ws.close(4001, 'Unauthorized')
  }
})

function handleSocketMessage(session, raw) {
  try {
    const message = JSON.parse(String(raw))
    session.handleMessage(message)
  } catch {
    session.send('error', {
      message: 'Invalid JSON payload',
    })
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP + WS server listening on :${PORT}`)
})

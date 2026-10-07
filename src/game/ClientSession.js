import { randomUUID, randomInt } from 'node:crypto'
import {
  TICK_MS,
  RUN_MAX_COINS_PER_SEC,
  RUN_MAX_RARE_COINS_PER_MIN,
  RUN_MAX_MYTHIC_COINS_PER_MIN,
  RUN_MAX_JACKPOT_TOKENS_PER_MIN,
  RUN_MAX_SCORE_PER_SEC,
  RUN_TOKEN_MIN_MS,
  RUN_TOKEN_MAX_MS,
  RUN_REPORT_SAFETY_MARGIN,
  RUN_START_REFUND_WINDOW_MS,
} from './constants.js'
import { Score } from '../models/Score.js'
import { RunResult } from '../models/RunResult.js'
import { User } from '../models/User.js'
import { JackpotTransaction } from '../models/JackpotTransaction.js'
import { drawJackpotNftReward } from './jackpotNftReward.js'
import { SeasonScore } from '../models/SeasonScore.js'
import { Season } from '../models/Season.js'
import { getActiveSeason } from './seasonManager.js'
import { GameLogic, createGameStateMessage } from './GameLogic.js'
import { replayRun } from './ReplayEngine.js'
import { deriveArtifactPerksForUser } from './artifactPerks.js'
import { getArenaRewardMultipliers, getArenaRareOrbChances } from '../models/ArenaStageConfig.js'
import { XpHistory } from '../models/XpHistory.js'
import { settleUserEnergy, consumeEnergyForRun, refundEnergyForFailedStart } from './EnergyService.js'
import { checkRestartRateLimit } from './RateLimiter.js'
import { recordAntiCheatAlert } from './antiCheatAlerts.js'
import { analyzeInputPlausibility, hashInputPattern } from './inputPlausibility.js'
import {
  RESTART_MIN_GAP_MS, RESTART_WINDOW_MS, RESTART_MAX_PER_WINDOW, RESTART_MAX_PER_WINDOW_PER_IP,
  RESTART_MIN_GAP_MS_UNLIMITED, RESTART_WINDOW_MS_UNLIMITED, RESTART_MAX_PER_WINDOW_UNLIMITED,
} from './constants.js'

// Anti-cheat clamp for a single reported number — never trust a client value
// outright; fold anything negative/NaN/infinite to 0 and cap at the run's
// plausibility ceiling (see 'game:run_report' handling below).
function clampReport(value, ceiling) {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(value, ceiling)
}

export class ClientSession {
  constructor({ ws, user, ip = null }) {
    this.ws = ws
    this.user = user
    // Best-effort client IP for anti-cheat monitoring only (see
    // antiCheatAlerts.js / RateLimiter.js) — never used to authenticate or
    // gate anything on its own, just a signal for spotting one machine
    // hammering multiple accounts. Updated on reconnect — see attachSocket.
    this.ip = ip

    this.game = new GameLogic()

    this.timer = null
    this.started = false
    this.wasGameOver = false

    // Mobile "stuck a lot" / stutter fix — tick() runs game.update() and
    // broadcasts a full state message every TICK_MS (60Hz), and the client
    // synchronously re-draws the whole canvas on every single message it
    // receives (see GameEngine.setState()). That's fine on desktop, but on
    // a phone, 60 JSON.parse + full-canvas-redraw cycles a second — on the
    // same main thread as touch handling and React re-renders — is a
    // common source of jank/freezes. Physics itself still steps every tick
    // for accuracy; only how often we push a snapshot to a MOBILE client is
    // throttled, to roughly half the network+render load. Desktop is
    // unaffected (still full 60Hz) since it wasn't reported as laggy.
    this._tickCount = 0

    // ── Real-session "How to Play" tutorial (see Game.jsx beginTutorial) ──
    // isTutorial: set from the `tutorial` flag on game:restart. While true,
    // a completed run never writes bestScore/coins/NFT rewards to the DB —
    // it's a guided practice run, not a real game.
    // tutorialPaused: set via the tutorial:pause/tutorial:resume messages
    // the client sends whenever one of its contextual popups is up. tick()
    // skips entirely while this is true, so the simulation genuinely halts
    // (the spoon can't fall into the floor/ceiling while a card is on
    // screen) instead of just being hidden client-side.
    this.isTutorial = false
    this.tutorialPaused = false

    // Daily Energy System (additive) — the frontend sends 'game:restart'
    // immediately followed by 'game:launch' without waiting for a response
    // (see Game.jsx's fireGameStart). If the restart is rejected for lack
    // of Energy, that stray launch input must NOT be allowed to reach the
    // physics engine — otherwise the idle spoon would still respond to it
    // (gravity would take over, it could "die", and that death would go
    // through the normal justEnded/!isTutorial save path, awarding
    // coins/XP/bestScore for a run the Energy system never actually
    // granted). Starts true (no run has been granted yet) and is set to
    // false right before a gated run is allowed to proceed; the
    // 'game:launch'/'launch' handlers below check it before touching
    // physics.
    this._energyBlocked = true

    // Bug fix — mobile (and, more rarely, desktop) players had to swipe
    // TWICE to actually launch: fireGameStart sends 'game:restart' then
    // 'game:launch' back-to-back with no gap, but _handleGameRestart is
    // async (it awaits _gateEnergyForRun's DB round-trip before clearing
    // _energyBlocked). handleMessage dispatches restart via `void
    // this._handleGameRestart(...)` — fire and forget — so the very next
    // queued WS message (that same paired 'game:launch') was being handled
    // synchronously before the DB call resolved, hitting the
    // `_energyBlocked` guard above and getting silently dropped every
    // single time. The spoon reset to its idle position with zero velocity
    // (looked "paused") until the player's second swipe sent another
    // 'game:launch' after the gate had since cleared. Instead of dropping
    // a launch that arrives while a restart's gate is still resolving,
    // remember it here so _handleGameRestart can replay it the instant the
    // gate opens (see the 'game:launch' case and _handleGameRestart below).
    this._pendingLaunch = null

    // Run-report anti-cheat (see 'game:run_report' below) — physics/movement/
    // orbs/score now run entirely on the client (GameEngine/GameLogic there),
    // so the server no longer ticks a live simulation for real runs. Instead
    // it issues a single-use token per run (set in _handleGameRestart) and,
    // at game over, validates the client's one-shot end-of-run report against
    // it before crediting anything — see the RUN_MAX_*/RUN_TOKEN_* constants.
    this._activeRun = null
  }

  async init() {
    await this.refresh()
  }

  /**
   * Re-sync this session's in-memory bestScore/totalCoins from the DB.
   * Called on first connect (init()) AND on every reconnect to an existing
   * session (see server.js's WebSocket handler) — without this, a browser
   * refresh/reconnect would resend whatever totalCoins this ClientSession
   * happened to have cached since it was first created, ignoring any
   * balance change that happened in the meantime (a cash-out conversion,
   * play on another tab/device, an admin adjustment, etc). The leaderboard
   * doesn't have this problem because sendLeaderboard() always re-queries
   * User.coins fresh — this brings the HUD/Landing/Market coin display in
   * line with that same "always read the live DB value" behavior.
   */
  async refresh() {
    const best = await this.getBestScore()
    this.game.bestScore = best

    const user = await User.findById(this.user.id).select('coins currentArenaStage equippedSkinId')

    if (user) {
      this.game.setTotalCoins(user.coins || 0)
      // Spoon Skins — re-apply the user's equipped skin on every
      // connect/reconnect, same reasoning as coins/stage above: an equip
      // made via POST /api/skins/:id/equip from another tab/device should
      // be picked up here too, not just via the live-session sync in
      // routes/skins.js. Only affects the fallback in
      // GameLogic._resolvePlayerSkin() — never touches the existing
      // temporary orb/powerup skin swap.
      this.game.setEquippedSkin(user.equippedSkinId || null)
      // Arena Stages — re-apply the user's saved stage on every
      // connect/reconnect, same reasoning as the coins re-sync above: a
      // stage switch made via POST /api/arena-stages/select from another
      // tab/device should be picked up here too, not just via the
      // 'arena:select' live message below. Also re-applies this stage's
      // live, admin-configured reward multiplier / rare orb chance (see
      // ArenaStageConfig.js) in case an admin changed them since this
      // session started.
      const stage = user.currentArenaStage || 1
      const [rewardMultipliers, rareOrbChances] = await Promise.all([
        getArenaRewardMultipliers(),
        getArenaRareOrbChances(),
      ])
      this.game.setArenaStage(stage)
      // See saveCoins()'s "ARENA STAGE HOOK" comment -- the current
      // GameLogic class doesn't take an economy-override argument (nothing
      // in the live client ever needed one), so the admin-configured
      // reward multiplier is attached here instead and applied post-hoc.
      this.game.stageConfig = { lavaCoinMultiplier: rewardMultipliers[String(stage)] }
    }
  }

  attachSocket(ws, ip = null) {
    this.ws = ws
    // Reconnects (page refresh, brief drop) get a fresh req — keep the
    // anti-cheat IP signal current rather than frozen at first-connect.
    if (ip) this.ip = ip
  }

  async getBestScore() {
    const existing = await Score.findOne({
      userId: this.user.id,
    })

    return existing?.bestScore || 0
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick()
      }, TICK_MS)
    }

    this.started = true

    this.send('auth:ok', {
  user: {
    id: this.user.id,
    username: this.user.username,
    email: this.user.email,
    role: this.user.role,
    coins: this.game.totalCoins,
  },
  bestScore: this.game.bestScore,
})

    this.sendState()

    // Daily Energy System — push current state on connect/reconnect so the
    // Energy UI section has data immediately, without waiting for a
    // game:start/restart attempt. Fire-and-forget: never delays start().
    void this.pushEnergyState()
  }

  /**
   * Derive this player's active NFT-artifact perk flags from the DATABASE
   * (User.ownedNftIds + activeNftIds, joined against Nft.perkKey — see
   * game/artifactPerks.js) and apply them to this session's live
   * GameLogic. Replaces the old behaviour of trusting whatever `perks`
   * object the client itself reported — see artifactPerks.js's doc
   * comment for why that was a real gap (A18). Returns the derived perks
   * so callers that need to snapshot them (see _handleGameRestart's
   * _activeRun.artifactPerks, threaded into the replay at settlement so
   * "replay matches gameplay" for perk-affected runs too) can do so.
   */
  async _applyArtifactPerks() {
    const perks = await deriveArtifactPerksForUser(this.user.id)
    this.game.setArtifactPerks(perks)
    return perks
  }

  /**
   * Arena Stages — re-validate a stage selection against the DB (never
   * trust the client's claim that a stage is unlocked) and, if valid,
   * apply it to this session's live GameLogic immediately. The actual
   * persistence happens via POST /api/arena-stages/select; this message
   * just keeps an already-connected session in sync without requiring a
   * reconnect (see 'arena:select' in handleMessage()).
   */
  async _handleArenaStageSelect(stage) {
    const n = Number(stage)
    if (!Number.isInteger(n)) return

    const user = await User.findById(this.user.id).select('unlockedArenaStages currentArenaStage')
    if (!user) return

    const unlockedStages = user.unlockedArenaStages?.length ? user.unlockedArenaStages : [1]
    if (!unlockedStages.includes(n)) {
      this.send('arena:error', { message: `Arena Stage ${n} is locked` })
      return
    }

    const [rewardMultipliers, rareOrbChances] = await Promise.all([
      getArenaRewardMultipliers(),
      getArenaRareOrbChances(),
    ])
    this.game.setArenaStage(n)
    this.game.stageConfig = { lavaCoinMultiplier: rewardMultipliers[String(n)] }
    this.send('arena:state', { currentStage: n, unlockedStages })
  }

  /**
   * Daily Energy System gate (additive) — called from _handleGameStart /
   * _handleGameRestart BEFORE the run is actually allowed to begin.
   * Tutorial runs are exempt (they never write score/coins/XP either — see
   * isTutorial usage elsewhere in this file), so practicing never costs
   * Energy. Returns true if the run may proceed (and, unless Unlimited
   * Energy is active, has already atomically consumed 1 Energy); false if
   * it was rejected (an 'energy:error' has already been sent to the client
   * with the current state so the UI can show recovery/purchase options).
   */
  async _gateEnergyForRun(isTutorial) {
    // Pessimistic default — see this._energyBlocked's constructor comment.
    // Only cleared below once a run is actually granted (tutorial, or a
    // successful Energy consume), so a stray 'game:launch' that raced ahead
    // of a rejected 'game:restart' still finds physics input blocked.
    this._energyBlocked = true

    if (isTutorial) {
      this._energyBlocked = false
      return true
    }

    const result = await consumeEnergyForRun(this.user.id)
    // Stashed for _handleGameRestart's post-gate rate-limit tightening
    // (see RESTART_*_UNLIMITED constants) — read once, right after this
    // call resolves; not meant as general-purpose session state.
    this._lastEnergyGateResult = result
    if (!result.allowed) {
      this.send('energy:error', {
        message: result.reason === 'Out of Energy'
          ? "You're out of Energy — recover over time or purchase more with LSVP."
          : 'Unable to start game run.',
        energy: result,
      })
      return false
    }

    this._energyBlocked = false
    this.send('energy:state', { energy: result })
    return true
  }

  /** Sends this user's current Energy state without gating anything — used
   *  by GET /api/energy/me's live-session sync and by the Energy UI on
   *  mount/poll. */
  async pushEnergyState() {
    const state = await settleUserEnergy(this.user.id)
    if (state) this.send('energy:state', { energy: state })
  }

  /**
   * Refunds a round's Energy charge if — and only if — it's a genuine
   * "failed start": it actually consumed real Energy (not a tutorial run,
   * not covered by Unlimited Energy), its token was NEVER used (see
   * `run.used` — once a run_report has gone through for a round, whatever
   * happens to it after that is not a "failed start"), and it's still
   * within RUN_START_REFUND_WINDOW_MS of being issued (see that constant's
   * own comment in constants.js for why this window is deliberately
   * narrow — this is not a general "abandoned mid-play run" refund
   * policy, which the handover doc explicitly flags as an owner decision).
   * Fire-and-forget by design: every call site here is already doing
   * something else (issuing a fresh token, tearing the session down) that
   * must never be blocked or failed by a refund hiccup.
   */
  _refundEnergyIfEarly(run, reason) {
    if (!run || run.used || !run.energyConsumed) return
    const elapsedMs = Date.now() - run.serverIssuedAt
    if (elapsedMs > RUN_START_REFUND_WINDOW_MS) return

    // Mark it used immediately (synchronously, before the async refund
    // below even starts) so this exact round can never ALSO be credited
    // via a later game:run_report — refunding the Energy AND crediting the
    // round's rewards would be a double benefit for a run the player was
    // just refunded for supposedly never starting.
    run.used = true

    refundEnergyForFailedStart(this.user.id)
      .then((energyAfter) => {
        if (energyAfter == null) return
        console.log('ENERGY REFUNDED — failed start', { userId: this.user.id, reason, elapsedMs })
        // Best-effort UI sync — the socket may already be gone (the
        // 'socket_closed' call site) or a new run may already be under way
        // by the time this resolves; send()/pushEnergyState() are safe
        // no-ops either way.
        void this.pushEnergyState()
      })
      .catch((err) => console.error('ENERGY REFUND FAILED', { userId: this.user.id, reason, error: err }))
  }

  async _handleGameStart(message) {
    // NOTE: 'game:start' fires automatically the instant the WebSocket
    // connects (see the frontend's socket.onopen) — on every app load,
    // reconnect, or tab refocus — NOT when the player actually chooses to
    // play. The spoon stays idle (hasLaunched=false in ArcadePhysicsEngine)
    // until the player's first drag/swipe gesture, which is what sends
    // 'game:restart' + 'game:launch' together (see Game.jsx's
    // fireGameStart) — that pair is the real "a run is starting" moment,
    // even for the very first run of a session. So Energy is gated ONLY in
    // _handleGameRestart below; gating here would silently drain a
    // player's Energy just from opening the app or a network reconnect.
    await this._applyArtifactPerks()
    if (typeof message.isMobile === 'boolean') {
      this.game.setPlatform(message.isMobile)
      // No game.reset() happens on the very first game:start, so re-apply
      // the difficulty reset here to pick up the mobile/desktop starting
      // curve before the first tick runs.
      this.game.difficulty.reset()
    }
    this.started = true
    this.sendState()
  }

  async _handleGameRestart(message) {
    // Clear any leftover pending launch from a previous restart cycle
    // before this one's gate starts — see the constructor comment and the
    // 'game:launch' case below. Only a launch that arrives DURING this
    // specific restart's (async) gate window should ever be replayed by it.
    this._pendingLaunch = null

    const isTutorial = Boolean(message.tutorial)

    // Rate-limit restart issuance (see RateLimiter.js's own doc comment for
    // why this exists even with replay validation in place). Tutorial runs
    // are exempt — same rule as the Energy gate below, they never write
    // score/coins/XP either. Checked BEFORE the Energy gate's DB round trip
    // so a spam burst never even reaches the database.
    if (!isTutorial) {
      const userLimit = checkRestartRateLimit('user:' + this.user.id, {
        minGapMs: RESTART_MIN_GAP_MS, windowMs: RESTART_WINDOW_MS, maxInWindow: RESTART_MAX_PER_WINDOW,
      })
      const ipLimit = this.ip
        ? checkRestartRateLimit('ip:' + this.ip, {
            minGapMs: 0, windowMs: RESTART_WINDOW_MS, maxInWindow: RESTART_MAX_PER_WINDOW_PER_IP,
          })
        : { allowed: true, retryAfterMs: 0 }
      if (!userLimit.allowed || !ipLimit.allowed) {
        const limited = userLimit.allowed ? ipLimit : userLimit
        console.warn('RESTART RATE LIMITED', { userId: this.user.id, ip: this.ip, reason: limited.reason })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'restart_rate_limited',
          detail: { scope: userLimit.allowed ? 'ip' : 'user', reason: limited.reason },
        })
        this.send('game:restart_limited', { retryAfterMs: limited.retryAfterMs })
        return
      }
    }

    const allowed = await this._gateEnergyForRun(isTutorial)
    if (!allowed) return

    // Second, TIGHTER pass — only while Unlimited Energy is active for this
    // run, since that's exactly when the Energy system's own natural
    // throttle (1 Energy per run) is gone. A separate key namespace
    // ('user-unlimited:') so this doesn't share/interfere with the general
    // window checked above. Nothing to roll back on rejection here — an
    // Unlimited-Energy run never actually consumed Energy.
    if (!isTutorial && this._lastEnergyGateResult?.unlimitedActive) {
      const tightLimit = checkRestartRateLimit('user-unlimited:' + this.user.id, {
        minGapMs: RESTART_MIN_GAP_MS_UNLIMITED, windowMs: RESTART_WINDOW_MS_UNLIMITED,
        maxInWindow: RESTART_MAX_PER_WINDOW_UNLIMITED,
      })
      if (!tightLimit.allowed) {
        console.warn('RESTART RATE LIMITED (unlimited-energy tightened window)', {
          userId: this.user.id, ip: this.ip, reason: tightLimit.reason,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'restart_rate_limited',
          detail: { scope: 'user-unlimited', reason: tightLimit.reason },
        })
        this.send('game:restart_limited', { retryAfterMs: tightLimit.retryAfterMs })
        return
      }
    }

    const artifactPerks = await this._applyArtifactPerks()
    if (typeof message.isMobile === 'boolean') this.game.setPlatform(message.isMobile)
    this.isTutorial = isTutorial
    this.tutorialPaused = false
    this.game.reset()
    // Real-session tutorial "forced orb" round (see GameLogic's
    // setTutorialForceOrb/_updateTutorialForcedOrb) — client sets this
    // when it wants a focused, isolated practice round for one specific
    // orb type (e.g. 'lava', 'magnet'); null/omitted for a normal (or
    // non-forced tutorial) run.
    this.game.setTutorialForceOrb(message.tutorialForceOrb || null)
    this.wasGameOver = false
    this.started = true

    // Issue a fresh single-use run token — this is what the client's
    // end-of-run 'game:run_report' must present back before anything gets
    // credited (see _handleRunReport below). Captures the server's own
    // clock plus the economy config this run is actually running under, so
    // neither can be spoofed by the report itself. A non-tutorial run's
    // previous token (if any — e.g. an abandoned run) is implicitly
    // invalidated by being overwritten here.
    // Deterministic-replay anti-cheat (see ReplayEngine.js / _handleRunReport
    // below): every gameplay-affecting random roll this run makes (orb type/
    // rarity, coin payouts, hazard picks -- see seededRandom.js) must be
    // reproducible from a seed only the server ever generates. crypto's
    // randomInt (not Math.random) so it's not guessable/predictable ahead of
    // a run the way a weak seed generator could be.
    const seed = randomInt(0, 2 ** 32 - 1)

    // Energy "failed start" refund (handover doc's Energy section:
    // "Failed start ... Prevent duplicate charges on retry"). If the
    // PREVIOUS round's token was never used (no run_report ever arrived
    // for it) and THIS new restart is arriving very soon after it was
    // issued, treat the previous one as a failed/aborted start — a
    // network blip before its run:token ever reached the client, or an
    // accidental double-tap that fired two restarts — and refund its
    // Energy charge before this new restart potentially charges another
    // one. See _refundEnergyIfEarly / RUN_START_REFUND_WINDOW_MS for why
    // this only fires within a short window, not for any abandoned run.
    this._refundEnergyIfEarly(this._activeRun, 'superseded_by_new_restart')

    this._activeRun = {
      token: randomUUID(),
      seed,
      serverIssuedAt: Date.now(),
      isTutorial,
      lavaCoinMultiplier: this.game.stageConfig?.lavaCoinMultiplier ?? 1,
      // Snapshotted at restart time so the eventual replay simulates under
      // the SAME arena stage/pacing this run was actually played under,
      // even if the player switches stages again before this run ends.
      arenaStage: this.game.arenaStage,
      // Snapshotted for the same reason: the replay must apply the exact
      // perk set this run was actually played under (server-derived above,
      // not client-claimed), even if the player's active artifacts change
      // again before this run's report arrives (see the replayRun call in
      // _handleRunReport).
      artifactPerks,
      used: false,
      // Whether this round actually spent 1 real Energy (false for
      // tutorials and for a run covered by Unlimited Energy) — only a
      // round that actually cost something is ever eligible for the
      // failed-start refund above/below.
      energyConsumed: !isTutorial && !this._lastEnergyGateResult?.unlimitedActive,
    }
    // artifactPerks travels with the token so the client's LOCAL
    // simulation (the actual live/played run — see GameLogic.setArtifactPerks)
    // applies the exact same server-derived perks the eventual replay will
    // (see _handleRunReport's replayRun call using run.artifactPerks) —
    // never re-derived or invented client-side.
    this.send('run:token', { runToken: this._activeRun.token, seed, artifactPerks })

    // If the socket isn't actually open right now, that run:token send
    // just silently no-opped (see send()'s own readyState guard) — the
    // client will never receive it and this round could not possibly
    // start. Refund immediately rather than leaving the player charged for
    // a round that never had a chance to be played.
    if (!this.ws || this.ws.readyState !== 1) {
      this._refundEnergyIfEarly(this._activeRun, 'socket_not_open_at_issue')
    }

    // Replay the launch that raced ahead of this gate (see the
    // 'game:launch' case and the constructor comment) instead of it having
    // been silently dropped — this is the fix for the "have to swipe
    // twice" bug.
    if (this._pendingLaunch) {
      this.game.handleInput('launch', this._pendingLaunch)
      this._pendingLaunch = null
    }

    this.sendState()
  }

  /**
   * Validates and credits the client's one-shot end-of-run report.
   *
   * THE CLIENT'S CLAIMED score/coinsEarned/jackpotTokensCollected ARE NEVER
   * TRUSTED OR CREDITED — they're logged for anomaly comparison only (see
   * the mismatch warning below). What actually gets credited is computed
   * HERE, by the server, via ReplayEngine.replayRun(): the client instead
   * sends this run's per-frame dt log and discrete input log (see Game.jsx),
   * and the server re-simulates the exact same GameLogic/OrbSystem/
   * ArenaSystem/etc. code the client ran, seeded with a seed ONLY the
   * server ever generated (see _handleGameRestart), and reads the resulting
   * score/coins/jackpotTokens off of THAT. A forged game:run_report can no
   * longer hand-pick a payout — there's nothing left in the message that
   * determines what gets credited.
   *
   * The old RUN_MAX_ / RUN_TOKEN_ plausibility-ceiling constants are still
   * used for the cheap duration/size sanity checks below (fail fast before
   * paying for a replay), but no longer for crediting a value.
   *
   * ROUND SETTLEMENT (see RunResult.js / _settleRound below, and "Match
   * settlement and connection recovery" in the handover doc):
   * - A durable RunResult round record (unique on `roundId`, this run's
   *   own single-use runToken) is created BEFORE anything is credited, and
   *   this function's very first step is checking for one that ALREADY
   *   exists and is committed — so a retried/duplicated 'game:run_report'
   *   for a round that already finished settling just re-sends the exact
   *   same saved result instead of rejecting it or crediting it twice.
   * - Everything this round actually pays out (score/coinsEarned/
   *   jackpotTokensCollected/xpEarned) is captured into local variables the
   *   instant the replay finishes and is never read back off `this.game`
   *   or `this._activeRun` again — both of those can be freely overwritten
   *   by a brand new `game:restart` the player fires off while this
   *   round's settlement is still being awaited, without corrupting what
   *   gets saved for THIS round.
   */
  async _handleRunReport(message) {
    const token = String(message.runToken || '')

    if (!token) {
      recordAntiCheatAlert({ userId: this.user.id, ip: this.ip, type: 'invalid_or_expired_token' })
      this.send('run:rejected', { reason: 'invalid_or_expired_token' })
      return
    }

    // ---- Retry path: this exact round already has a persisted result ----
    // Covers a client re-sending 'game:run_report' after losing the
    // run:validated acknowledgement (dropped connection, backgrounded tab,
    // page refresh before the ack arrived — see Game.jsx's reconnect/resend
    // logic). A committed round is never re-settled; its saved numbers are
    // just re-sent.
    const existingRound = await RunResult.findOne({ roundId: token, userId: this.user.id })
    if (existingRound?.status === 'committed') {
      this.send('run:validated', {
        score: existingRound.score,
        coinsEarned: existingRound.coinsEarned,
        jackpotTokensCollected: existingRound.jackpotTokensCollected,
        totalCoins: existingRound.totalCoinsAfter ?? this.game.totalCoins,
        roundId: existingRound.roundId,
      })
      return
    }

    let score, coinsEarned, jackpotTokensCollected, xpEarned, arenaStage, lavaCoinMultiplier, inputPatternHash = null

    if (existingRound) {
      // A previous attempt for this exact round got far enough to compute
      // (and persist) its replayed result but never finished crediting it
      // — e.g. the server restarted mid-settlement. Resume from those
      // already-persisted numbers: do NOT re-validate against
      // `this._activeRun` (which may since belong to a newer run entirely)
      // and do NOT pay for another replay.
      ;({ score, coinsEarned, jackpotTokensCollected, xpEarned, arenaStage, lavaCoinMultiplier } = existingRound)
    } else {
      const run = this._activeRun

      if (!run || run.used || token !== run.token) {
        recordAntiCheatAlert({ userId: this.user.id, ip: this.ip, type: 'invalid_or_expired_token' })
        this.send('run:rejected', { reason: 'invalid_or_expired_token' })
        return
      }

      // Consume the token immediately — before any DB round trip below — so
      // a duplicated report can never validate a SECOND time against this
      // same live run (a genuine retry of THIS round is handled above/below
      // via the persisted RunResult, not by reusing _activeRun again).
      run.used = true
      this._activeRun = null

      const elapsedMs = Date.now() - run.serverIssuedAt
      if (elapsedMs < RUN_TOKEN_MIN_MS || elapsedMs > RUN_TOKEN_MAX_MS) {
        console.warn('RUN REPORT REJECTED — implausible duration', {
          userId: this.user.id,
          elapsedMs,
        })
        recordAntiCheatAlert({ userId: this.user.id, ip: this.ip, type: 'implausible_duration', detail: { elapsedMs } })
        this.send('run:rejected', { reason: 'implausible_duration' })
        return
      }

      // Tutorial runs never write score/coins/XP (same rule as the old
      // server-tick path) — nothing left to validate or credit.
      if (run.isTutorial) return

      const frames = Array.isArray(message.frames) ? message.frames : null
      const inputs = Array.isArray(message.inputs) ? message.inputs : []

      if (!frames || frames.length === 0) {
        console.warn('RUN REPORT REJECTED — missing replay log', { userId: this.user.id })
        recordAntiCheatAlert({ userId: this.user.id, ip: this.ip, type: 'missing_replay_log' })
        this.send('run:rejected', { reason: 'missing_replay_log' })
        return
      }

      // Cheap sanity checks BEFORE paying for a replay (which is fast, but
      // still real CPU — no reason to spend it on an obviously bad payload).
      // 1) Hard size caps, matching ReplayEngine's own backstop.
      if (frames.length > 500000 || inputs.length > 20000) {
        console.warn('RUN REPORT REJECTED — replay log too large', {
          userId: this.user.id,
          frameCount: frames.length,
          inputCount: inputs.length,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'replay_log_too_large',
          detail: { frameCount: frames.length, inputCount: inputs.length },
        })
        this.send('run:rejected', { reason: 'replay_log_too_large' })
        return
      }

      // Basic anti-bot input plausibility (Developer Update, 30 Sep 2026) —
      // on top of the size/duration caps above, look at the SHAPE of the
      // discrete launch inputs themselves: reaction time between inputs,
      // and raw launch magnitude, both outside what a real human/device can
      // produce. See game/inputPlausibility.js for the full reasoning.
      const plausibility = analyzeInputPlausibility({ inputs, frames })
      if (plausibility.rejectReason) {
        console.warn('RUN REPORT REJECTED — ' + plausibility.rejectReason, {
          userId: this.user.id,
          detail: plausibility.detail,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: plausibility.rejectReason,
          detail: plausibility.detail,
        })
        this.send('run:rejected', { reason: plausibility.rejectReason })
        return
      }
      // Scripted-timing is informational only — flagged for admin review,
      // never blocks crediting this run (see analyzeInputPlausibility's doc
      // comment: a human decides, not an auto-ban).
      for (const flag of plausibility.flags) {
        recordAntiCheatAlert({ userId: this.user.id, ip: this.ip, type: flag, detail: plausibility.detail })
      }
      // 2) The virtual duration the frame log claims (sum of each frame's dt,
      // in ms) can never legitimately exceed the REAL wall-clock time the
      // server itself measured for this run (each dt is derived from real
      // inter-frame timestamps on the client, capped the same way the client's
      // own loop caps it — see the Math.min(4, ...) below, matching
      // GameEngine.js) — so a claimed virtual duration far beyond elapsedMs
      // can only mean a fabricated log, e.g. "10 minutes of gameplay" stuffed
      // into a run that actually lasted 300ms of real time. A little slack
      // (10% + 1s) covers legitimate rounding/final-frame overshoot.
      let claimedVirtualMs = 0
      for (let i = 0; i < frames.length; i += 1) {
        const raw = Number(frames[i])
        claimedVirtualMs += (Number.isFinite(raw) && raw > 0 ? Math.min(3, raw) : 1) * 16.667
      }
      if (claimedVirtualMs > elapsedMs * 1.1 + 1000) {
        console.warn('RUN REPORT REJECTED — claimed virtual duration exceeds real elapsed time', {
          userId: this.user.id,
          elapsedMs,
          claimedVirtualMs,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'implausible_replay_duration',
          detail: { elapsedMs, claimedVirtualMs },
        })
        this.send('run:rejected', { reason: 'implausible_replay_duration' })
        return
      }

      const replayResult = replayRun({
        seed: run.seed,
        frames,
        inputs,
        arenaStage: run.arenaStage,
        artifactPerks: run.artifactPerks,
      })

      if (replayResult.crashed) {
        // Fail CLOSED, not open — never fall back to trusting the client's
        // self-reported numbers just because the replay itself hit a bug or a
        // malformed log. Worst case a legitimate player's run scores nothing
        // and this gets investigated from the logged error; that's the safe
        // failure direction for a system whose currency cashes out to real
        // Solana tokens.
        console.error('RUN REPORT REJECTED — replay crashed/invalid', {
          userId: this.user.id,
          error: replayResult.error,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'replay_failed',
          detail: { error: replayResult.error },
        })
        this.send('run:rejected', { reason: 'replay_failed' })
        return
      }

      score = Math.max(0, Math.round(replayResult.score))
      const rawCoins = Math.max(0, Math.round(replayResult.coins))
      jackpotTokensCollected = Math.max(0, Math.round(replayResult.jackpotTokensCollected))
      xpEarned = score
      arenaStage = run.arenaStage
      // FIXED MULTIPLIER (handover doc S2): apply the reward multiplier
      // SNAPSHOTTED at this run's own game:restart (run.lavaCoinMultiplier
      // — see _handleGameRestart), never the session's current/live
      // `this.game.stageConfig`. A stage switch mid-run (see
      // _handleArenaStageSelect) must never change what an already-started
      // run pays out. Computed once, here, and this exact number is both
      // what gets credited AND what's returned to the client below — never
      // just a changed total wallet balance with no breakdown.
      lavaCoinMultiplier = run.lavaCoinMultiplier ?? 1
      coinsEarned = Math.round(rawCoins * lavaCoinMultiplier)

      // Anomaly logging only — informational, never affects what's credited.
      // A real gap here (beyond float-rounding noise) means either a client
      // bug (its own local sim disagreed with the authoritative replay) or an
      // attempted forgery; either way it's worth knowing about even though
      // the forged numbers themselves are already inert.
      const reportedCoins = Number(message.coinsEarned)
      const reportedJackpotTokens = Number(message.jackpotTokensCollected)
      const reportedScore = Number(message.score)
      if (
        Math.abs((reportedCoins || 0) - coinsEarned) > 1 ||
        Math.abs((reportedJackpotTokens || 0) - jackpotTokensCollected) > 0 ||
        Math.abs((reportedScore || 0) - score) > 1
      ) {
        console.warn('RUN REPORT MISMATCH — client self-report disagreed with server replay (client value NOT used)', {
          userId: this.user.id,
          reported: { coins: reportedCoins, jackpotTokens: reportedJackpotTokens, score: reportedScore },
          replayed: { coins: coinsEarned, jackpotTokens: jackpotTokensCollected, score },
          framesReplayed: replayResult.framesReplayed,
          framesSubmitted: frames.length,
        })
        recordAntiCheatAlert({
          userId: this.user.id, ip: this.ip, type: 'mismatch',
          detail: {
            reported: { coins: reportedCoins, jackpotTokens: reportedJackpotTokens, score: reportedScore },
            replayed: { coins: coinsEarned, jackpotTokens: jackpotTokensCollected, score },
          },
        })
      }

      // Scripted movement, part 2 (Developer Update, 30 Sep 2026): flag an
      // EXACT repeat of this player's own input sequence from an earlier
      // run — informational only, never blocks crediting THIS run (see
      // hashInputPattern's doc comment in inputPlausibility.js).
      inputPatternHash = hashInputPattern(inputs)
      if (inputPatternHash) {
        const duplicateRun = await RunResult.findOne({
          userId: this.user.id,
          status: 'committed',
          inputPatternHash,
        }).select('roundId').sort({ createdAt: -1 })
        if (duplicateRun) {
          recordAntiCheatAlert({
            userId: this.user.id, ip: this.ip, type: 'duplicate_input_pattern',
            detail: { matchedRoundId: duplicateRun.roundId },
          })
        }
      }
    }

    // ---- Commit: create the round record (if this is the first attempt)
    // and credit score/Coins/XP/Jackpot Tokens together — see
    // _settleRound(). From here on this round is driven purely by its own
    // captured local values, decoupled from `this.game`/`this._activeRun` —
    // a NEW game:restart racing in concurrently (a fresh `this.game.reset()`,
    // a fresh `this._activeRun`) cannot corrupt or overwrite a round that's
    // still being saved.
    let round
    try {
      round = await this._settleRound(
        { roundId: token, score, coinsEarned, jackpotTokensCollected, xpEarned, arenaStage, lavaCoinMultiplier, inputPatternHash },
        existingRound || null
      )
    } catch (error) {
      if (error?.code === 'duplicate_in_flight') {
        // Another report for this exact round is already mid-settlement
        // right now (e.g. the client fired a duplicate message). Nothing
        // was lost — tell the client this is safely retryable shortly.
        console.warn('RUN REPORT — settlement already in progress for this round', {
          userId: this.user.id, roundId: token,
        })
        this.send('run:rejected', { reason: 'settlement_in_progress', roundId: token, retryable: true })
        return
      }

      console.error('RUN REPORT SETTLEMENT ERROR', { userId: this.user.id, roundId: token, error })
      recordAntiCheatAlert({
        userId: this.user.id, ip: this.ip, type: 'settlement_error',
        detail: { roundId: token, error: String(error?.message || error) },
      })
      // Recoverable, not fatal — the round record (if it made it that far)
      // stays exactly as far along as it got (see _settleRound's
      // walletCredited/bestScoreSaved markers), so a retry of this same
      // round resumes instead of starting over or double-crediting.
      this.send('run:rejected', { reason: 'settlement_error', roundId: token, retryable: true })
      return
    }

    // Keep this session's in-memory wallet/best-score in sync with what was
    // actually just persisted (same reasoning as the old saveCoins()
    // comment on why this.game.totalCoins needs to track the DB) — safe
    // even if a concurrent restart has since reset this.game's per-run
    // fields, since totalCoins/bestScore are wallet-level, not per-run.
    if (Number.isFinite(round.totalCoinsAfter)) this.game.setTotalCoins(round.totalCoinsAfter)
    this.game.bestScore = Math.max(this.game.bestScore, round.bestScoreAfter ?? score)

    this.send('jackpot_tokens:awarded', {
      tokensEarned: jackpotTokensCollected,
      jackpotTokens: round.jackpotTokensAfter ?? jackpotTokensCollected,
    })
    this.send('xp:awarded', {
      xpEarned,
      totalXp: round.totalXpAfter ?? xpEarned,
    })

    await this.sendLeaderboard()

    // Wallet sync now rides on run:validated itself instead of a
    // trailing sendState() call — see the old saveCoins() comment on why
    // this.game.totalCoins needs to be kept in sync with the DB. A full
    // sendState() here used to re-send this session's own idle GameLogic
    // instance's hud (gameOver always stale false for a real run, since
    // replay — not this instance — is what actually plays it out), which
    // clobbered the client's correct hud.gameOver:true a moment after it
    // was set: the Game Over modal would flash and immediately disappear.
    //
    // `roundId` lets the client show a stable reference for this result
    // (pending/confirmed/rejected — see GameOverlay.jsx) and is exactly
    // what a resubmitted report is matched against above.
    this.send('run:validated', {
      score, coinsEarned, jackpotTokensCollected,
      totalCoins: round.totalCoinsAfter ?? this.game.totalCoins,
      roundId: token,
    })
  }

  /**
   * Creates (or resumes) this round's durable RunResult record and credits
   * Coins, Jackpot Tokens and XP together in ONE atomic write on the User
   * document (MongoDB guarantees a single-document update is all-or-
   * nothing), then records the best-score update. Safe to call more than
   * once for the same `roundId` — see the `walletCredited`/`bestScoreSaved`
   * markers below, which make each half of the settlement idempotent on
   * its own even without a multi-document transaction.
   *
   * @param {object} roundInput
   * @param {RunResult|null} existingRound - an already-loaded, not-yet-
   *   committed round record to resume from, if the caller already has one
   *   (avoids a redundant lookup/insert).
   * @returns {Promise<RunResult>} the committed round record.
   */
  async _settleRound(
    { roundId, score, coinsEarned, jackpotTokensCollected, xpEarned, arenaStage, lavaCoinMultiplier, inputPatternHash = null },
    existingRound = null
  ) {
    let round = existingRound

    if (!round) {
      try {
        round = await RunResult.create({
          roundId,
          userId: this.user.id,
          status: 'settling',
          score,
          coinsEarned,
          jackpotTokensCollected,
          xpEarned,
          arenaStage,
          lavaCoinMultiplier,
          inputPatternHash,
        })
      } catch (error) {
        if (error?.code === 11000) {
          // Unique-index collision on roundId — another concurrent call for
          // this exact round already created the record. Never create a
          // second one; load whatever's there and either return its
          // already-committed result or resume settling it from its own
          // persisted values.
          const existing = await RunResult.findOne({ roundId, userId: this.user.id })
          if (existing?.status === 'committed') return existing
          if (existing) {
            return this._settleRound(
              {
                roundId,
                score: existing.score,
                coinsEarned: existing.coinsEarned,
                jackpotTokensCollected: existing.jackpotTokensCollected,
                xpEarned: existing.xpEarned,
                arenaStage: existing.arenaStage,
                lavaCoinMultiplier: existing.lavaCoinMultiplier,
                inputPatternHash: existing.inputPatternHash,
              },
              existing
            )
          }
          const duplicateError = new Error('duplicate_in_flight')
          duplicateError.code = 'duplicate_in_flight'
          throw duplicateError
        }
        throw error
      }
    }

    if (!round.walletCredited) {
      // Atomically CLAIM the right to credit this round's wallet before
      // touching User at all — findOneAndUpdate's filter+update is a single
      // atomic document operation, so if two concurrent calls for this
      // exact roundId both reach this point (e.g. a duplicated resend
      // racing a reconnect-triggered resend of the same still-uncommitted
      // round), only ONE of them can ever flip walletCredited false→true.
      // Without this, two callers could both see `!round.walletCredited`
      // and both apply the $inc below, crediting the same round twice.
      const claimed = await RunResult.findOneAndUpdate(
        { _id: round._id, walletCredited: false },
        { walletCredited: true },
        { new: false }
      )

      if (claimed) {
        const inc = {}
        if (coinsEarned > 0) inc.coins = coinsEarned
        if (jackpotTokensCollected > 0) inc.jackpotTokens = jackpotTokensCollected
        if (xpEarned > 0) inc.totalXp = xpEarned

        const updatedUser = Object.keys(inc).length > 0
          ? await User.findByIdAndUpdate(
              this.user.id,
              { $inc: inc, ...(xpEarned > 0 ? { $set: { lastXpUpdate: new Date() } } : {}) },
              { new: true }
            ).select('coins jackpotTokens totalXp')
          : await User.findById(this.user.id).select('coins jackpotTokens totalXp')

        round.walletCredited = true
        round.totalCoinsAfter = updatedUser?.coins ?? null
        round.jackpotTokensAfter = updatedUser?.jackpotTokens ?? null
        round.totalXpAfter = updatedUser?.totalXp ?? null
        await RunResult.updateOne(
          { _id: round._id },
          {
            totalCoinsAfter: round.totalCoinsAfter,
            jackpotTokensAfter: round.jackpotTokensAfter,
            totalXpAfter: round.totalXpAfter,
          }
        )

        // Fire-and-forget analytics/history log — never blocks or fails the
        // actual XP credit above (that already happened).
        if (xpEarned > 0) {
          XpHistory.create({
            userId: this.user.id,
            xpEarned,
            totalXpAfter: updatedUser?.totalXp ?? xpEarned,
            score,
          }).catch((err) => console.error('XP HISTORY LOG FAILED:', err))
        }
      } else {
        // Lost the claim — another concurrent call for this same round is
        // (or just finished) crediting it. Wait briefly for its
        // totalCoinsAfter/etc to land rather than reporting stale/null
        // values back to this caller.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const latest = await RunResult.findById(round._id)
          if (latest?.totalCoinsAfter != null || latest?.status === 'committed') {
            round.totalCoinsAfter = latest.totalCoinsAfter
            round.jackpotTokensAfter = latest.jackpotTokensAfter
            round.totalXpAfter = latest.totalXpAfter
            round.walletCredited = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    }

    if (!round.bestScoreSaved) {
      const bestScoreAfter = await this.saveBestScore(score)
      round.bestScoreSaved = true
      round.bestScoreAfter = bestScoreAfter
      await RunResult.updateOne({ _id: round._id }, { bestScoreSaved: true, bestScoreAfter })
    }

    round.status = 'committed'
    await RunResult.updateOne({ _id: round._id }, { status: 'committed' })

    return round
  }


  handleMessage(message) {
    const type = String(message.type ?? '').toLowerCase()

    switch (type) {
      case 'game:start': {
        void this._handleGameStart(message)
        break
      }

      case 'game:flap': {
        // Legacy message type — no longer sent by the client (controls are
        // now drag/swipe-based) but handled defensively if it ever arrives.
        this.game.handleInput('flap')
        break
      }

      case 'game:click':
      case 'game:tap':
      case 'game:space':
      case 'click':
      case 'tap':
      case 'space': {
        // Daily Energy System guard — see this._energyBlocked's doc comment.
        if (this._energyBlocked) break
        this.game.handleInput(type)
        break
      }

      case 'game:launch': {
        // Daily Energy System guard — a launch that arrives while
        // _energyBlocked is still true is either (a) truly unearned (no
        // game:restart granted a run) or (b) raced ahead of THIS message's
        // own paired game:restart, which is still awaiting its async
        // energy-gate DB call (see the constructor comment and
        // _handleGameRestart). Case (b) is the common one — fireGameStart
        // sends restart+launch back-to-back with no gap — so instead of
        // dropping it outright, remember it as pending: if the in-flight
        // restart's gate opens, it replays this exact input there instead
        // of the player needing to swipe a second time. If the restart is
        // instead rejected (case a, or a genuinely out-of-Energy attempt),
        // _energyBlocked simply never clears and this is never replayed.
        if (this._energyBlocked) {
          const dx = Number(message.dx)
          const dy = Number(message.dy)
          this._pendingLaunch = {
            dx: Number.isFinite(dx) ? dx : 0,
            dy: Number.isFinite(dy) ? dy : -10,
          }
          break
        }
        // Drag-release (desktop) or swipe (mobile) vector, in game-space px.
        const dx = Number(message.dx)
        const dy = Number(message.dy)
        this.game.handleInput('launch', {
          dx: Number.isFinite(dx) ? dx : 0,
          dy: Number.isFinite(dy) ? dy : -10,
        })
        break
      }

      case 'launch': {
        // Legacy alias — same pending-launch handling as 'game:launch'
        // above (see that case's comment).
        if (this._energyBlocked) {
          const dx = Number(message.dx)
          const dy = Number(message.dy)
          this._pendingLaunch = {
            dx: Number.isFinite(dx) ? dx : 0,
            dy: Number.isFinite(dy) ? dy : -10,
          }
          break
        }
        const dx = Number(message.dx)
        const dy = Number(message.dy)
        this.game.handleInput('launch', {
          dx: Number.isFinite(dx) ? dx : 0,
          dy: Number.isFinite(dy) ? dy : -10,
        })
        break
      }

      case 'game:restart': {
        void this._handleGameRestart(message)
        break
      }

      // Sent once by the client at game over, now that physics/movement/
      // orbs/score all run locally — see _handleRunReport above.
      case 'game:run_report': {
        void this._handleRunReport(message)
        break
      }

      // Sent by the client while a tutorial popup (intro/lava/hazard) is up
      // — see triggerTutorialPopup/continueTutorialPopup in Game.jsx. This
      // actually halts the simulation in tick() below, rather than just
      // hiding it client-side, so the player can't die to a hazard/fall they
      // can't see or react to while reading the card.
      case 'tutorial:pause': {
        this.tutorialPaused = true
        break
      }
      case 'tutorial:resume': {
        this.tutorialPaused = false
        break
      }

      /* Swap which orb the tutorial is currently teaching, WITHOUT
         restarting the run.
         The tutorial used to re-arm drag-to-launch and fire a fresh
         game:restart for every single orb, so the walkthrough was 15
         disconnected mini-rounds — collect one orb, everything stops, aim
         and launch again from scratch. This lets the next lesson's orb
         simply appear in the run already in progress, so "after the Lava
         Orb it should spawn the Magnet Orb in the same gameplay" is
         literally what happens, and the player keeps their momentum and
         position throughout. */
      // NOTE: `type` above has already been through .toLowerCase() (see the
      // top of this method), so this case label must be written all-lower
      // too — 'tutorial:setOrb' (capital O) would never match the lowered
      // incoming value and would silently fall through to the default
      // "Unknown message type" case below. This was exactly the bug behind
      // the "Unknown message type" badge appearing the moment a tutorial
      // orb card's "Start"/"Try It" was tapped (that tap sends this exact
      // message type — see startTutorialOrbRound in Game.jsx).
      case 'tutorial:setorb': {
        // TEMP DEBUG — remove once the Sun Flame freeze is root-caused.
        console.log('[tutorial] received tutorial:setorb', {
          isTutorial: this.isTutorial,
          orbType: message.orbType,
        })
        if (this.isTutorial) this.game.setTutorialForceOrb(message.orbType || null)
        break
      }

      /* Arm one specific arena hazard for the hazard lessons (darkness,
         lava rain, the real eruption, wind, earthquake, wall spikes, ninja
         knives, geysers). These are now genuine, playable hazards running
         in the live session rather than the passive client-side mock-ups
         the tutorial used to show. See GameLogic.setTutorialHazard.
         Same lowercasing note as 'tutorial:setorb' above — this label must
         stay all-lower to match the already-lowercased `type`. */
      case 'tutorial:sethazard': {
        if (this.isTutorial) this.game.setTutorialHazard(message.hazardType || null)
        break
      }

      case 'leaderboard:get': {
        void this.sendLeaderboard()
        break
      }

      // Arena Stages — sent by the client right after POST
      // /api/arena-stages/select succeeds, so the already-connected
      // session's GameLogic picks up the new stage immediately instead of
      // waiting for a reconnect. Re-validates against the DB (never
      // trusts the client's claim that a stage is unlocked).
      case 'arena:select': {
        void this._handleArenaStageSelect(message.stage)
        break
      }

      // Daily Energy System — on-demand refresh (e.g. client-side countdown
      // reaching zero, or the Energy section polling while visible).
      case 'energy:get': {
        void this.pushEnergyState()
        break
      }

      case 'ping': {
        this.send('pong', { now: Date.now() })
        break
      }

      default: {
        this.send('error', {
          message: 'Unknown message type',
        })
      }
    }
  }

 async tick() {
  if (!this.started) return

  // Tutorial popup is up (see 'tutorial:pause' above) — hold the whole
  // simulation, not just the client's view of it. Nothing advances (no
  // physics, no falling, no server-side death) until 'tutorial:resume'
  // arrives, so a hazard/floor the player couldn't see coming while the
  // card was open can no longer kill them out from under it.
  if (this.tutorialPaused) return

  // Real (non-tutorial) runs no longer simulate or broadcast physics from
  // the server at all — movement/orbs/score run entirely on the client's
  // own GameEngine/GameLogic, and the run's outcome is only checked once, at
  // game over, via 'game:run_report' (see _handleRunReport). The real-
  // session "How to Play" tutorial is the one exception left ticking here
  // server-side, since its hazards were deliberately made "genuine, playable
  // hazards running in the live session" (see _handleGameRestart) and it
  // never touches score/coins/XP either way, so there's nothing to cheat.
  if (!this.isTutorial) return

  try {
    const state = this.game.update()
    const isGameOver = Boolean(state?.hud?.gameOver)
    const justEnded = isGameOver && !this.wasGameOver

    // Commit this synchronously, before any `await`, so an overlapping
    // tick (the next setInterval firing while this one is still awaiting
    // the DB calls below) sees wasGameOver already flipped and skips the
    // save block. Without this, a slow DB round-trip lets multiple ticks
    // race past the `!this.wasGameOver` check and double/triple-credit coins.
    this.wasGameOver = isGameOver

    // Drain server events produced this tick (jackpot, mythic, game_over, etc.)
    const serverEvents = this.game.drainServerEvents()
    for (const evt of serverEvents) {
      if (evt.type === 'jackpot_collected' && evt.tryNftReward && !this.isTutorial) {
        // Fire-and-forget — don't await so it never delays the tick loop.
        // Skipped entirely in tutorial mode — a guide run should never
        // actually award a real marketplace NFT.
        //
        // NOTE: as of the real-run tick() early-return above (`if
        // (!this.isTutorial) return`), this whole block is dead for actual
        // gameplay — real runs no longer tick server-side at all, so this
        // branch only ever runs during `isTutorial` sessions, which the
        // `!this.isTutorial` check right here then excludes anyway. Net
        // effect: a natural in-run NFT award currently never fires for any
        // run, tutorial or real. This was a known handover-doc gap ("NFTs
        // — Clear Player Explanation"); per that doc's own stated
        // resolution, the chosen fix was NOT to wire a live natural-NFT
        // route through the replay-validated real-run path (a much larger,
        // riskier change touching ReplayEngine/ClientSession's
        // server-event handling), but instead to make it explicit,
        // player-facing, that gameplay only ever awards a Jackpot Token —
        // see GameOverlay.jsx's "JACKPOT TOKENS" row. An NFT chance only
        // ever comes from a separate Slot Machine spin. If a natural
        // in-run NFT drop is wanted later, this is the place to wire it,
        // but it needs its own replay-safe event path first.
        void this._handleJackpotNftReward()
      }
      // Real-session tutorial "forced orb" round completed — see
      // GameLogic's _updateTutorialForcedOrb. Tells the client the target
      // orb was collected so it can advance TUTORIAL_FLOW (show the next
      // card) — it also immediately re-pauses via tutorial:pause once it
      // receives this, so nothing else happens server-side in the meantime.
      if (evt.type === 'tutorial_orb_collected') {
        this.send('tutorial_orb_collected', { orbType: evt.orbType })
      }
      // Forward milestone celebrations and near-miss events directly to client
      if (evt.type === 'milestone') {
        this.send('milestone', { milestone: evt.milestone, label: evt.label, badge: evt.badge, freezeMs: evt.freezeMs ?? 0 })
      }
      if (evt.type === 'near_miss') {
        this.send('near_miss', {})
      }
    }

    if (justEnded) {
      console.log('GAME OVER DETECTED')

      // Tutorial runs are a guide, not a real game — never write the
      // resulting score/coins/XP to the player's profile.
      if (!this.isTutorial) {
        await this.saveBestScore()
        await this.saveCoins()
        await this.saveXp()
        await this.saveJackpotTokens()
        await this.sendLeaderboard()
      }
    }

    // Throttle the broadcast to ~30Hz on mobile (skip every other tick) —
    // see the constructor comment. Always send on game-over so the final
    // state (score, death cause, etc.) is never delayed by up to a frame.
    this._tickCount++
    const isMobile = Boolean(this.game?.difficulty?.isMobile)
    if (!isMobile || justEnded || this._tickCount % 2 === 0) {
      this.sendState()
    }

  } catch (error) {
    console.error('TICK ERROR:', error)

    // Freeze fix (belt-and-suspenders alongside the isolated try/catches
    // inside GameLogic.update() — see that method's comments): if
    // something upstream of sendState() still throws despite those, the
    // old behavior was to skip sendState() for this tick entirely. Since
    // setInterval keeps calling tick() every ~16ms and a corrupted piece
    // of state tends to throw the SAME way on every subsequent tick too,
    // that meant sendState() could stop firing forever — the client sits
    // on its last received frame indefinitely, which reads as "the game
    // froze." Best-effort: still try to push out whatever state we can
    // construct right now, so the client keeps receiving frames (and the
    // player keeps controlling their spoon) even on a tick where game
    // logic itself failed. If even this throws (state genuinely
    // unbuildable), swallow it — we already logged the real error above,
    // and there's nothing safer left to do than wait for the next tick.
    try { this.sendState() } catch (sendError) {
      console.error('TICK ERROR — fallback sendState() also failed:', sendError)
    }
  }
}

/**
 * Award a real, on-chain NFT to the player from whichever NFT Collections
 * an admin has opted into jackpot rewards (see game/jackpotNftReward.js —
 * the exact same pool/logic the purchasable Jackpot Orb's nft category
 * draws from; this natural in-game pickup is just a second entry point
 * into it). This only RESERVES the NFT — it does not send it, since that
 * needs a destination wallet the player may not have connected mid-run.
 * A JackpotTransaction row is created ('natural_nft', claimStatus
 * 'unclaimed') so the player can claim it later from the same Jackpot
 * history/claim UI a purchased orb's NFT win uses.
 */
async _handleJackpotNftReward() {
  try {
    const awarded = await drawJackpotNftReward(this.user.id)
    if (!awarded) {
      // Nothing currently eligible/in-stock/unowned — nothing to award.
      this.send('jackpot_nft_reward', { alreadyOwnsAll: true })
      return
    }

    const transaction = await JackpotTransaction.create({
      userId: this.user.id,
      type: 'natural_nft',
      rewardType: 'nft',
      rewardDetail: awarded,
      claimStatus: 'unclaimed',
    })

    // Notify the client — includes the transactionId so the client can
    // offer an immediate "claim" action, same as a purchased orb's win.
    this.send('jackpot_nft_reward', {
      nft: {
        mintAddress: awarded.mintAddress,
        collectionMintAddress: awarded.collectionMintAddress,
        name: awarded.name,
        image: awarded.image,
      },
      transactionId: String(transaction._id),
      claimStatus: transaction.claimStatus,
    })
  } catch (err) {
    console.error('JACKPOT NFT REWARD ERROR:', err)
  }
}
async saveBestScore(score) {
  // Falls back to this.game.score only for the legacy tick()-driven
  // tutorial save path (see tick()'s justEnded block) — every real call
  // site (_settleRound) always passes this round's own captured score
  // explicitly, never reading the live/mutable this.game.score.
  const currentScore = score ?? this.game.score

  // Atomic conditional update — MongoDB's $max only ever RAISES the stored
  // bestScore, and does it as a single atomic document write. This
  // replaces the previous "read the existing doc, compare in JS, then
  // write" pattern, which had a race window: two concurrent saves (two
  // browser tabs, a retried run report, two runs finishing back-to-back)
  // could both read the same stale bestScore and the LOWER of the two
  // writes could still land last, since nothing during that gap actually
  // prevented it. $max can never do that — whichever write arrives, the
  // stored value only ever ends up as the true max of everything applied.
  const updated = await Score.findOneAndUpdate(
    { userId: this.user.id },
    {
      $max: { bestScore: currentScore },
      $setOnInsert: { userId: this.user.id, username: this.user.username },
    },
    { upsert: true, new: true }
  )

  this.game.bestScore = updated?.bestScore ?? currentScore

  // Seasonal Leaderboard — a completely separate, season-scoped record
  // (see models/SeasonScore.js) from the all-time personal best above.
  // Only written if a season is currently active; if none is, the run
  // simply doesn't count toward any leaderboard (nothing to opt into).
  await this._saveSeasonScore(currentScore)

  return updated?.bestScore ?? currentScore
}

/**
 * Upserts this run's score into the active season's leaderboard using the
 * same atomic conditional-update pattern as saveBestScore() above ($max
 * can only raise bestScore, never race a higher concurrent save into
 * losing). Also accumulates totalGames/totalScore for EVERY credited run
 * this season — not just ones that beat the player's season best — so
 * sendLeaderboard() can report a real totalGames/avgScore instead of a
 * hard-coded totalGames:1. No-op if no season is currently active.
 */
async _saveSeasonScore(currentScore) {
  try {
    const season = await getActiveSeason()
    if (!season) return

    await SeasonScore.findOneAndUpdate(
      { seasonId: season._id, userId: this.user.id },
      {
        $max: { bestScore: currentScore },
        $inc: { totalGames: 1, totalScore: currentScore },
        $setOnInsert: { seasonId: season._id, userId: this.user.id, username: this.user.username },
      },
      { upsert: true, new: true }
    )
  } catch (error) {
    console.error('SEASON SCORE SAVE ERROR:', error)
  }
}
async saveCoins() {
  // ARENA STAGE HOOK: lavaCoinMultiplier scales the Lava Coins credited for
  // this run. Stage 1 is baseline (1.0x); Stages 2-8 use the admin-
  // configured reward multiplier (see ArenaStageConfig.js / refresh() and
  // _handleArenaStageSelect() above, which fetch the live multiplier and
  // apply it via setArenaStage()'s economyOverrides).
  //
  // Use the multiplier SNAPSHOTTED at this run's own game:restart
  // (this._activeRun.lavaCoinMultiplier), not the live this.game.stageConfig
  // value -- same reasoning as the run-report settlement path further up
  // this file (see its "SNAPSHOTTED at this run's own game:restart"
  // comment): if the player switches arena stage while a run is still in
  // progress, the live value would silently apply the NEW stage's
  // multiplier to coins earned under the OLD stage. Falling back to the
  // live value only if there's no active-run snapshot for some reason
  // (defensive -- should not normally happen for a real, non-tutorial run).
  const stageLavaCoinMult = this._activeRun?.lavaCoinMultiplier ?? this.game.stageConfig?.lavaCoinMultiplier ?? 1
  const coinsEarned = Math.round(this.game.coins * stageLavaCoinMult)

  if (coinsEarned <= 0) return 0

  await User.findByIdAndUpdate(
    this.user.id,
    {
      $inc: {
        coins: coinsEarned,
      },
    }
  )

  // Keep this session's in-memory wallet total (this.game.totalCoins, sent
  // on every game:state via hud.totalCoins — see GameLogic.getGameState())
  // in lockstep with what was actually just persisted to the DB above.
  // Without this, the live wallet widget (Landing/Marketplace/Profile/HUD)
  // stays frozen at whatever it showed at connect time until the next
  // reconnect forces a fresh refresh() — a run's coins would be credited
  // correctly in the DB but not visibly reflected until later, which reads
  // as "the coins didn't add up right."
  this.game.setTotalCoins(this.game.totalCoins + coinsEarned)

  return coinsEarned
}

/**
 * Jackpot Tokens (additive) — permanently adds this run's
 * jackpotTokensCollected (see GameLogic's 'jackpot' orb-collision case,
 * +1 per natural Jackpot Orb collected) to User.jackpotTokens. Called from
 * the same `justEnded && !this.isTutorial` block as saveCoins()/saveXp(),
 * so it's guarded by the same double-fire protection. Completely separate
 * from `jackpotOrbs` (the purchasable-with-LSVP inventory, see
 * routes/jackpot.js) — this is the currency spent on the Jackpot Slot
 * Machine (see routes/slotMachine.js).
 */
async saveJackpotTokens() {
  const tokensEarned = Math.max(0, Math.round(this.game.jackpotTokensCollected || 0))

  if (tokensEarned <= 0) {
    const user = await User.findById(this.user.id).select('jackpotTokens')
    this.send('jackpot_tokens:awarded', { tokensEarned: 0, jackpotTokens: user?.jackpotTokens ?? 0 })
    return
  }

  const updatedUser = await User.findByIdAndUpdate(
    this.user.id,
    { $inc: { jackpotTokens: tokensEarned } },
    { new: true }
  ).select('jackpotTokens')

  const jackpotTokens = updatedUser?.jackpotTokens ?? tokensEarned
  this.send('jackpot_tokens:awarded', { tokensEarned, jackpotTokens })
}

/**
 * Persistent XP System (additive) — permanently adds this game's XP
 * (currently defined as its final score — see xpLeveling.js's doc comment
 * for why Account Level is derived, not stored) to User.totalXp. Called
 * from the same `justEnded && !this.isTutorial` block as saveBestScore()/
 * saveCoins(), which already guards against double-firing for one game
 * over (wasGameOver is flipped synchronously, before any awaits, the
 * instant game-over is first detected — see tick() above) — so a
 * duplicate/overlapping tick or a resent game:state can never award XP
 * twice for the same run. Never touches score/coins/rewards/NFTs.
 *
 * A zero-score run still earns 0 XP (no-op, matches saveCoins()'s
 * `coinsEarned <= 0` early-out) rather than writing a no-op DB update.
 */
async saveXp() {
  const xpEarned = Math.max(0, Math.round(this.game.score || 0))

  // Always tell the client the outcome (even 0) so the Game End screen's
  // "XP Earned This Game" / "Total XP" fields update immediately either way.
  if (xpEarned <= 0) {
    const user = await User.findById(this.user.id).select('totalXp')
    this.send('xp:awarded', { xpEarned: 0, totalXp: user?.totalXp ?? 0 })
    return
  }

  const updatedUser = await User.findByIdAndUpdate(
    this.user.id,
    {
      $inc: { totalXp: xpEarned },
      $set: { lastXpUpdate: new Date() },
    },
    { new: true }
  ).select('totalXp')

  const totalXp = updatedUser?.totalXp ?? xpEarned
  this.send('xp:awarded', { xpEarned, totalXp })

  // Fire-and-forget analytics/history log — never blocks or fails the
  // actual XP credit above (that already happened and was sent to the
  // client by the time this runs).
  XpHistory.create({
    userId: this.user.id,
    xpEarned,
    totalXpAfter: totalXp,
    score: this.game.score,
  }).catch((err) => console.error('XP HISTORY LOG FAILED:', err))
}
  /**
   * Seasonal Leaderboard — replaces the old permanent/all-time leaderboard.
   * Sends the top 10 of the currently ACTIVE season only; if no season is
   * active, sends an empty list plus `season: null` (and `upcoming`, if a
   * future season is already scheduled) so the client can show
   * "No active season. Please check back when the next season begins."
   * `yourBest` stays the player's all-time personal best (unrelated to
   * seasons) — same field the HUD/profile has always used.
   */
  async sendLeaderboard() {
    const season = await getActiveSeason()

    if (!season) {
      const upcoming = await Season.findOne({ status: 'upcoming' }).sort({ startDate: 1 })
      this.send('leaderboard:data', {
        season: null,
        upcoming: upcoming
          ? { id: String(upcoming._id), name: upcoming.name || '', startDate: upcoming.startDate, endDate: upcoming.endDate }
          : null,
        entries: [],
        yourBest: this.game.bestScore,
      })
      return
    }

    const topPlayers = await SeasonScore.find({ seasonId: season._id })
      .sort({ bestScore: -1 })
      .limit(10)

    // Coins live on User, not SeasonScore — look them up so the leaderboard
    // reflects each player's real DB wallet instead of leaving totalCoins
    // undefined (which the frontend was silently rendering as 0 / hiding).
    // Safe to always read live here since this path only ever runs for the
    // still-active season — an ended season's frozen standings are served
    // separately via GET /api/seasons/:id/leaderboard.
    const userIds = topPlayers.map((player) => player.userId)
    const users = await User.find({ _id: { $in: userIds } }).select('coins')
    const coinsByUserId = new Map(
      users.map((u) => [String(u._id), u.coins || 0])
    )

    const entries = topPlayers.map((player, index) => {
      // totalGames/totalScore are accumulated on every credited run this
      // season (see _saveSeasonScore's $inc above), not just ones that beat
      // the player's season best. Older rows saved before this field
      // existed read back as 0 — treat those as "at least the one run that
      // produced this bestScore" rather than dividing by zero / showing 0
      // games for a player who clearly has a score on the board.
      const totalGames = player.totalGames > 0 ? player.totalGames : (player.bestScore > 0 ? 1 : 0)
      const totalScore = Number.isFinite(player.totalScore) && player.totalScore > 0 ? player.totalScore : player.bestScore

      return {
        rank: index + 1,
        userId: player.userId,
        username: player.username,
        bestScore: player.bestScore,
        totalGames,
        avgScore: totalGames > 0 ? Math.round(totalScore / totalGames) : 0,
        totalCoins: coinsByUserId.get(String(player.userId)) ?? 0,
      }
    })

    this.send('leaderboard:data', {
      season: {
        id: String(season._id),
        name: season.name || '',
        startDate: season.startDate,
        endDate: season.endDate,
        status: season.status,
      },
      upcoming: null,
      entries,
      yourBest: this.game.bestScore,
    })
  }

  sendState() {
    this.sendEnvelope(createGameStateMessage(this.game))
  }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return

    this.ws.send(
      JSON.stringify({
        type,
        payload,
      })
    )
  }

  sendEnvelope(message) {
    if (!this.ws || this.ws.readyState !== 1) return
    this.ws.send(JSON.stringify(message))
  }

  close() {
    if (this.timer) {
      clearInterval(this.timer)
    }

    // Energy "failed start" refund — see _refundEnergyIfEarly. Only fires
    // for a genuine disconnect: server.js only calls close() when this
    // session's currently-attached socket is the one going away with
    // nothing else already attached (never on a reconnect, which hands the
    // session off to a new socket first — see server.js's ws.on('close')
    // handlers). If a round's token was issued moments ago and never used,
    // the socket dropping right now means the player never got a chance to
    // play it.
    this._refundEnergyIfEarly(this._activeRun, 'socket_closed')

    this.timer = null
    this.ws = null
  }
}

export default ClientSession

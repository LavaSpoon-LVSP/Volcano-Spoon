/**
 * GAME LOGIC — Volcano Spoon
 *
 * Central game loop integrating all systems:
 *   ArcadePhysicsEngine | OrbSystem | ComboSystem |
 *   DifficultySystem | PowerupSystem | ArenaSystem | BounceEffects
 *
 * Architecture note:
 *   This class runs SERVER-SIDE (or in local-play mode).
 *   It produces game:state payloads consumed by GameEngine (renderer).
 *   Jackpot / Mythic rewards are flagged via drainServerEvents() —
 *   the caller sends them to the backend for authoritative reward calc.
 */

import { ArcadePhysicsEngine } from './ArcadePhysicsEngine.js'
import BounceEffects from './BounceEffects.js'
import OrbSystem from './OrbSystem.js'
import ComboSystem from './ComboSystem.js'
import DifficultySystem from './DifficultySystem.js'
import PowerupSystem from './PowerupSystem.js'
import ArenaSystem from './ArenaSystem.js'
import LevelSystem from './LevelSystem.js'
import {
  MAX_HEALTH, CEILING_DAMAGE,
  LAVA_ORB_BASE_SCORE, GRAVITY,
  COIN_PER_LAVA_ORB,
  LAVA_STICK_DAMAGE,
  TURBO_ORB_COIN_MIN, TURBO_ORB_COIN_MAX,
  CHAOS_ORB_COIN_MIN, CHAOS_ORB_COIN_MAX,
  FIRE_WALL_COIN_PENALTY_MIN, FIRE_WALL_COIN_PENALTY_MAX,
  BAD_ROCK_COIN_PENALTY_MIN, BAD_ROCK_COIN_PENALTY_MAX,
  JACKPOT_COIN_MIN, JACKPOT_COIN_MAX,
  JACKPOT_COMBO_BOOST,
  DIAMOND_BASE_POINTS,
  HEALTH_ORB_HEAL,
  // World Event System
  LAVA_RAIN_DROP_RADIUS, LAVA_RAIN_DROP_DAMAGE,
  LAVA_WALL_DAMAGE, LAVA_WALL_DAMAGE_COOLDOWN,
  // Wall Spikes / Ninja Knives (ported from backend)
  WALL_SPIKES_DAMAGE, WALL_SPIKES_DAMAGE_COOLDOWN_MS, NINJA_KNIFE_DAMAGE,
  ZONE_LEFT, ZONE_RIGHT,
  // Game Feel
  FREEZE_JACKPOT_MS, FREEZE_COMBO_MS, FREEZE_BOSS_MS, FREEZE_NEAR_DEATH_MS, FREEZE_LAVA_COIN_MS,
  ZOOM_TURBO, ZOOM_JACKPOT, ZOOM_BOSS, ZOOM_COMBO, ZOOM_EVENT,
  SHAKE_SMALL, SHAKE_MEDIUM, SHAKE_LARGE,
  FLASH_JACKPOT, FLASH_BOSS, FLASH_DAMAGE, FLASH_COIN, FLASH_TURBO,
  ORB_SKIN_DISPLAY_MS,
  // NFT Artifact Perks (see constants.js's "NFT ARTIFACT PERKS" section)
  ARTIFACT_HEAL_PER_MINUTE, ARTIFACT_PICKUP_RADIUS_BONUS,
  ARTIFACT_COMBO_DURATION_MULTIPLIER, ARTIFACT_COMBO_STABILIZE_RETENTION,
  COMBO_TIMEOUT_MS,
  // Orb roster completion (Combo / Rose / Black / Sun Flame / Electric Shock)
  COMBO_ORB_BOOST, ROSE_ORB_HEAL, BLACK_ORB_SCORE_PENALTY, BLACK_ORB_DISTORT_MS,
  SUN_FLAME_ORB_BONUS, ELECTRIC_COLLECT_RADIUS, ELECTRIC_SHOCK_MS,
} from './constants.js'
import { getStageProfile } from './arenaStages.js'
import { random } from './seededRandom.js'
import { now as simTime } from './simClock.js'

// Coin-payout rolls (turbo/jackpot/bad-rock/fire-wall/chaos orb values) run
// through the seeded RNG (random(), not Math.random()) so a run's payouts
// are exactly reproducible from its seed during server-side replay
// validation — see seededRandom.js.
const randInt = (min, max) => Math.floor(random() * (max - min + 1)) + min

export class GameLogic {
  constructor() {
    this.physics    = new ArcadePhysicsEngine()
    this.effects    = new BounceEffects()
    this.orbs       = new OrbSystem()
    this.combo      = new ComboSystem()
    this.difficulty = new DifficultySystem()
    this.powerups   = new PowerupSystem()
    this.arena      = new ArenaSystem()
    this.levels     = new LevelSystem()

    this.score          = 0
    this.bestScore      = 0
    this.coins          = 0  // run-local coin tally (optimistic, reconciled by server state)
    // Jackpot Tokens — 1 per natural Jackpot Orb collected, separate
    // currency from Lava Coins (see the live backend's
    // ClientSession.saveJackpotTokens / GameLogic._handleOrbCollected).
    this.jackpotTokensCollected = 0
    // In-match Level (LevelSystem.js — score-gated orb-roster/pacing
    // tiers, distinct from Arena Stage) the player has most recently been
    // shown a "LEVEL UP" notice for — see the this.levels.update() call in
    // update() below. Starts at 1 (Level 1 is never itself announced, only
    // the step up to Level 2+) and is NOT reset by reset(), matching every
    // other announcement lifetime is a single run.
    this._lastLevelSeen = 1
    this.health         = MAX_HEALTH
    this.gameOver       = false
    this.paused         = false
    this.sessionStartMs = simTime()
    this.obstacle       = null
    this.floatTexts     = []
    this._serverEventQueue = []
    // null (not 'default') so _resolvePlayerSkin can tell "no orb collected
    // yet this run" apart from an actual collected orb — see equippedSkin.
    // This is a time-limited cosmetic "pickup flash" (see
    // ORB_SKIN_DISPLAY_MS / _lastCollectedOrbUntil below), not a permanent
    // skin change — it reverts to the player's equipped skin once expired.
    this.lastCollectedOrb  = null
    this._lastCollectedOrbUntil = 0
    // The player's chosen cosmetic skin (set via setEquippedSkin below),
    // shown before any orb is collected and whenever no powerup/orb skin
    // is currently active. Persists across reset() like arenaStage does.
    this.equippedSkin = null

    // World Event System state
    this._lavaWallDamageCooldowns = new Map()
    this._windExpireAt            = 0

    // Game Feel signals
    this._gameFeel           = null
    this._lastComboMilestone = 0
    this._wasNearDeath       = false
    this._turboWasActive     = false
    this._eruptionModeUntil   = 0

    // Volcanic eruption visual trigger — incremented every time a real
    // "VOLCANIC ERUPTION!" boss event fires, so the client can detect the
    // transition (even across repeats) and play the burst GIF + effects.
    this._eruptionEventId    = 0

    // Bounce/collision audio trigger — same rising-edge pattern as
    // _eruptionEventId above. Bumped on every wall or ceiling collision
    // (see _handlePhysicsCollision) so Game.jsx's real-run loop can play the
    // hit sound off the single authoritative source of truth instead of
    // relying on the separate client-prediction physics happening to notice
    // the same bounce (it doesn't always — CEILING_DAMAGE is 0, so the old
    // "play hit sound on health loss" trigger never fired for ceiling/wall
    // bounces at all).
    this._bounceEventId      = 0
    this._lastBounceType     = null

    // Player's persistent Arena Stage (see setArenaStage below) — forwarded
    // to OrbSystem so jackpot/mythic/support orbs gate additively on top of
    // the Level-based unlock, matching the backend. this._stageProfile is
    // the full per-stage hazard/pace config (see arenaStages.js) — which
    // hazards this arena may run, how often, and how fast everything moves.
    this.arenaStage = 1
    this._stageProfile = getStageProfile(1)

    // ── Backend session-bookkeeping state ──────────────────────────────
    // The items below are NOT part of the deterministic gameplay
    // simulation (they don't affect score/coins/replay outcome) — they're
    // state ClientSession.js needs this class to hold so the WebSocket
    // session layer has somewhere to read/write it. Restored here after a
    // 2026-09 refactor briefly dropped them when this file was replaced
    // wholesale with the client's copy, which broke every WebSocket
    // connection (ClientSession.refresh() calling the then-missing
    // setTotalCoins() during 'auth:ok').

    // Player's lifetime Lava Coin wallet balance, seeded from the DB by
    // ClientSession.refresh()/setTotalCoins() on connect/reconnect. Distinct
    // from this.coins above, which is only this run's optimistic tally.
    this.totalCoins = 0

    // Coarse-pointer/mobile flag reported by the client on 'game:start' /
    // 'game:restart' (see setPlatform below). NOTE: the difficulty curve
    // this used to feed (a slower mobile ramp-up) does not exist in this
    // version of DifficultySystem — the flag is stored for visibility but
    // currently has no gameplay effect. Flagged as a known gap, not
    // silently pretended to work.
    this.isMobile = false

    // NFT-artifact perk flags — see setArtifactPerks below. Derived
    // server-side from real DB ownership+active-selection (see
    // game/artifactPerks.js), NEVER trusted from the client. Same lifetime
    // as equippedSkin/arenaStage: set once per run by the caller (around
    // reset(), not reset by it), read every frame by update() (heal regen,
    // combo duration, pickup radius) and by the hazard-damage sites
    // (combo stabilize) — see constants.js's "NFT ARTIFACT PERKS" section
    // for the actual numbers.
    this.artifactPerks = {
      healRegen:          false,
      pickupRadiusBonus:  false,
      comboDurationBonus: false,
      hazardVisibility:   false,
      comboStabilize:     false,
    }

    // Real-session "How to Play" tutorial forced-orb/forced-hazard state
    // (see setTutorialForceOrb/setTutorialHazard below). NOTE: the guided
    // teaching behaviour that used to read these (forcing a specific orb
    // or hazard to appear and pausing until the player deals with it) is
    // not implemented in this version of OrbSystem/ArenaSystem — these are
    // currently safe stubs so tutorial-related messages don't crash the
    // session, not a working tutorial. Known gap, not silently pretended
    // to work.
    this.tutorialForceOrb = null
    this.tutorialHazard   = null
  }

  /**
   * Call when the player's Arena Stage is known/changes (game start, or
   * stage selection) — forwards to OrbSystem's stage-gated orb unlocks,
   * ArenaSystem's stage-gated hazard rotation, and this arena's base pace/
   * launch-impulse feel. Safe to call with an unchanged value; safe to omit
   * (defaults to Stage 1: slowest pace, no earthquake/darkness).
   */
  setArenaStage(stage) {
    this.arenaStage = Number.isFinite(Number(stage)) ? Number(stage) : this.arenaStage
    this._stageProfile = getStageProfile(this.arenaStage)
    this.orbs.setArenaStage(this.arenaStage)
    this.arena.setStageProfile(this.arenaStage)
  }

  /**
   * Sets the player's equipped cosmetic skin (chosen outside the arena).
   * Shown before any orb is collected, and again once no powerup/orb skin
   * is active — see _resolvePlayerSkin.
   */
  setEquippedSkin(skin) {
    this.equippedSkin = skin || null
  }

  /** Seed the lifetime coin wallet from the DB (call on session/connection
   *  start — see ClientSession.refresh()). */
  setTotalCoins(n) {
    this.totalCoins = Number.isFinite(n) ? n : 0
  }

  /** Record whether this session is on a coarse-pointer/mobile device (see
   *  the constructor comment above — currently stored only, no gameplay
   *  effect in this engine version). */
  setPlatform(isMobile) {
    this.isMobile = Boolean(isMobile)
  }

  /**
   * Apply this run's NFT-artifact perk flags — see the constructor comment
   * above. Callers (ClientSession._applyArtifactPerks / ReplayEngine's
   * replayRun) already derived `perks` from real server-side ownership, so
   * this method itself does no trust decisions, only shape validation.
   */
  setArtifactPerks(perks = {}) {
    this.artifactPerks = {
      healRegen:          Boolean(perks.healRegen),
      pickupRadiusBonus:  Boolean(perks.pickupRadiusBonus),
      comboDurationBonus: Boolean(perks.comboDurationBonus),
      hazardVisibility:   Boolean(perks.hazardVisibility),
      comboStabilize:     Boolean(perks.comboStabilize),
    }
    // hazardVisibility has no numeric constant of its own (see
    // constants.js) — it just tells OrbSystem to skip Darkness Mode's
    // orb-hiding for this run.
    this.orbs.setHazardVisibility(this.artifactPerks.hazardVisibility)
  }

  /** Arm the "How to Play" tutorial's forced-orb round (see the
   *  constructor comment above — currently a safe stub, not a working
   *  guided round in this engine version). */
  setTutorialForceOrb(type) {
    this.tutorialForceOrb = type || null
  }

  /** Arm the "How to Play" tutorial's forced-hazard round (see the
   *  constructor comment above — currently a safe stub, not a working
   *  guided round in this engine version). */
  setTutorialHazard(type) {
    this.tutorialHazard = type || null
  }

  // ── Main update (call every frame) ─────────────────────────────────────────
  // `dt` is elapsed real time normalized to 1/60s "ticks" (1 == one frame at
  // 60Hz) — this class used to only ever run driven by the server's fixed
  // 60Hz setInterval, so physics.update() always got exactly one implicit
  // tick per call. Now that a real run drives this itself via
  // requestAnimationFrame (see Game.jsx's local simulation loop), which
  // fires at the DISPLAY's refresh rate (90Hz/120Hz on plenty of phones),
  // that assumption would make gravity/movement run visibly faster on a
  // faster screen — dt lets the caller normalize for that, same
  // frame-rate-independence the existing TutorialPhysicsEngine prediction
  // loop already does. Defaults to 1 so any other/older caller (there are
  // none left, but just in case) keeps its exact previous behavior.
  update(dt = 1) {
    if (this.gameOver || this.paused) return this.getGameState()

    const now  = simTime()

    // 1. Difficulty overrides
    this.difficulty.update(now, this.combo.getState())
    const diff = this.difficulty.getOverrides()
    this.levels.update(this.score)
    const currentLevel = this.levels.getCurrentLevel()
    if (currentLevel.level > this._lastLevelSeen) {
      this._lastLevelSeen = currentLevel.level
      this._spawnFloatText(`LEVEL ${currentLevel.level} UNLOCKED!`, this.physics.x, this.physics.y - 70, '#ffcc44')
      this.effects.createImpactGlow(this.physics.x, this.physics.y, 'ceiling_bounce', 2.2)
      this.effects.createTrailParticles(this.physics.x, this.physics.y, 'ceiling_bounce', 10)
    }
    const levelProfile = this.levels.getSpawnProfile({
      hazardWeightBoost: diff.hazardWeightBoost,
      struggling: diff.struggling,
    })
    this.orbs.setSpawnProfile(levelProfile)
    this.orbs.setMaxActiveOrbs(levelProfile.maxActiveOrbs)
    this.orbs.spawnIntervalMs = Math.max(300, diff.spawnIntervalMs * levelProfile.spawnIntervalMultiplier)

    // Pacing — the Arena Stage's base pace (see arenaStages.js) is now the
    // PRIMARY speed signal: Stage 1 is a genuinely slow 0.45x, Stage 8 tops
    // out at 1.50x. This replaced an earlier version that drove both orb
    // speed and the spoon's own launch force off DifficultySystem's within-
    // run ramp directly — that ramp alone could climb well past 2x over a
    // single long run (it was designed to keep compounding with score/
    // level), which read as "the game gradually gets too fast" even though
    // nothing about the arena itself had changed. The within-run ramp still
    // adds SOME acceleration as you survive longer (rewards a good run),
    // but tightened further (0.95x-1.15x, was 0.90x-1.25x) — that wider
    // range could close most of the gap between adjacent stages by the end
    // of a run, which is what made every arena read as "the same
    // difficulty". Narrowing it lets the stage's own pace dominate.
    const withinRunRamp = 0.95 + Math.min(1, (diff.stage ?? 0) / 8) * 0.20
    const paceMultiplier = this._stageProfile.pace * withinRunRamp
    // Orb speed / hazard pace scales with Arena Stage — that's the actual
    // "difficulty" axis. The player's own swipe/launch response does NOT:
    // it used to be multiplied by this same paceMultiplier (and by each
    // stage's own launchImpulseMultiplier), so the exact same drag/swipe
    // produced a shorter launch on Stage 1 than on Stage 8 — "the swipe
    // differs per arena". A swipe should always translate to the same
    // launch distance no matter which arena is active, so both are now
    // pinned to a flat 1 regardless of stage.
    this.orbs.setSpeedMultiplier(paceMultiplier)
    this.physics.difficultySpeedMultiplier = 1
    this.physics.upwardImpulseMultiplier = 1

    // 2. Powerups
    this.powerups.update(now)
    const mods = this.powerups.getModifiers()

    // 3. Physics — gravity override hook (non-invasive: reads gravityOverride if set)
    const gravityMultiplier = diff.gravityMultiplier * levelProfile.gravityMultiplier * mods.gravityFactor
    this.physics.gravityOverride = gravityMultiplier !== 1.0 ? GRAVITY * gravityMultiplier : null
    const collision = this.physics.update(dt)

    // 4. Visual effects
    this.effects.updateMotionTrail(this.physics.x, this.physics.y, this.physics.getVelocityMagnitude())
    this.effects.update()

    // 5. Physics collision handling
    if (collision) {
      const dead = this._handlePhysicsCollision(collision, mods)
      if (dead) return this.getGameState()
    }

    // 6. Orbs
    const orbUpdate = this.orbs.update(now, { x: this.physics.x, y: this.physics.y, radius: this.physics.radius }, mods.magnetActive)
    this.orbs.trySpawn(now)

    this.orbs.setDarknessMode(this.arena.darknessAlpha > 0)

    // Tribal Spirit Artifact perk (healRegen) — slow passive HP regen,
    // ARTIFACT_HEAL_PER_MINUTE per minute, fractional progress carried
    // across frames so it isn't lost to rounding at low frame rates.
    // Deterministic: driven by `now` (the shared virtual/real clock every
    // other time-based system here already uses), never wall-clock time
    // directly, so a replay reproduces the exact same regen ticks.
    if (this.artifactPerks.healRegen && this.health > 0 && this.health < MAX_HEALTH && this._lastHealRegenAt != null) {
      const elapsedMs = now - this._lastHealRegenAt
      if (elapsedMs > 0) {
        const healAccrued = (elapsedMs / 60000) * ARTIFACT_HEAL_PER_MINUTE + this._healRegenCarry
        const wholeHeal = Math.floor(healAccrued)
        this._healRegenCarry = healAccrued - wholeHeal
        if (wholeHeal > 0) this.health = Math.min(MAX_HEALTH, this.health + wholeHeal)
      }
    }
    this._lastHealRegenAt = now

    if (this._eruptionModeUntil > 0 && now >= this._eruptionModeUntil) {
      this._eruptionModeUntil = 0
      this.orbs.setEruptionMode(false)
    }

    // 7. Orb collection
    // Ancient Dragon Artifact perk (pickupRadiusBonus) — a few extra px of
    // orb pickup radius (see constants.js's ARTIFACT_PICKUP_RADIUS_BONUS).
    const effectivePickupRadius = this.physics.radius + (this.artifactPerks.pickupRadiusBonus ? ARTIFACT_PICKUP_RADIUS_BONUS : 0)
    const collisionResult = this.orbs.checkPlayerCollisions(this.physics.x, this.physics.y, effectivePickupRadius, {
      now,
      darknessActive: this.arena.darknessAlpha > 0,
    })
    collisionResult.revealed.forEach((orb) => {
      this._spawnFloatText('REVEALED!', orb.x, orb.y - 20, '#88ffcc')
    })
    collisionResult.collected.forEach(orb => this._handleOrbCollected(orb, now, mods))
    // Don't show "MISSED <TYPE>!" for a type that was just collected this
    // exact frame — OrbSystem.update() already gives the SAME orb a same-
    // frame grace so it can't both expire and get collected, but with many
    // same-type orbs on screen at once (lava at Level 1, say) a DIFFERENT
    // orb of that type can legitimately time out in the same frame one was
    // collected — visually reading as "I collected it and it still says
    // missed" even though they're two different orbs.
    const collectedTypesThisFrame = new Set(collisionResult.collected.map((orb) => orb.type))
    orbUpdate.expired.forEach((orb) => {
      if (collectedTypesThisFrame.has(orb.type)) return
      this._handleOrbMissed(orb, now)
    })

    // 8. Combo timeout — Maya Sun Artifact perk (comboDurationBonus) widens
    // the timeout window slightly (see constants.js's ARTIFACT_COMBO_DURATION_MULTIPLIER).
    const comboTimeoutMs = this.artifactPerks.comboDurationBonus
      ? COMBO_TIMEOUT_MS * ARTIFACT_COMBO_DURATION_MULTIPLIER
      : COMBO_TIMEOUT_MS
    if (this.combo.update(now, comboTimeoutMs)) {
      this._spawnFloatText('COMBO BREAK!', this.physics.x, this.physics.y - 40, '#ff6644')
    }

    // 9. Arena events
    const arenaEvents = this.arena.update(now)
    arenaEvents.forEach(evt => this._handleArenaEvent(evt))

    // 9.5 World Event System — lava wall collision & wind expiry
    this._checkLavaWallCollisions()
    // Wrapped in try/catch matching the backend's own fix for "game hangs
    // as soon as spikes come" — a hazard-collision throw here must never
    // take the whole frame loop down with it.
    try { this._checkWallSpikeCollisions(now) } catch (e) { console.error('_checkWallSpikeCollisions failed:', e) }
    try { this._checkNinjaKnifeCollisions(now) } catch (e) { console.error('_checkNinjaKnifeCollisions failed:', e) }
    if (this._windExpireAt && now >= this._windExpireAt) {
      this.physics.windForceX = 0
      this._windExpireAt = 0
    }

    // 9.6 Game Feel signals
    this._gameFeel = null
    this._detectGameFeelEvents(mods)

    // 10. Float texts
    this._updateFloatTexts()

    return this.getGameState()
  }

  // 'launch' (drag-release/swipe vector, in game-space px) is the only
  // input this game actually sends any more — see Game.jsx's
  // performLaunch/fireGameStart, matching the live backend's own
  // GameLogic.handleInput contract. `payload` is forwarded straight to
  // physics.bufferInput({dx, dy}) (see ArcadePhysicsEngine.applyLaunchInput);
  // any other/legacy type just buffers a plain upward launch.
  handleInput(type = 'launch', payload = {}) {
    if (this.gameOver || this.paused) return
    this.physics.bufferInput(payload)
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  getGameState() {
    const now          = simTime()
    const physState    = this.physics.getState()
    const mods         = this.powerups.getModifiers()
    const arenaVisual  = this.arena.getVisualState()
    const comboState   = this.combo.getState()

    return {
      player: {
        ...physState,
        shielded: mods.shieldActive,
        tint: mods.turboActive ? { r: 0, g: 255, b: 200 } : null,
        skin: this._resolvePlayerSkin(mods, now),
      },
      collectibles: this.orbs.getOrbs(),
      obstacle:     this.obstacle,
      floatTexts:   this.floatTexts,
      bounceEffects: this.effects,
      screenShake:  physState.screenShake,
      arena:        arenaVisual,
      worldEvents: {
        lavaWalls:            arenaVisual.lavaWalls            ?? [],
        lavaRainDrops:        arenaVisual.lavaRainDrops        ?? [],
        windActive:           arenaVisual.windActive            ?? false,
        windForce:            arenaVisual.windForce             ?? 0,
        orbStormActive:       arenaVisual.orbStormActive        ?? false,
        bossPhaseIndex:       arenaVisual.bossPhaseIndex        ?? -1,
        // HUD timer fields
        earthquakeActive:     arenaVisual.earthquakeActive      ?? false,
        earthquakeRemainingMs:arenaVisual.earthquakeRemainingMs ?? 0,
        darknessAlpha:        arenaVisual.darknessAlpha         ?? 0,
        darknessRemainingMs:  arenaVisual.darknessRemainingMs   ?? 0,
        windRemainingMs:      arenaVisual.windRemainingMs        ?? 0,
        orbStormRemainingMs:  arenaVisual.orbStormRemainingMs    ?? 0,
        lavaWallsActive:      arenaVisual.lavaWallsActive        ?? false,
        lavaRainActive:       arenaVisual.lavaRainActive         ?? false,
        // Wall spikes / ninja knives — GameEngine's #drawWallSpikes /
        // #drawNinjaKnives already read these exact field names.
        wallSpikes:           arenaVisual.wallSpikes             ?? [],
        ninjaKnives:          arenaVisual.ninjaKnives            ?? [],
        wallSpikesActive:     arenaVisual.wallSpikesActive       ?? false,
        ninjaKnivesActive:    arenaVisual.ninjaKnivesActive      ?? false,
        // Bumps every time a "VOLCANIC ERUPTION!" boss event fires —
        // client watches this for the rising-edge transition.
        eruptionEventId:      this._eruptionEventId,
        // Real active/expiry flags for the two "big" boss phases — the
        // Game.jsx hazard badge used to key off the raw, never-reset
        // arena.bossPhaseIndex ratchet, so once a phase past index 0
        // triggered its pill never went away for the rest of the run.
        eruptionActive:            this._eruptionModeUntil > 0,
        eruptionRemainingMs:       this._eruptionModeUntil > 0 ? Math.max(0, this._eruptionModeUntil - now) : 0,
        survivalPhaseActive:       arenaVisual.survivalPhaseActive       ?? false,
        survivalPhaseRemainingMs: arenaVisual.survivalPhaseRemainingMs  ?? 0,
      },
      gameFeel: this._gameFeel ?? null,
      // Rising-edge counter for wall/ceiling bounce audio — see
      // _bounceEventId's own comment in the constructor. Client compares
      // this id against the last one it saw and plays the hit sound once
      // per genuine bounce, keyed off this._lastBounceType.
      bounceEventId:   this._bounceEventId,
      lastBounceType:  this._lastBounceType,
      hud: {
        score:      this.score,
        bestScore:  this.bestScore,
        // Run-local coin tally — this was never included here, so the
        // Game Over screen's "THIS RUN" coin count (GameOverlay.jsx already
        // has the UI for it) always showed 0/blank no matter how many lava
        // orbs were actually collected.
        coins:      this.coins,
        // Persistent Lava Coin wallet balance (see setTotalCoins) — the
        // Landing/Marketplace/Profile/HUD wallet widget reads this off
        // every game:state push (see Game.jsx's game:state handler), not
        // just the one-time auth:ok on connect. Restored after a 2026-09
        // refactor dropped it, which froze the wallet display at whatever
        // value it had at connect time until the next reconnect.
        totalCoins: this.totalCoins,
        // Surfaced so the Game Over screen can show this run's Jackpot
        // Token count (see frontend GameOverlay.jsx) — collecting a
        // Jackpot Orb is the only thing gameplay itself awards toward an
        // NFT chance; the actual chance only happens on a separate Slot
        // Machine spin (see ClientSession._handleJackpotNftReward's
        // comment for why the natural-NFT hook doesn't fire for real runs).
        jackpotTokensCollected: this.jackpotTokensCollected,
        health:     this.health,
        shielded:   mods.shieldActive,
        combo:      comboState,
        powerups:   this.powerups.getHudState(),
        gameOver:   this.gameOver,
        paused:     this.paused,
        difficulty: this.difficulty.getOverrides(),
        level:      this.levels.getState(this.score),
      },
    }
  }

  reset() {
    const survivalMs = simTime() - this.sessionStartMs
    this.difficulty.recordDeath(survivalMs)
    if (this.score > this.bestScore) this.bestScore = this.score

    this.physics.reset()
    this.effects.reset()
    this.orbs.reset()
    this.combo.reset()
    this.difficulty.reset()
    this.powerups.reset()
    this.arena.reset()
    this.levels.reset()

    this.score          = 0
    this.coins          = 0
    this.jackpotTokensCollected = 0
    this._lastLevelSeen = 1
    this.health         = MAX_HEALTH
    this.gameOver       = false
    this.obstacle       = null
    this.floatTexts     = []
    this._serverEventQueue = []
    this.lastCollectedOrb  = null
    this._lastCollectedOrbUntil = 0
    this.sessionStartMs = simTime()

    // World Event System reset
    this._lavaWallDamageCooldowns = new Map()
    this._windExpireAt = 0
    this._eruptionModeUntil = 0

    // Tribal Spirit Artifact perk (healRegen) bookkeeping — see update()'s
    // heal-regen tick. Reset per-run like every other run-local tally
    // above; this.artifactPerks itself is NOT reset here (see its own
    // constructor/setArtifactPerks comment — same lifetime as
    // equippedSkin/arenaStage, set once per run by the caller before/around
    // reset()).
    this._lastHealRegenAt = null
    this._healRegenCarry  = 0
  }

  _resolvePlayerSkin(mods, now) {
    // Active powerup skins take priority (they're time-limited visual states)
    if (mods.turboActive)   return 'turbo'
    if (mods.shieldActive)  return 'shield'
    if (mods.freezeActive)  return 'freeze'
    if (mods.gravityActive) return 'gravity'
    if (mods.magnetActive)  return 'magnet'
    // Otherwise briefly show the skin of the last orb collected — but only
    // for ORB_SKIN_DISPLAY_MS after the pickup (see _handleOrbCollected).
    // This used to never expire, which meant the very first orb of the run
    // permanently hid the player's equipped Spoon Skin for the rest of the
    // match. Once it expires (or before any orb's been collected yet),
    // fall back to the player's own equipped cosmetic skin — which is the
    // look that should "win" by default — then finally 'default'.
    if (this.lastCollectedOrb && now < this._lastCollectedOrbUntil) {
      return this.lastCollectedOrb
    }
    return this.equippedSkin ?? 'default'
  }

  /** Returns and clears server-bound events (jackpot, mythic, game_over) */
  drainServerEvents() {
    const evts = [...this._serverEventQueue]
    this._serverEventQueue = []
    return evts
  }

  // ── Private handlers ───────────────────────────────────────────────────────

  _handlePhysicsCollision(collision, mods) {
    if (collision.type === 'death') {
      // Touching the floor is always fatal — shields/invincibility do not apply.
      this.gameOver = true
      this._serverEventQueue.push({ type: 'game_over', score: this.score, combo: this.combo.getState() })
      return true
    }
    if (collision.type === 'wall_bounce') {
      this.effects.createImpactGlow(this.physics.x, this.physics.y, 'wall_bounce')
      this.effects.createTrailParticles(this.physics.x, this.physics.y, 'wall_bounce', 3)
      this._lastBounceType = 'wall_bounce'
      this._bounceEventId += 1
    }
    if (collision.type === 'ceiling_bounce') {
      const dmg = mods.invincible ? 0 : CEILING_DAMAGE
      this.health = Math.max(0, this.health - dmg)
      this.effects.createImpactGlow(this.physics.x, this.physics.y, 'ceiling_bounce', 1.5)
      this.effects.createTrailParticles(this.physics.x, this.physics.y, 'ceiling_bounce', 6)
      this.effects.createBounceIndicator(this.physics.x, this.physics.y - 40, '⚠ CEILING', 'ceiling_bounce')
      this._lastBounceType = 'ceiling_bounce'
      this._bounceEventId += 1
      if (this.health <= 0) { this.gameOver = true; return true }
    }
    return false
  }

  _handleOrbCollected(orb, now, mods) {
    const px = this.physics.x, py = this.physics.y
    // Update spoon skin — skip hazards (bad_rock, lava_stick) and fire_wall
    // since those punish the player; every other orb changes the skin
    const HAZARD_TYPES = new Set(['bad_rock', 'lava_stick', 'fire_wall'])
    if (!HAZARD_TYPES.has(orb.type)) {
      this.lastCollectedOrb = orb.type
      this._lastCollectedOrbUntil = now + ORB_SKIN_DISPLAY_MS
    }
    switch (orb.type) {
      case 'lava': {
        const res = mods.turboActive ? this.combo.onTurboLavaOrb(now) : this.combo.onLavaOrb(now)
        const pts = Math.floor(LAVA_ORB_BASE_SCORE * res.multiplier)
        this.score += pts
        // Base Lava Coin grant — this was missing entirely (only the rarer
        // turbo/jackpot/chaos orbs below ever added to this.coins), which
        // would have meant a real run never earned any Lava Coins for
        // ordinary orb collection. Matches the live backend's
        // `this.coins += COIN_PER_LAVA_ORB` on every lava orb pickup.
        this.coins += COIN_PER_LAVA_ORB
        if (res.tieredUp) {
          this._spawnFloatText(`x${res.multiplier} COMBO!`, px, py - 50, '#ffff77')
          this.effects.createImpactGlow(px, py, 'wall_bounce', 1.2)
        } else {
          this._spawnFloatText(`+${pts}`, px, py - 35, '#7fffa8')
        }
        break
      }
      case 'turbo': {
        this.powerups.activate('turbo', null, now)
        this._spawnFloatText('TURBO!', px, py - 50, '#00ffcc')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 2.0)
        // Additional: grant +15 to +30 Lava Coins (optimistic; server is authoritative)
        const turboCoin = randInt(TURBO_ORB_COIN_MIN, TURBO_ORB_COIN_MAX)
        this.coins += turboCoin
        this._spawnFloatText(`+${turboCoin}🪙`, px, py - 68, '#ffd700')
        break
      }
      case 'jackpot': {
        // Additional: massive Lava Coin reward + large combo boost
        const jackpotCoin = randInt(JACKPOT_COIN_MIN, JACKPOT_COIN_MAX)
        this.coins += jackpotCoin
        this.jackpotTokensCollected += 1
        // Large combo boost — simulate multiple lava orbs
        for (let i = 0; i < JACKPOT_COMBO_BOOST; i++) this.combo.onLavaOrb(now)
        this._serverEventQueue.push({ type: 'jackpot_collected', orbId: orb.id, timestamp: now, score: this.score, combo: this.combo.getState() })
        this._spawnFloatText('JACKPOT!', px, py - 55, '#ffd700')
        this._spawnFloatText(`+${jackpotCoin}🪙`, px, py - 80, '#ffd700')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 3.0)
        this.effects.createTrailParticles(px, py, 'ceiling_bounce', 12)
        this._emitFeel({ type: 'jackpot', freezeMs: FREEZE_JACKPOT_MS, zoom: ZOOM_JACKPOT, flash: FLASH_JACKPOT, shake: SHAKE_MEDIUM })
        break
      }
      case 'diamond': {
        this.score += DIAMOND_BASE_POINTS
        this._spawnFloatText(`+${DIAMOND_BASE_POINTS} DIAMOND!`, px, py - 55, '#aaddff')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 2.5)
        this.effects.createTrailParticles(px, py, 'ceiling_bounce', 10)
        this._emitFeel({ type: 'jackpot', freezeMs: FREEZE_JACKPOT_MS, zoom: ZOOM_JACKPOT, flash: FLASH_JACKPOT, shake: SHAKE_MEDIUM })
        break
      }
      case 'bad_rock': {
        if (mods.turboActive) { this._spawnFloatText('TURBO BLOCK!', px, py - 40, '#00ffcc'); break }
        this.combo.breakCombo('bad_rock')
        this.score = Math.max(0, this.score - orb.scorePenalty)
        this._spawnFloatText(`-${orb.scorePenalty} COMBO BREAK!`, px, py - 40, '#ff4444')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 1.0)
        // Additional: deduct 50 to 150 Lava Coins
        const badRockPenalty = randInt(BAD_ROCK_COIN_PENALTY_MIN, BAD_ROCK_COIN_PENALTY_MAX)
        this.coins = Math.max(0, this.coins - badRockPenalty)
        this._spawnFloatText(`-${badRockPenalty}🪙`, px, py - 58, '#ff4444')
        break
      }
      case 'fire_wall': {
        // Always ignite lava sticks on both walls, even with shield/invincibility —
        // those just prevent the lava sticks from damaging the player on touch.
        this.orbs.spawnLavaSticks()
        this._spawnFloatText('FIRE WALL!', px, py - 40, '#ff6600')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.5)
        // Additional: deduct 25 to 75 Lava Coins
        const fireWallPenalty = randInt(FIRE_WALL_COIN_PENALTY_MIN, FIRE_WALL_COIN_PENALTY_MAX)
        this.coins = Math.max(0, this.coins - fireWallPenalty)
        this._spawnFloatText(`-${fireWallPenalty}🪙`, px, py - 58, '#ff6600')
        break
      }
      case 'lava_stick': {
        const dmg = mods.invincible ? 0 : LAVA_STICK_DAMAGE
        this.health = Math.max(0, this.health - dmg)
        if (dmg > 0) this.combo.breakOnHazard(this.artifactPerks.comboStabilize ? ARTIFACT_COMBO_STABILIZE_RETENTION : 0)
        this._spawnFloatText(`-${dmg} LAVA STICK!`, px, py - 40, '#ff4400')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.2)
        this.effects.createTrailParticles(px, py, 'wall_bounce', 4)
        if (this.health <= 0) {
          this.gameOver = true
          this._serverEventQueue.push({ type: 'game_over', score: this.score, combo: this.combo.getState() })
        }
        break
      }
      case 'magnet':
        this.powerups.activate('magnet', null, now)
        this._spawnFloatText('MAGNET!', px, py - 40, '#aa44ff')
        break
      case 'freeze':
        this.powerups.activate('freeze', null, now)
        this.orbs.activateFreeze(4000)
        this._spawnFloatText('FREEZE!', px, py - 40, '#aaeeff')
        break
      case 'shield':
        this.powerups.activate('shield', null, now)
        this._spawnFloatText('SHIELD!', px, py - 40, '#ffe066')
        break
      case 'gravity':
        this.powerups.activate('gravity', null, now)
        this._spawnFloatText('LOW GRAVITY!', px, py - 40, '#66aaff')
        break
      case 'health':
        this.health = Math.min(MAX_HEALTH, this.health + HEALTH_ORB_HEAL)
        this._spawnFloatText(`+${HEALTH_ORB_HEAL} HP`, px, py - 40, '#44ff88')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.4)
        break
      case 'chaos': {
        const result = this.powerups.activate('chaos', orb.chaosEffect, now)
        if (result.scoreBoost)   this.score += result.scoreBoost
        if (result.orbRain)      this.orbs.spawnOrbBatch('lava', result.orbRain)
        if (result.hazardBurst) { this.orbs.spawnOrbBatch('bad_rock', 3); this.orbs.spawnOrbBatch('fire_wall', 2) }
        this._spawnFloatText('CHAOS!', px, py - 50, '#ff44ff')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 2.0)
        // Additional: grant +100 to +500 Lava Coins (optimistic; server is authoritative)
        const chaosCoin = randInt(CHAOS_ORB_COIN_MIN, CHAOS_ORB_COIN_MAX)
        this.coins += chaosCoin
        this._spawnFloatText(`+${chaosCoin}🪙`, px, py - 70, '#ff44ff')
        break
      }
      case 'mythic':
        this._serverEventQueue.push({ type: 'mythic_collected', orbId: orb.id, timestamp: now, score: this.score })
        this._spawnFloatText('MYTHIC!!!', px, py - 60, '#ffffff')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 5.0)
        this.effects.createTrailParticles(px, py, 'ceiling_bounce', 20)
        break
      case 'combo': {
        // Combo Orb: instantly boosts the current combo count, same mechanism
        // the Jackpot orb's combo boost uses (simulate multiple lava orbs).
        for (let i = 0; i < COMBO_ORB_BOOST; i++) this.combo.onLavaOrb(now)
        this._spawnFloatText(`COMBO +${COMBO_ORB_BOOST}!`, px, py - 45, '#8844ff')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.3)
        break
      }
      case 'rose': {
        this.health = Math.min(MAX_HEALTH, this.health + ROSE_ORB_HEAL)
        this._spawnFloatText(`+${ROSE_ORB_HEAL} HP`, px, py - 40, '#ff88cc')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.2)
        break
      }
      case 'black': {
        // Black Orb: hazard-like penalty orb — full combo break (not eligible
        // for the comboStabilize artifact perk, which only softens *hazard*
        // damage hits) plus a score penalty and a brief visual distortion flag
        // the renderer can read off the orb's collection event.
        this.combo.breakCombo('black')
        this.score = Math.max(0, this.score - BLACK_ORB_SCORE_PENALTY)
        this._lastBlackOrbDistortUntil = now + BLACK_ORB_DISTORT_MS
        this._spawnFloatText(`-${BLACK_ORB_SCORE_PENALTY} COMBO BREAK!`, px, py - 40, '#aa00ff')
        this.effects.createImpactGlow(px, py, 'ceiling_bounce', 1.0)
        break
      }
      case 'sun_flame': {
        this.score += SUN_FLAME_ORB_BONUS
        this._spawnFloatText(`+${SUN_FLAME_ORB_BONUS} SUN FLAME!`, px, py - 50, '#ffcc00')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.6)
        this.effects.createTrailParticles(px, py, 'wall_bounce', 8)
        break
      }
      case 'electric': {
        // Electric Shock: auto-collects nearby active lava orbs within its
        // shock radius, running each one through the normal lava-orb
        // collection effect (score/coins/combo) so this stays fully
        // deterministic for replay — no extra RNG or side effects beyond what
        // collecting those lava orbs individually would have done.
        this._spawnFloatText('SHOCK!', px, py - 45, '#33aaff')
        this.effects.createImpactGlow(px, py, 'wall_bounce', 1.4)
        this.effects.createTrailParticles(px, py, 'wall_bounce', 6)
        const chained = this.orbs.collectNearby('lava', px, py, ELECTRIC_COLLECT_RADIUS)
        chained.forEach(chainedOrb => this._handleOrbCollected(chainedOrb, now, mods))
        break
      }
    }
  }

  _checkLavaWallCollisions() {
    if (this.gameOver) return
    const walls = this.arena.lavaWalls
    if (!walls || walls.length === 0) return

    const sx = this.physics.x
    const sy = this.physics.y
    const sr = this.physics.radius

    for (const wall of walls) {
      if (!wall.active) continue

      const wallLeft  = wall.x - wall.width / 2
      const wallRight = wall.x + wall.width / 2
      if (sx + sr < wallLeft || sx - sr > wallRight) continue

      const gapTop    = wall.gapY
      const gapBottom = wall.gapY + wall.gapHeight

      const hitsTop    = sy - sr < gapTop    && sy + sr > 0
      const hitsBottom = sy + sr > gapBottom && sy - sr < 10000

      if (hitsTop || hitsBottom) {
        // NOTE: this used to call this._bankCoins() and read this.totalCoins
        // — neither exists on this frontend engine (that's backend-only
        // bookkeeping this class never had). That threw every time a lava
        // wall killed the player, and since this method isn't wrapped in
        // try/catch, the throw took the whole update() call down with it —
        // the run would silently freeze on death instead of ending cleanly.
        // Matches every other death path in this file (see
        // _handlePhysicsCollision / _handleOrbCollected above).
        this.gameOver = true
        this._emitFeel({ type: 'near_death', freezeMs: 80, shake: 18, flash: '#ff2020' })
        this._serverEventQueue.push({
          type: 'game_over',
          score: this.score,
          combo: this.combo.getState(),
        })
        return
      }
    }
  }

  /**
   * WALL SPIKES HAZARD (ported from backend) — spikes mounted on the left/
   * right walls hold retracted for a telegraph window, then continuously
   * ease retracted -> extended -> retracted (see ArenaSystem._spawnWallSpikes).
   * This independently re-derives the exact same extension value
   * GameEngine's #drawWallSpikes uses, so the hitbox always matches what's
   * drawn. Touching an extended spike DAMAGES the player (with a per-spike
   * cooldown) rather than killing outright.
   */
  _checkWallSpikeCollisions(now) {
    if (this.gameOver) return
    const spikes = this.arena.wallSpikes
    if (!spikes || spikes.length === 0) return

    const sx = this.physics.x
    const sy = this.physics.y
    const sr = this.physics.radius

    for (const spike of spikes) {
      if (!spike.active) continue
      if (now < (spike.warningUntil ?? 0)) continue // telegraph — harmless

      const elapsed = (now - (spike.warningUntil ?? spike.spawnedAt)) + spike.phaseOffsetMs
      const phase = ((elapsed % spike.cycleMs) + spike.cycleMs) % spike.cycleMs / spike.cycleMs
      const extension = (1 - Math.cos(phase * Math.PI * 2)) / 2 // 0 (flush) -> 1 (out) -> 0
      const reach = extension * spike.length
      if (reach < 1) continue // fully retracted this instant

      const halfT = spike.thickness / 2
      if (sy + sr < spike.y - halfT || sy - sr > spike.y + halfT) continue // no vertical overlap

      const hit = spike.side === 'left'
        ? sx - sr < ZONE_LEFT + reach
        : sx + sr > ZONE_RIGHT - reach
      if (!hit) continue

      if (now - (spike.lastHitAt || 0) < WALL_SPIKES_DAMAGE_COOLDOWN_MS) continue
      spike.lastHitAt = now

      const mods = this.powerups.getModifiers()
      const dmg = mods.invincible ? 0 : WALL_SPIKES_DAMAGE
      this.health = Math.max(0, this.health - dmg)
      if (dmg > 0) {
        this.combo.breakOnHazard(this.artifactPerks.comboStabilize ? ARTIFACT_COMBO_STABILIZE_RETENTION : 0)
        this._spawnFloatText(`-${dmg} SPIKE!`, sx, sy - 40, '#cfd6dd')
        this.effects.createImpactGlow(sx, sy, 'wall_bounce', 1.1)
        this._emitFeel({ type: 'hazard_hit', freezeMs: 40, shake: 10, flash: '#ff6644' })
      }
      if (this.health <= 0) {
        this.gameOver = true
        this._emitFeel({ type: 'near_death', freezeMs: 80, shake: 18, flash: '#ff2020' })
        this._serverEventQueue.push({ type: 'game_over', score: this.score, combo: this.combo.getState() })
        return
      }
    }
  }

  /**
   * NINJA KNIFE HAZARD (ported from backend) — a thrown knife flies in a
   * straight line across the arena (see ArenaSystem._spawnNinjaKnives).
   * Simple circle-circle overlap; consumed on impact so one blade can never
   * tick damage repeatedly while it passes through.
   */
  _checkNinjaKnifeCollisions(now) {
    if (this.gameOver) return
    const knives = this.arena.ninjaKnives
    if (!knives || knives.length === 0) return

    const sx = this.physics.x
    const sy = this.physics.y
    const sr = this.physics.radius

    for (const knife of knives) {
      if (!knife.active) continue
      if (now < knife.warningUntil) continue // still telegraphing — harmless

      const dx = sx - knife.x
      const dy = sy - knife.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist >= sr + knife.radius) continue

      knife.active = false // consumed on impact — deals damage exactly once

      const mods = this.powerups.getModifiers()
      const dmg = mods.invincible ? 0 : NINJA_KNIFE_DAMAGE
      this.health = Math.max(0, this.health - dmg)
      if (dmg > 0) {
        this.combo.breakOnHazard(this.artifactPerks.comboStabilize ? ARTIFACT_COMBO_STABILIZE_RETENTION : 0)
        this._spawnFloatText(`-${dmg} BLADE!`, sx, sy - 40, '#e8f0f8')
        this.effects.createImpactGlow(sx, sy, 'wall_bounce', 1.1)
        this._emitFeel({ type: 'hazard_hit', freezeMs: 40, shake: 10, flash: '#cfe8ff' })
      }
      if (this.health <= 0) {
        this.gameOver = true
        this._emitFeel({ type: 'near_death', freezeMs: 80, shake: 18, flash: '#ff2020' })
        this._serverEventQueue.push({ type: 'game_over', score: this.score, combo: this.combo.getState() })
        return
      }
    }
  }

  _handleArenaEvent(evt) {
    const px = this.physics.x, py = this.physics.y
    const now = simTime()
    switch (evt.type) {
      // ── Original events (preserved) ──────────────────────────────
      case 'lava_rain':
        this.orbs.spawnOrbBatch('lava', evt.count)
        this._spawnFloatText('LAVA RAIN!', 240, 200, '#ff6600')
        break
      case 'wind':
        this.orbs.activateWind(evt.force, evt.duration)
        // Also push the player via physics
        this.physics.windForceX = evt.force * 0.09
        this._windExpireAt = simTime() + evt.duration
        this._spawnFloatText(evt.force > 0 ? '→ WIND →' : '← WIND ←', 240, 180, '#aaddff')
        break
      case 'orb_wave':
        this._spawnEruptionWave(evt.count ?? 5)
        break
      case 'boss_orb_storm':
        this.orbs.spawnOrbBatch('lava', evt.count)
        this._spawnFloatText(evt.label || 'ORB STORM!', 240, 360, '#ff6600')
        this._emitFeel({ type: 'boss', freezeMs: FREEZE_BOSS_MS, zoom: ZOOM_BOSS, flash: FLASH_BOSS, shake: SHAKE_LARGE })
        break
      case 'boss_survival_phase':
        this._spawnFloatText(evt.label || 'SURVIVE!', 240, 360, '#ffd700')
        this._emitFeel({ type: 'boss', freezeMs: FREEZE_BOSS_MS, zoom: ZOOM_BOSS, flash: FLASH_BOSS, shake: SHAKE_LARGE })
        break
      case 'survival_phase_complete':
        this.score += evt.bonus
        this._spawnFloatText(`SURVIVED! +${evt.bonus}`, 240, 360, '#ffd700')
        this._emitFeel({ type: 'boss', freezeMs: FREEZE_BOSS_MS, zoom: ZOOM_BOSS, flash: FLASH_COIN, shake: SHAKE_MEDIUM })
        break
      case 'boss_eruption_start':
        this._eruptionEventId++
        this._spawnFloatText(evt.label || 'ERUPTION!', 240, 360, '#ff4400')
        this._emitFeel({ type: 'boss', freezeMs: FREEZE_BOSS_MS, zoom: ZOOM_BOSS, flash: FLASH_BOSS, shake: SHAKE_LARGE })
        this._eruptionModeUntil = now + ((evt.waves ?? 3) * 2200) + 900
        this.orbs.setEruptionMode(true, evt.waves ?? 3)
        this._spawnEruptionWave((evt.waves ?? 3) * 2)
        break

      // ── New World Event System events ─────────────────────────────
      case 'darkness':
        this._spawnFloatText('DARKNESS!', 240, 200, '#8844ff')
        this.orbs.setDarknessMode(true)
        this._emitFeel({ type: 'world_event', zoom: ZOOM_EVENT, shake: SHAKE_SMALL })
        break
      case 'earthquake':
        this._spawnFloatText('EARTHQUAKE!', 240, 200, '#ffaa44')
        this._emitFeel({ type: 'world_event', zoom: ZOOM_EVENT, shake: SHAKE_MEDIUM })
        break
      case 'lava_walls_spawned':
        this._spawnFloatText('LAVA WALLS!', 240, 200, '#ff4400')
        this._emitFeel({ type: 'world_event', zoom: ZOOM_EVENT, shake: SHAKE_SMALL })
        break
      case 'wall_spikes_spawned':
        this._spawnFloatText('SPIKES!', 240, 200, '#cfd6dd')
        this._emitFeel({ type: 'world_event', zoom: ZOOM_EVENT, shake: SHAKE_SMALL })
        break
      case 'ninja_knives_spawned':
        this._spawnFloatText('INCOMING!', 240, 200, '#e8f0f8')
        this._emitFeel({ type: 'world_event', zoom: ZOOM_EVENT, shake: SHAKE_SMALL })
        break
      case 'orb_storm': {
        // Spawn a large burst of mixed positive and negative orbs
        const pos = evt.positiveCount ?? 10
        const neg = evt.negativeCount ?? 6
        this.orbs.spawnOrbBatch('lava', Math.ceil(pos * 0.6))
        this.orbs.spawnOrbBatch('turbo', Math.ceil(pos * 0.2))
        this.orbs.spawnOrbBatch('jackpot', Math.floor(pos * 0.1))
        this.orbs.spawnOrbBatch('chaos', Math.floor(pos * 0.1))
        this.orbs.spawnOrbBatch('bad_rock', Math.ceil(neg * 0.5))
        this.orbs.spawnOrbBatch('fire_wall', Math.ceil(neg * 0.3))
        this.orbs.spawnOrbBatch('black', Math.floor(neg * 0.2))
        this._spawnFloatText('ORB STORM!', 240, 200, '#ff9900')
        break
      }
      case 'lava_rain_hit': {
        // Check if player is within the column of the falling drop
        const dx = Math.abs(px - evt.x)
        if (dx < LAVA_RAIN_DROP_RADIUS + this.physics.radius) {
          const mods = this.powerups.getModifiers()
          const dmg  = mods.invincible ? 0 : LAVA_RAIN_DROP_DAMAGE
          this.health = Math.max(0, this.health - dmg)
          if (dmg > 0) {
            this.combo.breakOnHazard(this.artifactPerks.comboStabilize ? ARTIFACT_COMBO_STABILIZE_RETENTION : 0)
            this._spawnFloatText(`-${dmg} LAVA DROP!`, px, py - 40, '#ff4400')
            this.effects.createImpactGlow(px, py, 'ceiling_bounce', 1.0)
          }
          if (this.health <= 0) {
            this.gameOver = true
            this._serverEventQueue.push({ type: 'game_over', score: this.score, combo: this.combo.getState() })
          }
        }
        break
      }
    }
  }

  _spawnFloatText(text, x, y, colour) {
    this.floatTexts.push({ text, x, y, colour, alpha: 1, vy: -1.2, life: 60, age: 0 })
  }

  _spawnEruptionWave(count) {
    const hidden = this.arena.darknessAlpha > 0
    const lavaCount = Math.max(18, count * 8)
    const rareCount = Math.max(4, Math.ceil(count * 0.35))

    this.orbs.spawnOrbBatch('lava', lavaCount, { fromTop: true, hidden })
    this.orbs.spawnOrbBurstFromTop(rareCount, { hidden })
  }

  _handleOrbMissed(orb, now) {
    if (!orb) return
    const px = orb.x ?? this.physics.x
    const py = orb.y ?? this.physics.y
    const isRare = ['jackpot', 'diamond', 'mythic'].includes(orb.type)
    const penalty = isRare ? 0.84 : 0.92

    this.physics.applyMissPenalty(penalty)
    // No "MISSED <TYPE>!" float text any more — it kept reading as a false
    // alarm even after the real double-fire bug was fixed (players still
    // don't want the callout at all), so the miss penalty/feel still apply
    // but nothing is displayed for it.
    this._emitFeel({
      type: 'world_event',
      zoom: isRare ? ZOOM_JACKPOT : ZOOM_EVENT,
      zoomCenter: { x: px, y: py },
      shake: SHAKE_SMALL,
    })
  }

  _updateFloatTexts() {
    this.floatTexts = this.floatTexts.filter(f => {
      f.age++; f.y += f.vy; f.alpha = Math.max(0, 1 - f.age / f.life)
      return f.age < f.life
    })
  }

  // ── Game Feel ───────────────────────────────────────────────────────────────
  _detectGameFeelEvents(mods) {
    if (mods.turboActive && !this._turboWasActive) {
      this._gameFeel = { type: 'turbo', zoom: ZOOM_TURBO, flash: FLASH_TURBO }
    }
    this._turboWasActive = mods.turboActive

    const nearDeath = this.health > 0 && this.health <= 25
    if (nearDeath && !this._wasNearDeath) {
      this._gameFeel = { type: 'near_death', freezeMs: FREEZE_NEAR_DEATH_MS, flash: FLASH_DAMAGE, shake: SHAKE_MEDIUM }
    }
    this._wasNearDeath = nearDeath

    const count = this.combo.getState()?.count ?? 0
    if (count >= 50 && this._lastComboMilestone < 50) {
      this._lastComboMilestone = 50
      this._gameFeel = { type: 'combo_milestone', freezeMs: FREEZE_COMBO_MS, zoom: ZOOM_COMBO, shake: SHAKE_MEDIUM }
    } else if (count >= 25 && this._lastComboMilestone < 25) {
      this._lastComboMilestone = 25
      this._gameFeel = { type: 'combo_milestone', freezeMs: FREEZE_COMBO_MS, zoom: ZOOM_COMBO, shake: SHAKE_SMALL }
    } else if (count >= 10 && this._lastComboMilestone < 10) {
      this._lastComboMilestone = 10
      this._gameFeel = { type: 'combo_milestone', freezeMs: FREEZE_COMBO_MS, zoom: ZOOM_COMBO, shake: SHAKE_SMALL }
    }
    if (count < 5) this._lastComboMilestone = 0
  }

  _emitFeel(signal) {
    const priority = { boss: 5, jackpot: 4, near_death: 3, combo_milestone: 2, lava_coin: 1, turbo: 1, world_event: 0 }
    const cur = priority[this._gameFeel?.type ?? ''] ?? -1
    const nxt = priority[signal?.type ?? ''] ?? -1
    if (nxt >= cur) this._gameFeel = signal
  }
}

/** Serialize state for WebSocket transmission */
export function createGameStateMessage(gameLogic) {
  const state = gameLogic.getGameState()
  return {
    type: 'game:state',
    payload: {
      player:       state.player,
      collectibles: state.collectibles,
      obstacle:     state.obstacle,
      screenShake:  state.screenShake,
      arena:        state.arena,
      worldEvents:  state.worldEvents,
      gameFeel:     state.gameFeel,
      bounceEffects: {
        glows:      gameLogic.effects.getGlowEffects(),
        particles:  gameLogic.effects.getTrailParticles(),
        trail:      gameLogic.effects.getTrailPoints(),
        indicators: gameLogic.effects.getBounceIndicators(),
      },
      hud: state.hud,
    },
  }
}

export default GameLogic

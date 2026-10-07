/**
 * ORB SYSTEM — Volcano Spoon
 * All 11 orb types: lava | turbo | jackpot | bad_rock | fire_wall |
 *                   magnet | freeze | shield | gravity | chaos | mythic
 *
 * Spawn weights are backend-overridable via setSpa         wnWeights().
 * Jackpot/Mythic rewards are server-authoritative — client only flags them.
 */

import {
  ZONE_LEFT, ZONE_RIGHT, CEILING_Y, FLOOR_Y,
  ORB_MAX_ACTIVE, ORB_SPAWN_INTERVAL_MS,
  ORB_MIN_X, ORB_MAX_X, ORB_MIN_Y, ORB_MAX_Y,
  LAVA_ORB_BASE_SCORE, LAVA_ORB_SPEED, LAVA_ORB_RADIUS, LAVA_ORB_WEIGHT,
  TURBO_ORB_WEIGHT, TURBO_ORB_SPEED, TURBO_ORB_RADIUS,
  JACKPOT_ORB_WEIGHT, JACKPOT_ORB_SPEED, JACKPOT_ORB_RADIUS, JACKPOT_LIFETIME_MS, JACKPOT_BASE_POINTS,
  BAD_ROCK_WEIGHT, BAD_ROCK_SPEED, BAD_ROCK_RADIUS, BAD_ROCK_SCORE_PENALTY,
  FIRE_WALL_WEIGHT, FIRE_WALL_RADIUS, FIRE_WALL_ORB_SPEED,
  LAVA_STICK_RADIUS, LAVA_STICK_LIFETIME_MS,
  MAGNET_ORB_WEIGHT, MAGNET_ORB_RADIUS, MAGNET_PULL_RADIUS, MAGNET_PULL_STRENGTH,
  FREEZE_ORB_WEIGHT, FREEZE_ORB_RADIUS, FREEZE_SPEED_FACTOR,
  SHIELD_ORB_WEIGHT, SHIELD_ORB_RADIUS,
  GRAVITY_ORB_WEIGHT, GRAVITY_ORB_RADIUS,
  CHAOS_ORB_WEIGHT, CHAOS_ORB_RADIUS, CHAOS_EFFECTS,
  MYTHIC_ORB_WEIGHT, MYTHIC_ORB_RADIUS, MYTHIC_ORB_SPEED, MYTHIC_LIFETIME_MS,
  DIAMOND_ORB_WEIGHT, DIAMOND_ORB_RADIUS, DIAMOND_LIFETIME_MS, DIAMOND_BASE_POINTS,
  HEALTH_ORB_WEIGHT, HEALTH_ORB_RADIUS, HEALTH_ORB_HEAL, HEALTH_ORB_LIFETIME_MS,
  STRUGGLE_FREEZE_BOOST, STRUGGLE_SHIELD_BOOST, STRUGGLE_HAZARD_REDUCTION, STRUGGLE_SPEED_REDUCTION,
  JACKPOT_MIN_ARENA_STAGE, MYTHIC_MIN_ARENA_STAGE,
  SHIELD_MIN_ARENA_STAGE, MAGNET_MIN_ARENA_STAGE, HEALTH_MIN_ARENA_STAGE,
  FREEZE_MIN_ARENA_STAGE, GRAVITY_MIN_ARENA_STAGE,
  COMBO_ORB_WEIGHT, COMBO_ORB_SPEED, COMBO_ORB_RADIUS, COMBO_ORB_BOOST, COMBO_MIN_ARENA_STAGE,
  ROSE_ORB_WEIGHT, ROSE_ORB_RADIUS, ROSE_ORB_SPEED, ROSE_ORB_HEAL, ROSE_MIN_ARENA_STAGE,
  BLACK_ORB_WEIGHT, BLACK_ORB_RADIUS, BLACK_ORB_SPEED, BLACK_ORB_SCORE_PENALTY, BLACK_ORB_DISTORT_MS,
  SUN_FLAME_ORB_WEIGHT, SUN_FLAME_ORB_RADIUS, SUN_FLAME_ORB_SPEED, SUN_FLAME_ORB_BONUS, SUN_FLAME_LIFETIME_MS,
  ELECTRIC_ORB_WEIGHT, ELECTRIC_ORB_RADIUS, ELECTRIC_ORB_SPEED, ELECTRIC_SHOCK_MS, ELECTRIC_COLLECT_RADIUS, ELECTRIC_LIFETIME_MS,
} from './constants.js'
import { random } from './seededRandom.js'
import { now as simTime } from './simClock.js'

// Arena-Stage Orb Unlocks — additive gate applied on top of whatever
// LevelSystem's spawnWeights already allow (see constants.js). Matches the
// backend's POWERUP_STAGE_GATES for the orb types this engine has.
const ORB_STAGE_GATES = {
  jackpot: JACKPOT_MIN_ARENA_STAGE,
  mythic:  MYTHIC_MIN_ARENA_STAGE,
  shield:  SHIELD_MIN_ARENA_STAGE,
  magnet:  MAGNET_MIN_ARENA_STAGE,
  health:  HEALTH_MIN_ARENA_STAGE,
  freeze:  FREEZE_MIN_ARENA_STAGE,
  gravity: GRAVITY_MIN_ARENA_STAGE,
  combo:   COMBO_MIN_ARENA_STAGE,
  rose:    ROSE_MIN_ARENA_STAGE,
}

const DEFAULT_WEIGHTS = {
  lava:      LAVA_ORB_WEIGHT,
  turbo:     TURBO_ORB_WEIGHT,
  jackpot:   JACKPOT_ORB_WEIGHT,
  bad_rock:  BAD_ROCK_WEIGHT,
  fire_wall: FIRE_WALL_WEIGHT,
  magnet:    MAGNET_ORB_WEIGHT,
  freeze:    FREEZE_ORB_WEIGHT,
  shield:    SHIELD_ORB_WEIGHT,
  gravity:   GRAVITY_ORB_WEIGHT,
  chaos:     CHAOS_ORB_WEIGHT,
  mythic:    MYTHIC_ORB_WEIGHT,
  diamond:   DIAMOND_ORB_WEIGHT,
  health:    HEALTH_ORB_WEIGHT,
  combo:     COMBO_ORB_WEIGHT,
  rose:      ROSE_ORB_WEIGHT,
  black:     BLACK_ORB_WEIGHT,
  sun_flame: SUN_FLAME_ORB_WEIGHT,
  electric:  ELECTRIC_ORB_WEIGHT,
}

let _nextId = 1
const nextId = () => _nextId++
const rand = (min, max) => random() * (max - min) + min
const randInt = (min, max) => Math.floor(rand(min, max + 1))
const randSign = () => (random() < 0.5 ? -1 : 1)

function weightedPick(weights, allowedTypes) {
  const entries = Object.entries(weights)
    .filter(([type, weight]) => (allowedTypes ? allowedTypes.has(type) : true) && weight > 0)

  const total = entries.reduce((s, [, w]) => s + w, 0)
  if (total <= 0) return 'lava'

  let r = random() * total
  for (const [type, w] of entries) {
    r -= w
    if (r <= 0) return type
  }
  return 'lava'
}

function createBaseOrb(type, x, y, vx, vy, radius, lifetime = 7000) {
  return {
    id: nextId(), type, x, y, vx, vy,
    r: radius,
    spawnedAt: simTime(),
    lifetime,
    alpha: 1,
    angle: 0,
    angularV: randSign() * rand(0.01, 0.05),
    collected: false,
    active: true,
    hidden: false,
    revealed: false,
    revealHoldUntil: 0,
  }
}

function randomSpawnPos() {
  return { x: rand(ORB_MIN_X, ORB_MAX_X), y: rand(ORB_MIN_Y, ORB_MAX_Y) }
}

function randomVel(speed) {
  const a = rand(0, Math.PI * 2)
  return { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed }
}

// ── Individual spawners ───────────────────────────────────────────────────────

function spawnLavaOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(LAVA_ORB_SPEED * sm)
  const o = createBaseOrb('lava', p.x, p.y, v.vx, v.vy, LAVA_ORB_RADIUS)
  o.score = LAVA_ORB_BASE_SCORE; o.color = '#ff6600'; o.glowColor = '#ff3300'
  return o
}
function spawnTurboOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(TURBO_ORB_SPEED * sm)
  const o = createBaseOrb('turbo', p.x, p.y, v.vx, v.vy, TURBO_ORB_RADIUS)
  o.color = '#00ffcc'; o.glowColor = '#00ff88'; return o
}
function spawnJackpotOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(JACKPOT_ORB_SPEED * sm)
  const o = createBaseOrb('jackpot', p.x, p.y, v.vx, v.vy, JACKPOT_ORB_RADIUS, JACKPOT_LIFETIME_MS)
  o.color = '#ffd700'; o.glowColor = '#ffaa00'; o.baseScore = JACKPOT_BASE_POINTS; return o
}
function spawnBadRock(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(BAD_ROCK_SPEED * sm)
  const o = createBaseOrb('bad_rock', p.x, p.y, v.vx, v.vy, BAD_ROCK_RADIUS)
  o.color = '#775544'; o.glowColor = '#994422'; o.scorePenalty = BAD_ROCK_SCORE_PENALTY; return o
}
function spawnFireWallOrb(sm = 1) {
  // Now floats freely like other orbs — collecting it spawns lava-stick
  // hazards on the walls instead of damaging health directly.
  const p = randomSpawnPos(), v = randomVel(FIRE_WALL_ORB_SPEED * sm)
  const o = createBaseOrb('fire_wall', p.x, p.y, v.vx, v.vy, FIRE_WALL_RADIUS)
  o.color = '#ff3300'; o.glowColor = '#ff6600'; return o
}

/** A stationary hazard on the wall — center placed just inside the zone so the spoon can hit it. */
function spawnLavaStick(side) {
  // Place center 8px inside the physics wall so the stick overlaps the zone enough
  // for the player (radius 22) to collide with it (radius 13) when grazing the wall.
  const x = side === 'left' ? ZONE_LEFT + 8 : ZONE_RIGHT - 8
  const y = rand(CEILING_Y + 40, FLOOR_Y - 40)
  const o = createBaseOrb('lava_stick', x, y, 0, 0, LAVA_STICK_RADIUS, LAVA_STICK_LIFETIME_MS)
  o.color = '#ff3300'; o.glowColor = '#ff6600'; o.wallSide = side; o.stationary = true
  return o
}
function spawnMagnetOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(1.6 * sm)
  const o = createBaseOrb('magnet', p.x, p.y, v.vx, v.vy, MAGNET_ORB_RADIUS)
  o.color = '#aa44ff'; o.glowColor = '#cc66ff'; return o
}
function spawnFreezeOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(1.8 * sm)
  const o = createBaseOrb('freeze', p.x, p.y, v.vx, v.vy, FREEZE_ORB_RADIUS)
  o.color = '#aaeeff'; o.glowColor = '#55ddff'; return o
}
function spawnShieldOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(1.8 * sm)
  const o = createBaseOrb('shield', p.x, p.y, v.vx, v.vy, SHIELD_ORB_RADIUS)
  o.color = '#ffe066'; o.glowColor = '#ffcc00'; return o
}
function spawnGravityOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(2.0 * sm)
  const o = createBaseOrb('gravity', p.x, p.y, v.vx, v.vy, GRAVITY_ORB_RADIUS)
  o.color = '#66aaff'; o.glowColor = '#4488ff'; return o
}
function spawnChaosOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(2.5 * sm)
  const o = createBaseOrb('chaos', p.x, p.y, v.vx, v.vy, CHAOS_ORB_RADIUS)
  o.color = '#ff44ff'; o.glowColor = '#cc00cc'
  o.chaosEffect = CHAOS_EFFECTS[randInt(0, CHAOS_EFFECTS.length - 1)]; return o
}
function spawnMythicOrb() {
  const p = randomSpawnPos(), v = randomVel(MYTHIC_ORB_SPEED)
  const o = createBaseOrb('mythic', p.x, p.y, v.vx, v.vy, MYTHIC_ORB_RADIUS, MYTHIC_LIFETIME_MS)
  o.color = '#ffd700'; o.glowColor = '#ffffff'; o.isMythic = true; return o
}
function spawnDiamondOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(2.2 * sm)
  const o = createBaseOrb('diamond', p.x, p.y, v.vx, v.vy, DIAMOND_ORB_RADIUS, DIAMOND_LIFETIME_MS)
  o.color = '#aaddff'; o.glowColor = '#ffffff'; o.baseScore = DIAMOND_BASE_POINTS; return o
}
function spawnHealthOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(1.8 * sm)
  const o = createBaseOrb('health', p.x, p.y, v.vx, v.vy, HEALTH_ORB_RADIUS, HEALTH_ORB_LIFETIME_MS)
  o.color = '#44ff88'; o.glowColor = '#88ffbb'; o.heal = HEALTH_ORB_HEAL; return o
}

function spawnOrbAtTop(orb, hidden = false) {
  orb.x = rand(ORB_MIN_X, ORB_MAX_X)
  orb.y = CEILING_Y + orb.r + 2
  orb.vx = rand(-1.2, 1.2) + orb.vx * 0.15
  orb.vy = Math.abs(orb.vy) + rand(0.6, 1.8)
  orb.hidden = hidden
  orb.revealed = !hidden
  orb.alpha = hidden ? 0 : 1
  return orb
}

// ── OrbSystem class ───────────────────────────────────────────────────────────

function spawnComboOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(COMBO_ORB_SPEED * sm)
  const o = createBaseOrb('combo', p.x, p.y, v.vx, v.vy, COMBO_ORB_RADIUS)
  o.color = '#8844ff'; o.glowColor = '#aa66ff'; o.comboBoost = COMBO_ORB_BOOST
  return o
}
function spawnRoseOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(ROSE_ORB_SPEED * sm)
  const o = createBaseOrb('rose', p.x, p.y, v.vx, v.vy, ROSE_ORB_RADIUS)
  o.color = '#ff88cc'; o.glowColor = '#ffccee'; o.heal = ROSE_ORB_HEAL
  return o
}
function spawnBlackOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(BLACK_ORB_SPEED * sm)
  const o = createBaseOrb('black', p.x, p.y, v.vx, v.vy, BLACK_ORB_RADIUS)
  o.color = '#220033'; o.glowColor = '#aa00ff'
  o.scorePenalty = BLACK_ORB_SCORE_PENALTY; o.distortMs = BLACK_ORB_DISTORT_MS
  return o
}
function spawnSunFlameOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(SUN_FLAME_ORB_SPEED * sm)
  const o = createBaseOrb('sun_flame', p.x, p.y, v.vx, v.vy, SUN_FLAME_ORB_RADIUS, SUN_FLAME_LIFETIME_MS)
  o.color = '#ffcc00'; o.glowColor = '#ff9900'; o.baseScore = SUN_FLAME_ORB_BONUS
  return o
}
function spawnElectricOrb(sm = 1) {
  const p = randomSpawnPos(), v = randomVel(ELECTRIC_ORB_SPEED * sm)
  const o = createBaseOrb('electric', p.x, p.y, v.vx, v.vy, ELECTRIC_ORB_RADIUS, ELECTRIC_LIFETIME_MS)
  o.color = '#33aaff'; o.glowColor = '#aaeeff'
  o.shockRadius = ELECTRIC_COLLECT_RADIUS; o.shockMs = ELECTRIC_SHOCK_MS
  return o
}

export class OrbSystem {
  constructor() {
    this.orbs            = []
    this.weights         = { ...DEFAULT_WEIGHTS }
    this.unlockedTypes   = new Set(Object.keys(DEFAULT_WEIGHTS))
    this.speedMult       = 1.0
    this.spawnPaused     = false
    this.lastSpawnMs     = 0
    this.spawnIntervalMs = ORB_SPAWN_INTERVAL_MS
    this.maxActiveOrbs   = ORB_MAX_ACTIVE
    this.freezeActive    = false
    this.freezeUntil     = 0
    this._prevSpeedMult  = 1.0
    this.windActive      = false
    this.windForce       = 0
    this.windUntil       = 0
    this.darknessMode    = false
    this.eruptionMode    = false
    this.eruptionBoost   = 1

    // Persistent Arena Stage (NOT reset by reset() — a per-run reset — since
    // Arena Stage persists across runs/rounds, same as the backend). Gates
    // jackpot/mythic/support orbs additively on top of the Level unlock —
    // see ORB_STAGE_GATES above.
    this.arenaStage      = 1

    // NFT-artifact "hazard visibility" perk (see game/artifactPerks.js /
    // GameLogic.setArtifactPerks) — same lifetime as arenaStage above: set
    // once per run by GameLogic, NOT cleared by reset(), since it reflects
    // the player's owned/active artifacts, not per-run state. While
    // active, Darkness Mode's orb-hiding is skipped entirely (see
    // _effectiveDarkness()) rather than only shortening the reveal delay,
    // matching constants.js's note that this perk is purely about keeping
    // hazards/orbs visible, with no separate numeric constant of its own.
    this.hazardVisibilityActive = false
  }

  /** Set by GameLogic.setArtifactPerks() from server-derived ownership. */
  setHazardVisibility(active) {
    this.hazardVisibilityActive = !!active
  }

  /** Darkness Mode's actual hiding effect, net of the hazard-visibility perk. */
  _effectiveDarkness() {
    return this.darknessMode && !this.hazardVisibilityActive
  }

  /** Override spawn weights from backend */
  setSpawnWeights(overrides) { this.weights = { ...DEFAULT_WEIGHTS, ...overrides } }

  /**
   * Called whenever the player's (persistent) Arena Stage changes — on game
   * start and on stage selection. Immediately re-applies the jackpot/
   * mythic/support-orb stage gate via _applyArenaStageGate().
   */
  setArenaStage(stage) {
    this.arenaStage = Number.isFinite(Number(stage)) ? Number(stage) : this.arenaStage
    this._applyArenaStageGate()
  }

  /** Zeroes out any orb type whose Arena Stage requirement isn't met yet. */
  _applyArenaStageGate() {
    for (const [type, minStage] of Object.entries(ORB_STAGE_GATES)) {
      if ((this.weights[type] ?? 0) > 0 && this.arenaStage < minStage) {
        this.weights[type] = 0
      }
    }
  }

  setDarknessMode(active) {
    this.darknessMode = !!active
    if (this._effectiveDarkness()) {
      this.orbs.forEach((orb) => {
        if (!orb.revealed) {
          orb.hidden = true
          orb.alpha = 0
        }
      })
    }
  }

  setEruptionMode(active, boost = 1) {
    this.eruptionMode = !!active
    this.eruptionBoost = Math.max(1, boost || 1)
  }

  _getEffectiveWeights() {
    const weights = { ...this.weights }
    if (!this.eruptionMode) return weights

    weights.lava    = (weights.lava ?? 0) * (1.7 + this.eruptionBoost * 0.2)
    weights.turbo   = (weights.turbo ?? 0) * 1.15
    weights.jackpot = (weights.jackpot ?? 0) * (2.5 + this.eruptionBoost * 0.35)
    weights.diamond = (weights.diamond ?? 0) * (5 + this.eruptionBoost)
    weights.health  = (weights.health ?? 0) * (3 + this.eruptionBoost * 0.5)
    weights.mythic  = (weights.mythic ?? 0) * (1.8 + this.eruptionBoost * 0.15)
    return weights
  }

  setSpawnProfile({ spawnWeights = {}, unlockedTypes = [] } = {}) {
    this.weights = Object.keys(DEFAULT_WEIGHTS).reduce((acc, type) => {
      acc[type] = spawnWeights[type] ?? 0
      return acc
    }, {})
    // Arena-Stage gate is additive on top of the Level profile above, and
    // has to be re-applied every call since setSpawnProfile() runs every
    // frame and replaces this.weights wholesale.
    this._applyArenaStageGate()
    this.unlockedTypes = unlockedTypes.length > 0
      ? new Set(unlockedTypes)
      : new Set(Object.keys(this.weights).filter((type) => (this.weights[type] ?? 0) > 0))
  }

  setMaxActiveOrbs(maxActiveOrbs) {
    this.maxActiveOrbs = Math.max(1, Math.min(ORB_MAX_ACTIVE, Math.floor(maxActiveOrbs || ORB_MAX_ACTIVE)))
  }

  /** Apply hidden struggling-player adjustments */
  applyStrugglingAdjustments() {
    this.weights.freeze    = Math.min(this.weights.freeze    * STRUGGLE_FREEZE_BOOST, 30)
    this.weights.shield    = Math.min(this.weights.shield    * STRUGGLE_SHIELD_BOOST, 30)
    this.weights.bad_rock  = this.weights.bad_rock  * STRUGGLE_HAZARD_REDUCTION
    this.weights.fire_wall = this.weights.fire_wall * STRUGGLE_HAZARD_REDUCTION
    this.speedMult         = Math.min(this.speedMult * STRUGGLE_SPEED_REDUCTION, 1.0)
    this.spawnIntervalMs   = this.spawnIntervalMs * 1.35
  }

  clearStrugglingAdjustments() {
    this.weights         = { ...DEFAULT_WEIGHTS }
  }

  setSpeedMultiplier(mult) { this.speedMult = mult }

  activateFreeze(durationMs) {
    this.freezeActive   = true
    this.freezeUntil    = simTime() + durationMs
    this._prevSpeedMult = this.speedMult
    this.speedMult     *= FREEZE_SPEED_FACTOR
  }

  activateWind(force, durationMs) {
    this.windActive = true
    this.windForce  = force
    this.windUntil  = simTime() + durationMs
  }

  update(now, playerState, magnetActive = false) {
    if (this.freezeActive && now >= this.freezeUntil) {
      this.freezeActive = false
      this.speedMult    = this._prevSpeedMult ?? 1.0
    }
    if (this.windActive && now >= this.windUntil) {
      this.windActive = false; this.windForce = 0
    }

    this.orbs.forEach(orb => {
      if (!orb.active) return
      if (orb.stationary) {
        orb.angle += orb.angularV
        const lifeRatio = (now - orb.spawnedAt) / orb.lifetime
        orb.alpha = orb.hidden && !orb.revealed
          ? 0
          : lifeRatio > 0.7
            ? Math.max(0, 1 - (lifeRatio - 0.7) / 0.3)
            : 1
        return
      }

      if (magnetActive && orb.type === 'lava') {
        const dx = playerState.x - orb.x, dy = playerState.y - orb.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < MAGNET_PULL_RADIUS && dist > 1) {
          orb.vx += (dx / dist) * MAGNET_PULL_STRENGTH
          orb.vy += (dy / dist) * MAGNET_PULL_STRENGTH
        }
      }
      if (this.windActive) orb.vx += this.windForce * 0.04

      orb.x += orb.vx * this.speedMult
      orb.y += orb.vy * this.speedMult
      orb.angle += orb.angularV

      if (orb.hidden && !orb.revealed) {
        orb.alpha = 0
        return
      }

      if (orb.x - orb.r <= ZONE_LEFT)  { orb.x = ZONE_LEFT  + orb.r; orb.vx =  Math.abs(orb.vx) }
      if (orb.x + orb.r >= ZONE_RIGHT) { orb.x = ZONE_RIGHT - orb.r; orb.vx = -Math.abs(orb.vx) }
      if (orb.y - orb.r <= CEILING_Y)  { orb.y = CEILING_Y  + orb.r; orb.vy =  Math.abs(orb.vy) }
      if (orb.y + orb.r >= FLOOR_Y)    { orb.y = FLOOR_Y    - orb.r; orb.vy = -Math.abs(orb.vy) }

      const lifeRatio = (now - orb.spawnedAt) / orb.lifetime
      orb.alpha = lifeRatio > 0.75 ? 1 - (lifeRatio - 0.75) / 0.25 : 1
    })

    const expired = []
    this.orbs = this.orbs.filter((o) => {
      const alive = o.active && (now - o.spawnedAt) < o.lifetime
      if (alive) return true
      // Same-frame grace: if the player's spoon is already overlapping this
      // orb on the exact frame its lifetime elapses, let the collision
      // check (run right after this) collect it instead of it silently
      // aging out and firing a "MISSED" float text on a frame it was
      // actually being collected.
      if (o.active && playerState) {
        const dx = playerState.x - o.x, dy = playerState.y - o.y
        const touching = Math.sqrt(dx * dx + dy * dy) < (playerState.radius ?? 0) + o.r
        if (touching) return true
      }
      // THE REAL BUG: checkPlayerCollisions() (called right after this, by
      // GameLogic) only sets o.active = false + o.collected = true on pickup
      // — it doesn't remove the orb from this.orbs. So a just-collected orb
      // sits here with active === false until the very NEXT update() call,
      // where — with no distinction from a genuinely-timed-out orb — it fell
      // straight into `expired` and fired "MISSED <TYPE>!" one frame after
      // every single real collection. o.collected is the one field that
      // tells them apart: only report a genuine miss.
      if (!o.collected) expired.push(o)
      return false
    })
    return { expired }
  }

  trySpawn(now) {
    if (this.spawnPaused || this.orbs.length >= this.maxActiveOrbs) return null
    if (now - this.lastSpawnMs < this.spawnIntervalMs) return null
    this.lastSpawnMs = now
    const orb = this._createOrbByType(weightedPick(this._getEffectiveWeights(), this.unlockedTypes))
    if (orb) {
      if (this.eruptionMode) spawnOrbAtTop(orb, this._effectiveDarkness())
      else if (this._effectiveDarkness()) { orb.hidden = true; orb.alpha = 0 }
      this.orbs.push(orb)
    }
    return orb
  }

  spawnOrbBatch(type, count, options = {}) {
    const spawned = []
    for (let i = 0; i < count; i++) {
      const orb = this._createOrbByType(type)
      if (orb && this.orbs.length < this.maxActiveOrbs) {
        if (options.fromTop) spawnOrbAtTop(orb, options.hidden ?? this._effectiveDarkness())
        else if (options.hidden ?? this._effectiveDarkness()) { orb.hidden = true; orb.alpha = 0 }
        this.orbs.push(orb); spawned.push(orb)
      }
    }
    return spawned
  }

  spawnOrbBurstFromTop(count, options = {}) {
    const spawned = []
    for (let i = 0; i < count; i++) {
      const orb = this._createOrbByType(weightedPick(this._getEffectiveWeights(), this.unlockedTypes))
      if (orb && this.orbs.length < this.maxActiveOrbs) {
        spawnOrbAtTop(orb, options.hidden ?? this._effectiveDarkness())
        this.orbs.push(orb)
        spawned.push(orb)
      }
    }
    return spawned
  }

  /** Spawns one lava-stick hazard on each wall (left + right). */
  spawnLavaSticks() {
    const left  = spawnLavaStick('left')
    const right = spawnLavaStick('right')
    this.orbs.push(left, right)
    return [left, right]
  }

  forceSpawn(type, options = {}) {
    const orb = this._createOrbByType(type)
    if (orb) {
      if (options.fromTop) spawnOrbAtTop(orb, options.hidden ?? this._effectiveDarkness())
      else if (options.hidden ?? this._effectiveDarkness()) { orb.hidden = true; orb.alpha = 0 }
      this.orbs.push(orb)
    }
    return orb
  }

  checkPlayerCollisions(px, py, pr, { now = simTime(), darknessActive = false } = {}) {
    const collected = []
    const revealed = []
    this.orbs.forEach(orb => {
      if (!orb.active) return
      const dx = px - orb.x, dy = py - orb.y
      if (Math.sqrt(dx * dx + dy * dy) < pr + orb.r) {
        if (orb.hidden && !orb.revealed) {
          orb.hidden = false
          orb.revealed = true
          orb.revealHoldUntil = now + 180
          orb.alpha = 1
          revealed.push(orb)
          return
        }
        if (orb.revealed && orb.revealHoldUntil && now < orb.revealHoldUntil) {
          orb.alpha = 1
          return
        }
        orb.active = false; orb.collected = true; collected.push(orb)
      }
    })
    return { collected, revealed }
  }

  getOrbs() { return this.orbs.filter(o => o.active) }

  // Used by the Electric Shock orb's collection effect: auto-collects any
  // active orb of `type` within `radius` of (px, py), returning them so the
  // caller can apply their normal collection effects.
  collectNearby(type, px, py, radius) {
    const hits = []
    this.orbs.forEach(orb => {
      if (!orb.active || orb.type !== type) return
      const dx = px - orb.x, dy = py - orb.y
      if (Math.sqrt(dx * dx + dy * dy) <= radius) {
        orb.active = false; orb.collected = true; hits.push(orb)
      }
    })
    return hits
  }

  reset() {
    this.orbs            = []
    this.speedMult       = 1.0
    this.weights         = { ...DEFAULT_WEIGHTS }
    this.unlockedTypes   = new Set(Object.keys(DEFAULT_WEIGHTS))
    this.spawnIntervalMs = ORB_SPAWN_INTERVAL_MS
    this.maxActiveOrbs   = ORB_MAX_ACTIVE
    this.freezeActive    = false
    this.windActive      = false
    this.lastSpawnMs     = 0
    this.darknessMode    = false
    this.eruptionMode    = false
    this.eruptionBoost   = 1
  }

  _createOrbByType(type) {
    const sm = this.speedMult
    switch (type) {
      case 'lava':      return spawnLavaOrb(sm)
      case 'turbo':     return spawnTurboOrb(sm)
      case 'jackpot':   return spawnJackpotOrb(sm)
      case 'bad_rock':  return spawnBadRock(sm)
      case 'fire_wall': return spawnFireWallOrb(sm)
      case 'lava_stick': return spawnLavaStick(random() < 0.5 ? 'left' : 'right')
      case 'magnet':    return spawnMagnetOrb(sm)
      case 'freeze':    return spawnFreezeOrb(sm)
      case 'shield':    return spawnShieldOrb(sm)
      case 'gravity':   return spawnGravityOrb(sm)
      case 'chaos':     return spawnChaosOrb(sm)
      case 'mythic':    return spawnMythicOrb()
      case 'diamond':   return spawnDiamondOrb(sm)
      case 'health':    return spawnHealthOrb(sm)
      case 'combo':     return spawnComboOrb(sm)
      case 'rose':      return spawnRoseOrb(sm)
      case 'black':     return spawnBlackOrb(sm)
      case 'sun_flame': return spawnSunFlameOrb(sm)
      case 'electric':  return spawnElectricOrb(sm)
      default:          return spawnLavaOrb(sm)
    }
  }
}

export default OrbSystem

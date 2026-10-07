/**
 * MOMENTUM-BASED ARCADE PHYSICS ENGINE
 * 
 * Complete redesign from auto-loop to physics-driven movement
 * 
 * CORE PHILOSOPHY:
 * - Momentum matters (not instant direction switching)
 * - Responsive input (tap feels immediate)
 * - Smooth bounces (arcade physics, not realistic)
 * - Skill-based recovery (wall control = survival)
 * - Game feel is priority (screen shake, trails, rotation)
 * 
 * REPLACES:
 * - Auto left/right looping movement
 * - Simple jump mechanics
 * 
 * IMPLEMENTS:
 * - Physics-driven movement via momentum + bouncing
 * - Bounce reflection system
 * - Input nudges to steer momentum, not flap upward
 * - Input buffering for responsiveness
 * - Timing forgiveness via input buffering
 * - Rotation visual feedback
 * - Game feel effect hooks
 */

import {
  GRAVITY,
  MAX_FALL_SPEED,
  GRAVITY_SCALE,
  FLAP_VY,
  FLAP_HORIZONTAL,
  AIR_CONTROL_POWER,
  MAX_HORIZONTAL_VEL,
  MOMENTUM_DAMPING,
  MOMENTUM_RECOVERY,
  WALL_BOUNCE_ENERGY,
  WALL_DAMPING,
  WALL_BOUNCE_MIN_VEL,
  BOUNCE_REFLECTION_SOFTNESS,
  CEILING_BOUNCE_ENERGY,
  CEILING_EXTRA_GRAVITY,
  CEILING_EXTRA_FRAMES,
  FLOOR_KILLS,
  ROTATION_FROM_VELOCITY,
  ROTATION_FROM_BOUNCE,
  ROTATION_DAMPING,
  ROTATION_MAX,
  INPUT_BUFFER_FRAMES,
  INPUT_QUEUE_SIZE,
  SHAKE_WALL_SCALE,
  SHAKE_CEILING_SCALE,
  SHAKE_VELOCITY_FACTOR,
  SHAKE_DAMPING,
  HIT_PAUSE_WALL,
  HIT_PAUSE_CEILING,
  BOUNCE_ROTATION_SCALE,
  FLAP_ROTATION_AMOUNT,
  TRAIL_LENGTH,
  TRAIL_DECAY,
  PARTICLE_BURST_COUNT,
  ZONE_LEFT,
  ZONE_RIGHT,
  CEILING_Y,
  FLOOR_Y,
  GAME_WIDTH,
  GAME_HEIGHT,
  P_RADIUS_START,
  DRAG_MIN_PX,
  DRAG_MAX_PX,
  LAUNCH_MIN_SPEED,
  LAUNCH_MAX_SPEED,
  NUDGE_ROTATION_AMOUNT,
} from './constants.js'

export class ArcadePhysicsEngine {
  /**
   * Create a new physics engine instance
   * Call this once per game session
   */
  constructor() {
    // ─────────────────────────────────────────────────────────────
    // POSITION & VELOCITY STATE
    // ─────────────────────────────────────────────────────────────
    this.x = GAME_WIDTH / 2        // horizontal position
    this.y = GAME_HEIGHT * 0.42    // vertical position
    // Idle until the first drag/swipe launch — update() returns null while
    // !this.launched, so these starting values never actually get applied
    // to movement (was INITIAL_MOMENTUM_X/Y, constants that belonged only
    // to the old tap/flap model this engine no longer uses).
    this.vx = 0                    // horizontal velocity
    this.vy = 0                    // vertical velocity
    this.radius = P_RADIUS_START   // player radius
    this.launched = false          // stays centered until first input

    // ─────────────────────────────────────────────────────────────
    // DIRECTION & MOMENTUM STATE
    // ─────────────────────────────────────────────────────────────
    this.moveDir = 1               // facing direction (-1 or 1)
    this.momentumDir = 0           // momentum direction influence (-1 to 1)

    // ─────────────────────────────────────────────────────────────
    // ROTATION STATE (Visual feedback)
    // ─────────────────────────────────────────────────────────────
    this.rotation = 0              // current rotation angle
    this.rotationVelocity = 0      // rotation angular velocity
    this.targetRotation = 0        // smooth rotation target

    // ─────────────────────────────────────────────────────────────
    // INPUT RESPONSIVENESS
    // ─────────────────────────────────────────────────────────────
    this.inputBuffer = []          // queued tap inputs
    this.hitPauseTimer = 0         // freeze frame counter

    // ─────────────────────────────────────────────────────────────
    // GAME FEEL HOOKS (Data for rendering system)
    // ─────────────────────────────────────────────────────────────
    this.screenShake = { x: 0, y: 0 }  // screen offset for camera shake
    this.lastBounceType = null         // 'wall' | 'ceiling' | 'floor'
    this.lastImpactVelocity = 0        // magnitude of last impact
    this.lastImpactPosition = { x: 0, y: 0 }

    // ─────────────────────────────────────────────────────────────
    // MOTION TRAILS (For rendering)
    // ─────────────────────────────────────────────────────────────
    this.positionHistory = []      // last N positions for trails

    // Miss penalties gently reduce movement speed and then recover.
    this.speedModifier = 1
    // Anti-cheat/balance parity with the live (backend) launch model — a
    // temporary force penalty after missing a rare orb (see
    // applyMissPenalty). Not yet wired up to any caller on the frontend
    // (no arena/orb-miss code drives it here yet); harmless no-op fields
    // until that's ported too — applyLaunchInput() below already reads
    // them defensively.
    this.missPenaltyFrames = 0
    this.missPenaltyFactor = 1
    // Arena Stage "faster upward roll" hook (see arenaStages.js's
    // launchImpulseMultiplier on the backend) — defaults to no-op (1) until
    // arena-stage economy application is ported to the frontend too.
    this.upwardImpulseMultiplier = 1
    // Pacing hook — GameLogic drives this from DifficultySystem/LevelSystem
    // (see applyLaunchInput below) so a fresh run launches noticeably
    // gentler and ramps up to full LAUNCH_MIN/MAX_SPEED over the same
    // difficulty curve that already ramps orb speed/spawn/gravity. Defaults
    // to no-op (1) so any other caller (tutorial) is unaffected.
    this.difficultySpeedMultiplier = 1

    // ─────────────────────────────────────────────────────────────
    // COLLISION STATE
    // ─────────────────────────────────────────────────────────────
    this.isOnGround = false        // touching solid (used for coyote)
    this.lastCollisionType = null  // for effect triggering

    // ─────────────────────────────────────────────────────────────
    // EXTERNAL FORCES (applied by World Event System)
    // ─────────────────────────────────────────────────────────────
    this.windForceX = 0            // horizontal wind force (px/frame²)
  }

  /**
   * MAIN PHYSICS UPDATE
   * Call this once per frame from game server
   * @param {number} deltaTime - time since last frame (default 1 = 1/60s)
   * @returns {Object} collision events for game logic
   */
  update(deltaTime = 1) {
    // ─────────────────────────────────────────────────────────────
    // FREEZE FRAME CHECK (Hit pause)
    // ─────────────────────────────────────────────────────────────
    if (this.hitPauseTimer > 0) {
      this.hitPauseTimer--
      return null  // Don't update physics while frozen
    }

    // ─────────────────────────────────────────────────────────────
    // PROCESS BUFFERED INPUT
    // ─────────────────────────────────────────────────────────────
    this.processInputBuffer()

    if (!this.launched) {
      return null
    }

    // ─────────────────────────────────────────────────────────────
    // GRAVITY INTEGRATION
    // ─────────────────────────────────────────────────────────────
    const gravity = this.gravityOverride ?? (GRAVITY * GRAVITY_SCALE)
    this.vy = Math.min(this.vy + gravity * deltaTime, MAX_FALL_SPEED)

    // ─────────────────────────────────────────────────────────────
    // MOMENTUM (air damping + subtle recovery toward the velocity
    // ceiling, matching the live drag/swipe launch model — see
    // applyLaunchInput below. Direct damping, no "stabilize back to a
    // base flap speed" — that belonged to the old tap/flap model this
    // replaces, since removed (see the note above applyMissPenalty below).
    // ─────────────────────────────────────────────────────────────
    this.vx *= MOMENTUM_DAMPING
    if (Math.abs(this.vx) < MAX_HORIZONTAL_VEL) {
      this.vx *= MOMENTUM_RECOVERY
    }

    if (this.missPenaltyFrames > 0) {
      this.vx *= this.missPenaltyFactor
      this.vy *= this.missPenaltyFactor
      this.missPenaltyFrames--
    }

    if (this.vx > MAX_HORIZONTAL_VEL) this.vx = MAX_HORIZONTAL_VEL
    if (this.vx < -MAX_HORIZONTAL_VEL) this.vx = -MAX_HORIZONTAL_VEL

    if (Math.abs(this.vx) > 0.001) {
      this.moveDir = this.vx > 0 ? 1 : -1
    }

    // ─────────────────────────────────────────────────────────────
    // WIND FORCE (applied by World Event System)
    // ─────────────────────────────────────────────────────────────
    if (this.windForceX) this.vx += this.windForceX * deltaTime

    // ─────────────────────────────────────────────────────────────
    // POSITION UPDATE (Physics integration)
    // ─────────────────────────────────────────────────────────────
    this.x += this.vx * deltaTime
    this.y += this.vy * deltaTime

    // Safety net for "swipe a few times and the game gets stuck" — if x/y/
    // vx/vy ever go NaN or Infinite (any bad division/edge case anywhere
    // upstream — repeated bounces, a hazard collision, a launch vector),
    // every collision check below compares against a NaN/Infinite value,
    // which is ALWAYS false. That means the spoon can silently sail through
    // the floor (which is supposed to be instant death) or a wall without
    // ever registering, and every frame after just keeps failing the same
    // way — nothing throws, nothing crashes, the spoon just quietly stops
    // being interactable forever. Recovering here (snap back to a safe,
    // finite position/velocity) turns that into "one visible stutter"
    // instead of a permanent freeze.
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y) ||
        !Number.isFinite(this.vx) || !Number.isFinite(this.vy)) {
      console.error('ArcadePhysicsEngine: non-finite state detected, recovering', {
        x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      })
      this.x = GAME_WIDTH / 2
      this.y = GAME_HEIGHT * 0.42
      this.vx = 0
      this.vy = 0
    }

    // ─────────────────────────────────────────────────────────────
    // COLLISION DETECTION & RESPONSE
    // ─────────────────────────────────────────────────────────────
    const collisionEvent = this.checkCollisions()

    // ─────────────────────────────────────────────────────────────
    // ROTATION UPDATE (Visual momentum feedback)
    // ─────────────────────────────────────────────────────────────
    this.updateRotation()

    // ─────────────────────────────────────────────────────────────
    // UPDATE TRAILS & POSITION HISTORY
    // ─────────────────────────────────────────────────────────────
    this.updatePositionHistory()

    // ─────────────────────────────────────────────────────────────
    // UPDATE SCREEN SHAKE
    // ─────────────────────────────────────────────────────────────
    this.updateScreenShake()

    // ─────────────────────────────────────────────────────────────
    return collisionEvent
  }

  /**
   * PROCESS INPUT BUFFER
   * Handle queued drag/swipe launch vectors, matching the live (backend)
   * model — see applyLaunchInput below.
   */
  processInputBuffer() {
    // Age all inputs
    this.inputBuffer = this.inputBuffer.filter((input) => {
      input.age++
      return input.age < INPUT_BUFFER_FRAMES
    })

    // Process one buffered input per frame
    if (this.inputBuffer.length > 0) {
      const input = this.inputBuffer.shift()  // consume input
      this.applyLaunchInput(input)
    }
  }

  /**
   * BUFFER PLAYER INPUT
   * Queue a drag-release / swipe vector for later processing.
   * @param {{dx:number, dy:number}} vector - drag/swipe vector in game-space
   *   px (screen px → game px is converted before this is called), matching
   *   the live (backend) launch model — see applyLaunchInput below.
   */
  bufferInput({ dx = 0, dy = -1 } = {}) {
    if (this.inputBuffer.length < INPUT_QUEUE_SIZE) {
      this.inputBuffer.push({ age: 0, dx, dy })
    }
  }

  /**
   * APPLY DRAG/SWIPE LAUNCH IMPULSE
   * The spoon launches directly along the (dx, dy) vector — same rule for
   * the very first launch and every subsequent one. Distance (clamped) maps
   * to force between LAUNCH_MIN_SPEED and LAUNCH_MAX_SPEED. Mirrors the
   * live backend's ArcadePhysicsEngine.applyLaunchInput exactly, so
   * client-driven movement feels the same as the server-driven model it
   * replaces.
   */
  applyLaunchInput(input) {
    const dx = Number.isFinite(input?.dx) ? input.dx : 0
    const dy = Number.isFinite(input?.dy) ? input.dy : -1

    const rawMagnitude = Math.hypot(dx, dy)
    // Too small to be an intentional drag/swipe — ignore (no launch).
    if (rawMagnitude < DRAG_MIN_PX) return

    const clampedMagnitude = Math.min(rawMagnitude, DRAG_MAX_PX)
    const t = (clampedMagnitude - DRAG_MIN_PX) / Math.max(1, DRAG_MAX_PX - DRAG_MIN_PX)
    const force = LAUNCH_MIN_SPEED + (LAUNCH_MAX_SPEED - LAUNCH_MIN_SPEED) * Math.min(1, Math.max(0, t))
    const effectiveForce = force
      * (this.missPenaltyFrames > 0 ? this.missPenaltyFactor : 1)
      * this.difficultySpeedMultiplier

    const dirX = dx / rawMagnitude
    const dirY = dy / rawMagnitude

    this.launched = true
    this.vx = dirX * effectiveForce
    this.vy = dirY * effectiveForce

    if (this.vy < 0 && this.upwardImpulseMultiplier !== 1) {
      this.vy *= this.upwardImpulseMultiplier
    }

    if (Math.abs(this.vx) > 0.001) {
      this.moveDir = this.vx > 0 ? 1 : -1
    }

    const forceFactor = 0.8 + force / LAUNCH_MAX_SPEED
    // Rotation on launch — handover doc/player report: "the spoon is not
    // rolling upwards anymore... became swiping without the rolling
    // upwards effect." FLAP_ROTATION_AMOUNT is documented in constants.js
    // as "rotation on upward input", but this used to be applied as
    // `-dirX * max(FLAP_ROTATION_AMOUNT, NUDGE_ROTATION_AMOUNT)` — driven
    // entirely by the horizontal component. A straight-up swipe has
    // dirX ≈ 0, so it produced almost no rotation at all: exactly the
    // reported regression. Now horizontal deflection and upward launch
    // strength each contribute their own named rotation component, so a
    // purely vertical swipe still visibly "rolls" (via FLAP_ROTATION_AMOUNT
    // scaled by how upward the launch is, i.e. -dirY), while an angled
    // swipe still gets the existing directional "nudge" roll from dirX.
    const horizontalSpin = -dirX * NUDGE_ROTATION_AMOUNT * forceFactor
    const upwardSpin = dirY < 0
      ? (this.moveDir >= 0 ? -1 : 1) * FLAP_ROTATION_AMOUNT * forceFactor * (-dirY)
      : 0
    this.rotationVelocity = horizontalSpin + upwardSpin
  }

  // NOTE: the old tap/flap "force impulse" input method and its matching
  // "stabilize back to a base flap speed" momentum helper (applyForceImpulse
  // / stabilizeMomentum) have been removed — this engine no longer uses
  // that model at all (see applyLaunchInput above and update()'s direct
  // damping/recovery block), and both referenced constants
  // (BASE_MOMENTUM_SPEED / INITIAL_MOMENTUM_X / SPEED_STABILIZE_RATE) that
  // don't exist in this frontend's constants.js — keeping them around as
  // unreachable dead code broke Vite's dependency scan the moment this file
  // actually got bundled (see GameLogic.js's import of this class).

  applyMissPenalty(multiplier = 0.9) {
    this.speedModifier = Math.max(0.45, this.speedModifier * multiplier)
  }

  /**
   * CHECK ALL COLLISIONS
   * Detects wall, ceiling, floor hits
   * @returns {Object} collision event or null
   */
  checkCollisions() {
    const r = this.radius

    // ─────────────────────────────────────────────────────────────
    // FLOOR COLLISION (DEATH)
    // ─────────────────────────────────────────────────────────────
    if (this.y + r >= FLOOR_Y) {
      this.lastBounceType = 'floor'
      this.lastImpactVelocity = Math.abs(this.vy)
      this.lastImpactPosition = { x: this.x, y: this.y }
      return {
        type: 'death',
        bounceData: null,
      }
    }

    // ─────────────────────────────────────────────────────────────
    // WALL COLLISION (LEFT / RIGHT)
    // ─────────────────────────────────────────────────────────────
    const wallCollision = this.checkWallCollisions()
    if (wallCollision) {
      return wallCollision
    }

    // ─────────────────────────────────────────────────────────────
    // CEILING COLLISION (TOP)
    // ─────────────────────────────────────────────────────────────
    const ceilingCollision = this.checkCeilingCollision()
    if (ceilingCollision) {
      return ceilingCollision
    }

    // Reset coyote if airborne long enough
    return null
  }

  /**
   * CHECK WALL COLLISIONS
   * Left/right boundaries - reflection physics
   */
  checkWallCollisions() {
    const r = this.radius
    let wallHit = false
    let bounceData = null

    // LEFT WALL COLLISION
    if (this.x - r <= ZONE_LEFT) {
      this.x = ZONE_LEFT + r
      wallHit = true
      bounceData = this.bounceOffWall('left')
    }

    // RIGHT WALL COLLISION
    else if (this.x + r >= ZONE_RIGHT) {
      this.x = ZONE_RIGHT - r
      wallHit = true
      bounceData = this.bounceOffWall('right')
    }

    if (wallHit && bounceData) {
      // Update move direction
      this.moveDir = bounceData.newDirection

      // Game feel effects
      this.triggerWallBounceEffects(bounceData)

      return {
        type: 'wall_bounce',
        bounceData,
      }
    }

    return null
  }

  /**
   * WALL BOUNCE PHYSICS
   * Reflection with energy loss
   * @param {'left'|'right'} side
   */
  bounceOffWall(side) {
    const impactVelocity = Math.sqrt(this.vx * this.vx + this.vy * this.vy)

    // Ignore very slow bounces
    if (this.getVelocityMagnitude() < WALL_BOUNCE_MIN_VEL) {
      return null
    }

    // Reflection: reverse X velocity
    this.vx *= -1

    // Energy loss: arcade feel (96% retention = bouncy)
    this.vx *= (WALL_BOUNCE_ENERGY - WALL_DAMPING)
    this.vy *= (WALL_BOUNCE_ENERGY - WALL_DAMPING)

    this.moveDir = side === 'left' ? 1 : -1

    // Rotation from impact
    const rotationAmount = (impactVelocity / 15) * BOUNCE_ROTATION_SCALE
    this.rotationVelocity = (side === 'left' ? 1 : -1) * rotationAmount

    return {
      side,
      impactVelocity,
      newDirection: side === 'left' ? 1 : -1,
      energyLoss: 1 - WALL_BOUNCE_ENERGY,
      newVelocity: { x: this.vx, y: this.vy },
    }
  }

  /**
   * TRIGGER WALL BOUNCE EFFECTS
   * Game feel hooks for rendering
   */
  triggerWallBounceEffects(bounceData) {
    this.lastBounceType = 'wall'
    this.lastImpactVelocity = bounceData.impactVelocity
    this.lastImpactPosition = { x: this.x, y: this.y }

    // Screen shake proportional to impact
    const shakeAmount = bounceData.impactVelocity * SHAKE_VELOCITY_FACTOR
    this.screenShake.x = (Math.random() - 0.5) * SHAKE_WALL_SCALE * shakeAmount
    this.screenShake.y = (Math.random() - 0.5) * SHAKE_WALL_SCALE * shakeAmount

    // Hit pause for hard impacts
    if (bounceData.impactVelocity > 8) {
      this.hitPauseTimer = HIT_PAUSE_WALL
    }
  }

  /**
   * CHECK CEILING COLLISION
   * Top boundary - heavy damping
   */
  checkCeilingCollision() {
    const r = this.radius

    // Only collide if moving upward
    if (this.y - r > CEILING_Y || this.vy >= 0) {
      return null
    }

    this.y = CEILING_Y + r

    const impactVelocity = Math.abs(this.vy)

    // Reflect downward
    this.vy = Math.abs(this.vy)

    // Heavy energy loss on ceiling (prevents camping)
    this.vx *= CEILING_BOUNCE_ENERGY
    this.vy *= CEILING_BOUNCE_ENERGY

    // Strong rotation feedback
    this.rotationVelocity = -this.moveDir * BOUNCE_ROTATION_SCALE * 1.5

    // Game feel effects
    this.lastBounceType = 'ceiling'
    this.lastImpactVelocity = impactVelocity
    this.lastImpactPosition = { x: this.x, y: this.y }

    // Bigger screen shake
    const shakeAmount = impactVelocity * SHAKE_VELOCITY_FACTOR
    this.screenShake.x = (Math.random() - 0.5) * SHAKE_CEILING_SCALE * shakeAmount
    this.screenShake.y = (Math.random() - 0.5) * SHAKE_CEILING_SCALE * shakeAmount

    // Always freeze on ceiling
    this.hitPauseTimer = HIT_PAUSE_CEILING

    return {
      type: 'ceiling_bounce',
      impactVelocity,
      energyLoss: 1 - CEILING_BOUNCE_ENERGY,
      newVelocity: { x: this.vx, y: this.vy },
    }
  }

  /**
   * UPDATE ROTATION
   * Smooth rotation based on velocity and bounces
   */
  updateRotation() {
    // Rotation from horizontal velocity
    const velocityRotation = (this.vx / MAX_HORIZONTAL_VEL) * ROTATION_FROM_VELOCITY

    // Blend toward target rotation
    const targetRot = Math.max(-ROTATION_MAX, Math.min(ROTATION_MAX, velocityRotation))
    this.rotation += (targetRot - this.rotation) * 0.1

    // Bounce-induced rotation (angular momentum)
    this.rotation += this.rotationVelocity
    this.rotationVelocity *= ROTATION_DAMPING
  }

  /**
   * UPDATE POSITION HISTORY
   * For motion trail rendering
   */
  updatePositionHistory() {
    this.positionHistory.push({ x: this.x, y: this.y, age: 0 })

    // Trim and age history
    if (this.positionHistory.length > TRAIL_LENGTH) {
      this.positionHistory.shift()
    }

    this.positionHistory.forEach((pos) => {
      pos.age++
    })
  }

  /**
   * UPDATE SCREEN SHAKE
   * Decay shake effect over time
   */
  updateScreenShake() {
    this.screenShake.x *= SHAKE_DAMPING
    this.screenShake.y *= SHAKE_DAMPING

    // Clamp to avoid precision issues
    if (Math.abs(this.screenShake.x) < 0.1) this.screenShake.x = 0
    if (Math.abs(this.screenShake.y) < 0.1) this.screenShake.y = 0
  }

  /**
   * CHECK COLLECTIBLE COLLISION
   * Circle-circle collision detection
   */
  checkCollectibleCollision(collectible) {
    const dx = this.x - collectible.x
    const dy = this.y - collectible.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    return distance < this.radius + collectible.r
  }

  /**
   * CHECK OBSTACLE COLLISION
   * Circle-rectangle collision
   */
  checkObstacleCollision(obstacle) {
    const closestX = Math.max(obstacle.x, Math.min(this.x, obstacle.x + obstacle.w))
    const closestY = Math.max(obstacle.y, Math.min(this.y, obstacle.y + obstacle.h))

    const dx = this.x - closestX
    const dy = this.y - closestY
    const distance = Math.sqrt(dx * dx + dy * dy)

    return distance < this.radius
  }

  /**
   * GET CURRENT STATE
   * For rendering and synchronization
   */
  getState() {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      radius: this.radius,
      moveDir: this.moveDir,
      rotation: this.rotation,
      screenShake: { ...this.screenShake },
      positionHistory: this.positionHistory.map((p) => ({ x: p.x, y: p.y, alpha: 1 - p.age / TRAIL_LENGTH })),
      lastBounceType: this.lastBounceType,
      lastImpactVelocity: this.lastImpactVelocity,
    }
  }

  /**
   * SET STATE
   * For external updates or synchronization
   */
  setState(state) {
    if (state.x !== undefined) this.x = state.x
    if (state.y !== undefined) this.y = state.y
    if (state.vx !== undefined) this.vx = state.vx
    if (state.vy !== undefined) this.vy = state.vy
    if (state.radius !== undefined) this.radius = state.radius
    if (state.moveDir !== undefined) this.moveDir = state.moveDir
  }

  /**
   * APPLY DAMAGE
   * Shrink player on obstacle hit
   */
  applyDamage(amount = 4) {
    this.radius = Math.max(this.radius - amount, P_RADIUS_START / 2)
  }

  /**
   * RESET PHYSICS STATE
   * For new game/restart
   */
  reset() {
    this.x = GAME_WIDTH / 2
    this.y = GAME_HEIGHT * 0.42
    this.vx = 0
    this.vy = 0
    this.rotation = 0
    this.rotationVelocity = 0
    this.moveDir = 1
    this.inputBuffer = []
    this.hitPauseTimer = 0
    this.screenShake = { x: 0, y: 0 }
    this.positionHistory = []
    this.launched = false
    this.windForceX = 0
    this.speedModifier = 1
  }

  /**
   * GET VELOCITY MAGNITUDE
   * For VFX scaling
   */
  getVelocityMagnitude() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy)
  }

  /**
   * GET BOUNCE PARTICLE COUNT
   * Scales with impact intensity
   */
  getBounceParticleCount() {
    const baseCount = PARTICLE_BURST_COUNT
    const intensityBonus = Math.floor(this.lastImpactVelocity / 5)
    return baseCount + intensityBonus
  }
}

export default ArcadePhysicsEngine

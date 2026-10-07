import { TRAIL_LENGTH, TRAIL_DECAY } from './constants.js'

/**
 * BOUNCE EFFECTS SYSTEM
 *
 * Provides visual juice and feedback:
 * - Motion trails following the spoon
 * - Impact glow effects
 * - Bounce indicators
 * - Trail particles
 */

export class BounceEffects {
  constructor() {
    this.motionTrail = [] // Last N positions for trail rendering
    this.trailDots = [] // Individual trail particles
    this.impactGlows = [] // Bounce impact glows
    this.bounceIndicators = [] // Text/indicators for bounces
  }

  /**
   * Update motion trail with new position
   */
  updateMotionTrail(x, y, velocityMagnitude) {
    this.motionTrail.push({ x, y, age: 0 })

    // Trim trail to max length
    if (this.motionTrail.length > TRAIL_LENGTH) {
      this.motionTrail.shift()
    }

    // Age all trail points
    this.motionTrail.forEach((point) => {
      point.age++
    })
  }

  /**
   * Create impact glow on bounce
   */
  createImpactGlow(x, y, bounceType, intensity = 1.0) {
    let glowColor = '#44ccff'
    let glowSize = 30 * intensity
    let duration = 12

    if (bounceType === 'wall_bounce') {
      glowColor = '#55ddff'
      glowSize = 24 * intensity
      duration = 8
    } else if (bounceType === 'ceiling_bounce') {
      glowColor = '#ff99dd'
      glowSize = 40 * intensity
      duration = 12
    }

    this.impactGlows.push({
      x,
      y,
      color: glowColor,
      size: glowSize,
      maxSize: glowSize * 2.5,
      duration,
      maxDuration: duration,
      age: 0,
    })
  }

  /**
   * Create trail particles around bounce point
   */
  createTrailParticles(x, y, bounceType, count = 5) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4
      const speed = 1.5 + Math.random() * 1.5
      const vx = Math.cos(angle) * speed
      const vy = Math.sin(angle) * speed

      let color = '#55ddff'
      if (bounceType === 'ceiling_bounce') {
        color = '#ff99dd'
      }

      this.trailDots.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx,
        vy,
        color,
        lifetime: 20 + Math.random() * 10,
        age: 0,
        size: 1.5 + Math.random(),
      })
    }
  }

  /**
   * Add bounce indicator text (like "+10" or "Wall Bounce!")
   */
  createBounceIndicator(x, y, text, bounceType) {
    let color = '#55ddff'
    if (bounceType === 'ceiling_bounce') {
      color = '#ff99dd'
    }

    this.bounceIndicators.push({
      x,
      y,
      text,
      color,
      lifetime: 40,
      age: 0,
      vx: (Math.random() - 0.5) * 1,
      vy: -1.5 - Math.random() * 0.5,
    })
  }

  /**
   * Update all effects
   */
  update() {
    // Update impact glows
    this.impactGlows = this.impactGlows.filter((glow) => {
      glow.age++
      return glow.age < glow.maxDuration
    })

    // Update trail particles
    this.trailDots = this.trailDots.filter((dot) => {
      dot.age++
      dot.x += dot.vx
      dot.y += dot.vy
      dot.vy += 0.15 // gravity
      return dot.age < dot.lifetime
    })

    // Update bounce indicators
    this.bounceIndicators = this.bounceIndicators.filter((indicator) => {
      indicator.age++
      indicator.x += indicator.vx
      indicator.y += indicator.vy
      return indicator.age < indicator.lifetime
    })
  }

  /**
   * Get trail points for rendering
   */
  getTrailPoints() {
    return this.motionTrail.map((point) => ({
      ...point,
      alpha: 1 - point.age / TRAIL_LENGTH,
    }))
  }

  /**
   * Get glow effects for rendering
   */
  getGlowEffects() {
    return this.impactGlows.map((glow) => ({
      ...glow,
      currentSize: glow.size + ((glow.maxSize - glow.size) * glow.age) / glow.maxDuration,
      alpha: 1 - glow.age / glow.maxDuration,
    }))
  }

  /**
   * Get trail particles for rendering
   */
  getTrailParticles() {
    return this.trailDots.map((dot) => ({
      ...dot,
      alpha: 1 - dot.age / dot.lifetime,
    }))
  }

  /**
   * Get bounce text indicators
   */
  getBounceIndicators() {
    return this.bounceIndicators.map((indicator) => ({
      ...indicator,
      alpha: 1 - indicator.age / indicator.lifetime,
    }))
  }

  /**
   * Clear all effects
   */
  reset() {
    this.motionTrail = []
    this.trailDots = []
    this.impactGlows = []
    this.bounceIndicators = []
  }
}

export default BounceEffects

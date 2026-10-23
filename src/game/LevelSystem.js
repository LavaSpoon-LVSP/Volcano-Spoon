/**
 * LEVEL SYSTEM
 * Data-driven progression controlling orb unlocks and spawn balancing.
 * Configured in strict accordance with the official Full Orb System specification.
 */

// RARITY (Orbs document labels) -> spawn frequency. Weights below were set so that, in every level,
//   common orbs (Lava, Turbo, Shield, Combo, Bad Rock, Fire Wall) spawn more often than
//   uncommon (Magnet, Freeze, Rose, Black, Electric, Gravity), which spawn more often than
//   rare (Chaos, Sun Flame), which spawn more often than the top tier (Diamond, Mythic, Jackpot).
// Lava share and the total hazard share per level were kept as before (difficulty ramp unchanged).
// Verified by scripts/orb_spec_check.js (seeded simulation, hard-fails on any rarity inversion).

const HAZARD_TYPES = new Set(['bad_rock', 'fire_wall', 'chaos', 'black'])
const SUPPORT_TYPES = new Set(['freeze', 'shield', 'magnet', 'gravity', 'turbo', 'combo', 'rose', 'sun_flame', 'electric'])

const LEVELS = [
  {
    level: 1,
    name: 'Warmup',
    minScore: 0,
    // Full Orb System doc: Lava, Turbo, Shield, Bad Rock, Fire Wall unlock from Level 1
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall'],
    spawnWeights: { lava: 72.69, turbo: 7.86, shield: 5.89, bad_rock: 6.88, fire_wall: 4.91 },
    spawnIntervalMultiplier: 1.18,
    speedMultiplier: 0.88,
    gravityMultiplier: 0.94,
    maxActiveOrbs: 10,
    hazardMultiplier: 0.45,
    supportMultiplier: 1.6,
  },
  {
    level: 2,
    name: 'Cooling Window',
    minScore: 120,
    // Full Orb System doc: Combo and Rose unlock from Level 2
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose'],
    spawnWeights: { lava: 59.1, turbo: 7.77, shield: 6.66, bad_rock: 7.63, fire_wall: 5.72, combo: 6.66, rose: 1.78 },
    spawnIntervalMultiplier: 1.0,
    speedMultiplier: 1.0,
    gravityMultiplier: 0.98,
    maxActiveOrbs: 13,
    hazardMultiplier: 0.75,
    supportMultiplier: 1.35,
  },
  {
    level: 3,
    name: 'Magnetic Drift',
    minScore: 280,
    // Full Orb System doc: Magnet, Black Orb, and Diamond unlock from Level 3
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond'],
    spawnWeights: { lava: 50.42, turbo: 9.28, shield: 7.86, bad_rock: 7.83, fire_wall: 5.87, combo: 7.15, rose: 1.92, magnet: 1.92, black: 4.49, diamond: 0.24 },
    spawnIntervalMultiplier: 1.0,
    speedMultiplier: 0.97,
    gravityMultiplier: 1.0,
    maxActiveOrbs: 12,
    hazardMultiplier: 0.78,
    supportMultiplier: 1.25,
  },
  {
    level: 4,
    name: 'Thermal Shift',
    minScore: 500,
    // Full Orb System doc: Freeze, Chaos, Sun Flame, and Electric Shock unlock from Level 4
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond', 'freeze', 'chaos', 'sun_flame', 'electric'],
    spawnWeights: { lava: 38.69, turbo: 9.95, shield: 8.21, bad_rock: 10.11, fire_wall: 7.59, combo: 7.35, rose: 2.07, magnet: 2.07, black: 3.89, diamond: 0.29, freeze: 2.07, chaos: 1.33, sun_flame: 1.03, electric: 2.07 },
    spawnIntervalMultiplier: 0.94,
    speedMultiplier: 1.02,
    gravityMultiplier: 1.03,
    maxActiveOrbs: 13,
    hazardMultiplier: 0.9,
    supportMultiplier: 1.16,
  },
  {
    level: 5,
    name: 'Gravity Cracks',
    minScore: 800,
    // Full Orb System doc: Gravity, Mythic, and Jackpot unlock from Level 5 (full 17-orb roster active)
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond', 'freeze', 'chaos', 'sun_flame', 'electric', 'gravity', 'mythic', 'jackpot'],
    spawnWeights: { lava: 33.6, turbo: 10.37, shield: 7.73, bad_rock: 11.63, fire_wall: 7.76, combo: 7.73, rose: 2.24, magnet: 2.24, black: 3.43, diamond: 0.3, freeze: 2.24, chaos: 1.18, sun_flame: 1.12, electric: 2.24, gravity: 2.24, mythic: 0.3, jackpot: 0.5 },
    spawnIntervalMultiplier: 0.88,
    speedMultiplier: 1.06,
    gravityMultiplier: 1.06,
    maxActiveOrbs: 14,
    hazardMultiplier: 1.02,
    supportMultiplier: 1.07,
  },
  {
    level: 6,
    name: 'Fortune Faultline',
    minScore: 1200,
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond', 'freeze', 'chaos', 'sun_flame', 'electric', 'gravity', 'mythic', 'jackpot'],
    spawnWeights: { lava: 29.21, turbo: 9.34, shield: 7.27, bad_rock: 14.26, fire_wall: 9.98, combo: 6.57, rose: 2.4, magnet: 2.4, black: 2.97, diamond: 0.3, freeze: 2.4, chaos: 1.02, sun_flame: 1.2, electric: 2.4, gravity: 2.4, mythic: 0.3, jackpot: 0.5 },
    spawnIntervalMultiplier: 0.82,
    speedMultiplier: 1.1,
    gravityMultiplier: 1.08,
    maxActiveOrbs: 15,
    hazardMultiplier: 1.18,
    supportMultiplier: 1.0,
  },
  {
    level: 7,
    name: 'Chaotic Rift',
    minScore: 1700,
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond', 'freeze', 'chaos', 'sun_flame', 'electric', 'gravity', 'mythic', 'jackpot'],
    spawnWeights: { lava: 24.97, turbo: 7.45, shield: 5.9, bad_rock: 17.42, fire_wall: 11.62, combo: 5.9, rose: 2.53, magnet: 2.53, black: 2.69, diamond: 0.3, freeze: 2.53, chaos: 0.92, sun_flame: 1.26, electric: 2.53, gravity: 2.53, mythic: 0.3, jackpot: 0.5 },
    spawnIntervalMultiplier: 0.76,
    speedMultiplier: 1.14,
    gravityMultiplier: 1.1,
    maxActiveOrbs: 16,
    hazardMultiplier: 1.3,
    supportMultiplier: 0.95,
  },
  {
    level: 8,
    name: 'Mythic Pressure',
    minScore: 2400,
    unlocks: ['lava', 'turbo', 'shield', 'bad_rock', 'fire_wall', 'combo', 'rose', 'magnet', 'black', 'diamond', 'freeze', 'chaos', 'sun_flame', 'electric', 'gravity', 'mythic', 'jackpot'],
    spawnWeights: { lava: 21.47, turbo: 6.47, shield: 5.63, bad_rock: 19.64, fire_wall: 12.08, combo: 5.42, rose: 2.67, magnet: 2.67, black: 2.54, diamond: 0.3, freeze: 2.67, chaos: 0.87, sun_flame: 1.33, electric: 2.67, gravity: 2.67, mythic: 0.3, jackpot: 0.5 },
    spawnIntervalMultiplier: 0.7,
    speedMultiplier: 1.18,
    gravityMultiplier: 1.12,
    maxActiveOrbs: 18,
    hazardMultiplier: 1.38,
    supportMultiplier: 0.9,
  },
]

export class LevelSystem {
  constructor(levels = LEVELS) {
    this.levels = [...levels].sort((a, b) => a.minScore - b.minScore)
    this.reset()
  }

  reset() {
    this.currentIndex = 0
  }

  update(score) {
    let idx = this.currentIndex
    for (let i = 0; i < this.levels.length; i++) {
      if (score >= this.levels[i].minScore) idx = i
      else break
    }
    this.currentIndex = idx
  }

  getCurrentLevel() {
    return this.levels[this.currentIndex]
  }

  getSpawnProfile({ hazardWeightBoost = 1, struggling = false } = {}) {
    const level = this.getCurrentLevel()
    const unlocked = new Set(level.unlocks)

    const hazardMult = (level.hazardMultiplier ?? 1) * hazardWeightBoost * (struggling ? 0.65 : 1)
    const supportMult = (level.supportMultiplier ?? 1) * (struggling ? 1.5 : 1)

    const spawnWeights = {}
    Object.entries(level.spawnWeights).forEach(([type, weight]) => {
      if (!unlocked.has(type)) {
        spawnWeights[type] = 0
        return
      }
      let nextWeight = weight
      if (HAZARD_TYPES.has(type)) nextWeight *= hazardMult
      if (SUPPORT_TYPES.has(type)) nextWeight *= supportMult
      spawnWeights[type] = Math.max(0, nextWeight)
    })

    return {
      unlockedTypes: [...unlocked],
      spawnWeights,
      spawnIntervalMultiplier: level.spawnIntervalMultiplier ?? 1,
      speedMultiplier: level.speedMultiplier ?? 1,
      gravityMultiplier: level.gravityMultiplier ?? 1,
      maxActiveOrbs: level.maxActiveOrbs ?? 20,
      level: level.level,
      levelName: level.name,
    }
  }

  getState(score) {
    const current = this.getCurrentLevel()
    const next = this.levels[this.currentIndex + 1] ?? null
    const from = current.minScore
    const to = next?.minScore ?? from + 1000
    const progress = to > from ? Math.min(1, Math.max(0, (score - from) / (to - from))) : 1

    return {
      level: current.level,
      name: current.name,
      minScore: from,
      nextMinScore: next?.minScore ?? null,
      progress,
      unlockedTypes: [...current.unlocks],
      isMaxLevel: !next,
    }
  }
}

export default LevelSystem

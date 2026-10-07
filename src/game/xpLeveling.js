/**
 * ACCOUNT LEVEL — derived purely from persistent Total XP.
 *
 * This is a NEW, lightweight display-only convention introduced for the
 * profile's "Current Account Level" / "XP required for next level" fields
 * (see the Persistent XP System spec). It is NOT the same thing as the
 * per-match `LevelSystem` (src/game/LevelSystem.js), which drives in-run
 * orb-spawn difficulty and resets every game — this module never touches
 * that system, GameLogic, scoring, or rewards in any way.
 *
 * Formula: a flat XP_PER_LEVEL per level (simplest possible curve that
 * satisfies "Current Account Level" + "XP required for next level"). Easy
 * to swap for a curve later — every consumer goes through
 * getAccountLevelInfo() below, so the formula only needs to change here.
 */
const XP_PER_LEVEL = 1000

/**
 * @param {number} totalXp
 * @returns {{
 *   accountLevel: number,
 *   xpIntoCurrentLevel: number,
 *   xpForNextLevel: number,
 *   xpNeededForNextLevel: number,
 *   progress: number,
 * }}
 */
export function getAccountLevelInfo(totalXp) {
  const xp = Math.max(0, Number(totalXp) || 0)
  const accountLevel = Math.floor(xp / XP_PER_LEVEL) + 1
  const xpIntoCurrentLevel = xp % XP_PER_LEVEL
  const xpForNextLevel = XP_PER_LEVEL
  const xpNeededForNextLevel = xpForNextLevel - xpIntoCurrentLevel
  const progress = xpIntoCurrentLevel / xpForNextLevel

  return {
    accountLevel,
    xpIntoCurrentLevel,
    xpForNextLevel,
    xpNeededForNextLevel,
    progress,
  }
}

export default getAccountLevelInfo

/**
 * ARTIFACT PERKS — server-derived, per game/GameLogic.js's five NFT-artifact
 * perk flags (healRegen, pickupRadiusBonus, comboDurationBonus,
 * hazardVisibility, comboStabilize — see constants.js's "NFT ARTIFACT
 * PERKS" section for what each one actually does numerically).
 *
 * Before this file, ClientSession trusted whatever `perks` object the
 * client sent in its 'game:start'/'game:restart' message outright (see the
 * removed _applyArtifactPerks(perks) — its own doc comment used to say
 * "there's no server-side ownership record yet," which was actually wrong:
 * User.ownedNftIds/activeNftIds (see models/User.js, routes/nfts.js) is
 * exactly that record, just never consulted here). A forged client could
 * claim any perk regardless of what it actually owned.
 *
 * This is the fix (A18, reviewed handover): "Derive eligibility from
 * server ownership and the active selection, not client flags." A perk is
 * only ever active if the player owns (User.ownedNftIds) AND has switched
 * on (User.activeNftIds — the same per-NFT active/inactive toggle the
 * Profile page's "Set Active"/"Deactivate" button drives, PATCH
 * /api/nfts/:id/active) a catalog Nft ("Artifact") whose `perkKey` matches.
 */
import { User } from '../models/User.js'
import { Nft, PERK_KEYS } from '../models/Nft.js'

function emptyPerks() {
  const perks = {}
  for (const key of PERK_KEYS) perks[key] = false
  return perks
}

/**
 * Returns the live, server-truth perk flags for a given userId. Safe to
 * call with a missing/invalid userId (returns all-false rather than
 * throwing) so a caller never has to special-case an unauthenticated or
 * not-yet-loaded session.
 */
export async function deriveArtifactPerksForUser(userId) {
  const perks = emptyPerks()
  if (!userId) return perks

  const user = await User.findById(userId).select('ownedNftIds activeNftIds')
  if (!user) return perks

  const ownedSet = new Set(user.ownedNftIds ?? [])
  const activeIds = (user.activeNftIds ?? []).filter((id) => ownedSet.has(id))
  if (activeIds.length === 0) return perks

  const artifacts = await Nft.find({ _id: { $in: activeIds }, perkKey: { $in: PERK_KEYS } }).select('perkKey')
  for (const artifact of artifacts) {
    if (artifact.perkKey && Object.prototype.hasOwnProperty.call(perks, artifact.perkKey)) {
      perks[artifact.perkKey] = true
    }
  }
  return perks
}

export default { deriveArtifactPerksForUser }

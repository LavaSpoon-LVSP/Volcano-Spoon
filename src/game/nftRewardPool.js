import { randomInt } from 'crypto'
import { NftCollection } from '../models/NftCollection.js'
import { NftMint } from '../models/NftMint.js'

/**
 * Generic core for "draw and atomically reserve one real, on-chain NFT
 * from a per-collection reward budget". Shared by every feature that hands
 * out real blockchain NFTs as a random reward — currently:
 *   - game/jackpotNftReward.js  → the purchasable Jackpot Orb (routes/
 *     jackpot.js) AND the natural in-game jackpot orb pickup (game/
 *     ClientSession.js), which share ONE budget
 *     (NftCollection.jackpotEligible/jackpotRewardQuantity/
 *     jackpotRewardsGranted)
 *   - game/slotNftReward.js     → the Jackpot Slot Machine (routes/
 *     slotMachine.js), which has its OWN separate budget
 *     (NftCollection.slotEligible/slotRewardQuantity/slotRewardsGranted)
 *
 * Each system needs its own independent quota even though every system
 * draws from the exact same underlying `in_admin_wallet` NftMint stock
 * pool (the same pool direct-sale publishing also draws from) — that's why
 * this takes the three field names as parameters rather than hardcoding
 * one system's fields, and why a collection can be opted into one, both,
 * or neither reward system independently.
 *
 * On a win, this only RESERVES the NFT (marks the NftMint 'sold',
 * ownerUserId = userId) — it does NOT send the on-chain transfer. Sending a
 * real NFT requires a destination wallet, which the winner may not have
 * connected yet, so the actual transfer happens later, when the player
 * claims it (see each caller's own claim endpoint).
 *
 * Returns `{ mintAddress, collectionMintAddress, name, image }` on a win,
 * or `null` if nothing is currently eligible/available (every eligible
 * collection is either quota-exhausted, out of in_admin_wallet stock, or
 * already owned by this player — a player can only ever own one NFT per
 * collection, same rule as a direct purchase).
 *
 * @param {string} userId
 * @param {{ eligibleField: string, quantityField: string, grantedField: string }} fields
 *   The NftCollection field names for this reward system's opt-in flag,
 *   total budget, and running granted-count.
 */
export async function drawCollectionNftReward(userId, { eligibleField, quantityField, grantedField }) {
  const ownedCollections = await NftMint.find({ ownerUserId: userId, status: 'sold' }).distinct('collectionMintAddress')

  const eligibleCollections = await NftCollection.find({
    [eligibleField]: true,
    collectionMintAddress: { $nin: ownedCollections },
    $expr: { $lt: [`$${grantedField}`, `$${quantityField}`] },
  })
  if (!eligibleCollections.length) return null

  // Shuffle so a collection early in Mongo's natural order isn't always
  // tried (and drained) first. Fisher-Yates using crypto.randomInt (not
  // Math.random) so which collection gets tried first for a real,
  // real-money NFT draw isn't predictable/riggable, matching the same
  // crypto RNG standard already used for jackpot.js/slotMachine.js draws.
  const shuffled = [...eligibleCollections]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  for (const collection of shuffled) {
    // Reserve a quota slot atomically FIRST (guarded so it can never exceed
    // the quantity field even under concurrent draws) — only after that
    // succeeds do we go looking for an actual mint to hand out. If nothing
    // is in stock, the slot is released back below rather than being
    // silently burned for nothing.
    const claimedCollection = await NftCollection.findOneAndUpdate(
      { _id: collection._id, $expr: { $lt: [`$${grantedField}`, `$${quantityField}`] } },
      { $inc: { [grantedField]: 1 } },
      { new: true }
    )
    if (!claimedCollection) continue // quota just filled by a concurrent draw — try the next collection

    const candidateMints = await NftMint.find({
      collectionMintAddress: collection.collectionMintAddress,
      status: 'in_admin_wallet',
    })
    if (!candidateMints.length) {
      await NftCollection.findByIdAndUpdate(collection._id, { $inc: { [grantedField]: -1 } })
      continue
    }

    // crypto.randomInt instead of Math.random — same reasoning as the
    // shuffle above: this decides which specific NFT a player receives.
    const pickedMint = candidateMints[randomInt(0, candidateMints.length)]

    let mint
    try {
      mint = await NftMint.findOneAndUpdate(
        { _id: pickedMint._id, status: 'in_admin_wallet' },
        { $set: { status: 'sold', ownerUserId: userId, soldAt: new Date() } },
        { new: true }
      )
    } catch (raceError) {
      if (raceError?.code !== 11000) throw raceError
      mint = null // lost a race against a direct purchase, or somehow already owns this collection
    }
    if (!mint) {
      await NftCollection.findByIdAndUpdate(collection._id, { $inc: { [grantedField]: -1 } })
      continue
    }

    return {
      mintAddress: mint.mintAddress,
      collectionMintAddress: mint.collectionMintAddress,
      name: mint.name,
      image: mint.image,
    }
  }

  return null
}

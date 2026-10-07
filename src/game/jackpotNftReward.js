import { drawCollectionNftReward } from './nftRewardPool.js'

/**
 * Draws (and atomically reserves) one real, on-chain NFT as a Jackpot
 * reward for `userId`. Shared by BOTH NFT-reward paths in this codebase:
 * the purchasable Jackpot Orb (routes/jackpot.js's POST /use) and the
 * natural in-game jackpot orb pickup (game/ClientSession.js's
 * _handleJackpotNftReward). Both draw from the exact same pool — real
 * blockchain NFT Collections an admin has explicitly opted into jackpot
 * rewards (NftCollection.jackpotEligible + jackpotRewardQuantity) — never
 * from the manual/admin-curated catalog (models/Nft.js), which is reserved
 * for the artifact-perk marketplace.
 *
 * The Jackpot Slot Machine (a separate feature — see game/slotNftReward.js)
 * draws real NFTs the same way but from its OWN independent budget
 * (NftCollection.slotEligible/slotRewardQuantity/slotRewardsGranted), so a
 * collection can be opted into either, both, or neither reward system.
 * See nftRewardPool.js's drawCollectionNftReward for the shared mechanics.
 *
 * On a win, this only RESERVES the NFT (marks the NftMint 'sold',
 * ownerUserId = userId) — it does NOT send the on-chain transfer. Sending a
 * real NFT requires a destination wallet, which the winner may not have
 * connected yet, so the actual transfer happens later, when the player
 * claims it (mirrors how an LSVP reward win only records the amount, and
 * the real transfer happens at claim time — see routes/jackpot.js's POST
 * /claim/:transactionId, which handles both reward types).
 *
 * Returns `{ mintAddress, collectionMintAddress, name, image }` on a win,
 * or `null` if nothing is currently eligible/available (every eligible
 * collection is either quota-exhausted, out of in_admin_wallet stock, or
 * already owned by this player — a player can only ever own one NFT per
 * collection, same rule as a direct purchase).
 */
export async function drawJackpotNftReward(userId) {
  return drawCollectionNftReward(userId, {
    eligibleField: 'jackpotEligible',
    quantityField: 'jackpotRewardQuantity',
    grantedField: 'jackpotRewardsGranted',
  })
}

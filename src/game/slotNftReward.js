import { drawCollectionNftReward } from './nftRewardPool.js'

/**
 * Draws (and atomically reserves) one real, on-chain NFT as a Jackpot Slot
 * Machine reward for `userId` (routes/slotMachine.js's POST /spin). Draws
 * from real blockchain NFT Collections an admin has explicitly opted into
 * SLOT rewards (NftCollection.slotEligible + slotRewardQuantity) — never
 * from the manual/admin-curated catalog (models/Nft.js), which is reserved
 * for the artifact-perk marketplace.
 *
 * This is a SEPARATE budget from the Jackpot Orb's NFT reward (see
 * game/jackpotNftReward.js) — a collection can be opted into either, both,
 * or neither, with independent quotas — even though both draw from the
 * same underlying `in_admin_wallet` NftMint stock. See nftRewardPool.js's
 * drawCollectionNftReward for the shared mechanics.
 *
 * On a win, this only RESERVES the NFT (marks the NftMint 'sold',
 * ownerUserId = userId) — it does NOT send the on-chain transfer. Sending a
 * real NFT requires a destination wallet, which the winner may not have
 * connected yet, so the actual transfer happens later, when the player
 * claims it (see routes/slotMachine.js's POST /claim/:transactionId).
 *
 * Returns `{ mintAddress, collectionMintAddress, name, image }` on a win,
 * or `null` if nothing is currently eligible/available.
 */
export async function drawSlotNftReward(userId) {
  return drawCollectionNftReward(userId, {
    eligibleField: 'slotEligible',
    quantityField: 'slotRewardQuantity',
    grantedField: 'slotRewardsGranted',
  })
}

/**
 * NFT RESERVATION — real server-side "Reserved" state (checklist F3).
 *
 * Lifecycle seen by a buyer: AVAILABLE -> RESERVED (this module) -> TRANSFER
 * IN PROGRESS -> DELIVERED. A reservation holds ONE published mint for ONE
 * player for RESERVATION_TTL_MS while they pay, so two players can never be
 * told they can both buy the last copy.
 *
 * Every state change is a single atomic findOneAndUpdate/updateMany on one
 * NftMint document, so concurrent requests cannot both win a mint. An
 * expired reservation (reservedUntil <= now) is simply treated as free — no
 * cleanup job is needed and a crashed buyer never locks stock forever.
 *
 * All functions take the NftMint model as a parameter so the exact same code
 * is unit-tested against an in-memory fake (scripts/test_nft_reservation.js)
 * and runs against Mongoose in production.
 */

export const RESERVATION_TTL_MS = Number(process.env.NFT_RESERVATION_TTL_MS) || 3 * 60 * 1000

/** A published mint nobody currently holds a live reservation on. */
export function unreservedFilter(collectionMintAddress, now) {
  return {
    collectionMintAddress,
    status: 'published',
    $or: [{ reservedUntil: null }, { reservedUntil: { $lte: now } }],
  }
}

/** Reserve one copy for `userId`. Extends the user's own live reservation instead of taking a second copy. */
export async function reserveMint({ NftMint, collectionMintAddress, userId, now = new Date(), ttlMs = RESERVATION_TTL_MS }) {
  const until = new Date(now.getTime() + ttlMs)
  const own = await NftMint.findOneAndUpdate(
    { collectionMintAddress, status: 'published', reservedBy: userId, reservedUntil: { $gt: now } },
    { $set: { reservedUntil: until } },
    { new: true }
  )
  if (own) return { mint: own, reservedUntil: until, extended: true }
  const mint = await NftMint.findOneAndUpdate(
    unreservedFilter(collectionMintAddress, now),
    { $set: { reservedBy: userId, reservedUntil: until } },
    { new: true }
  )
  return mint ? { mint, reservedUntil: until, extended: false } : null
}

/** Give back the user's reservation(s) in one collection (payment cancelled/failed). */
export async function releaseReservation({ NftMint, collectionMintAddress, userId }) {
  return NftMint.updateMany(
    { collectionMintAddress, status: 'published', reservedBy: userId },
    { $set: { reservedBy: null, reservedUntil: null } }
  )
}

/**
 * Claim one mint for a VERIFIED payment: the user's own live reservation
 * first, otherwise any unreserved copy. Copies reserved by someone else are
 * never taken. Returns null when nothing is claimable.
 */
export async function claimMintForSale({ NftMint, collectionMintAddress, userId, now = new Date() }) {
  const sold = { $set: { status: 'sold', ownerUserId: userId, soldAt: now, reservedBy: null, reservedUntil: null } }
  const own = await NftMint.findOneAndUpdate(
    { collectionMintAddress, status: 'published', reservedBy: userId, reservedUntil: { $gt: now } },
    sold,
    { new: true }
  )
  if (own) return own
  return NftMint.findOneAndUpdate(unreservedFilter(collectionMintAddress, now), sold, { new: true })
}

/** Counts for the shop card: what this viewer can buy, what others are holding. */
export async function stockSummary({ NftMint, collectionMintAddress, userId = null, now = new Date() }) {
  const free = await NftMint.countDocuments(unreservedFilter(collectionMintAddress, now))
  const live = { collectionMintAddress, status: 'published', reservedUntil: { $gt: now } }
  const reservedTotal = await NftMint.countDocuments(live)
  const reservedByMe = userId ? await NftMint.countDocuments({ ...live, reservedBy: userId }) : 0
  const availableToMe = free + reservedByMe
  return { availableToMe, reservedByOthers: reservedTotal - reservedByMe, reservedByMe }
}

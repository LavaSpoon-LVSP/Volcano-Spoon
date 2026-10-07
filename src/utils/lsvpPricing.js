/**
 * LSVP Tokens are priced and paid in whole tokens only — nothing in this
 * game's economy ever charges or pays out a fractional LSVP amount (the
 * on-chain transfer helpers in solana/tokenService.js scale by the mint's
 * decimals themselves; every price/cost an admin sets here is always a
 * plain whole-number count of tokens). This is the one shared check every
 * route that accepts an admin-set LSVP-denominated price/cost must use, so
 * "whole-token pricing" is validated identically everywhere it appears:
 * routes/nfts.js, skins.js, items.js (admin create/edit), jackpot.js
 * (lsvpCost), energy.js (lsvpCostFive/Ten/UnlimitedHour), arenaStages.js
 * (unlockCost), and blockchainAdmin.js's NFT-collection publish route
 * (priceLsvp) — each rejects a non-whole-number price at creation/edit
 * time rather than silently rounding or truncating it later.
 */
export function isWholeTokenAmount(value, { allowZero = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return false
  return allowZero ? n >= 0 : n > 0
}

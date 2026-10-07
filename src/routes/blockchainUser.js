import express from 'express'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { verifyAuthToken } from '../auth.js'
import { User } from '../models/User.js'
import { NftCollection } from '../models/NftCollection.js'
import { NftMint } from '../models/NftMint.js'
import { LsvpPurchaseRequest } from '../models/LsvpPurchaseRequest.js'
import { claimPaymentAndGrant } from '../models/LsvpPayment.js'
import { getLsvpBuyConfig } from '../models/LsvpBuyConfig.js'
import { reserveLsvpDailyUsage, releaseLsvpDailyUsage, todayDateKey } from '../models/LsvpDailyUsage.js'
import { createWalletLinkChallenge, claimWalletLinkChallenge } from '../models/WalletLinkChallenge.js'
import { requirePayoutsNotPaused } from '../models/PayoutConfig.js'
import { isValidSolanaAddress, linkWalletAddress } from '../solana/walletAddress.js'
import { SOLANA_NETWORK, lsvpMint } from '../config/solana.js'
import { verifyLsvpPayment, getAdminLsvpDepositAddress } from '../solana/paymentVerification.js'
import { transferLsvpFromAdmin, getWalletLsvpBalance, getLsvpProgramId, getTransferFinalStatus } from '../solana/tokenService.js'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { transferNftFromAdmin } from '../solana/nftService.js'

/**
 * Builds the /api/blockchain router — everything a signed-in PLAYER needs
 * for the Solana side of the game: linking their wallet, browsing/buying
 * published NFT collections, and buying LSVP Tokens with Lava Coins.
 *
 * See routes/blockchainAdmin.js for the admin-only half of this feature
 * (publishing NFTs, approving large LSVP purchases).
 *
 * @param {string} jwtSecret
 * @param {Map<string, object>} [sessions] Live WebSocket sessions keyed by
 *   userId — kept in sync immediately after a coin deduction, same pattern
 *   used by every other purchase route in this codebase.
 */
export function createBlockchainUserRouter(jwtSecret, sessions) {
  const router = express.Router()
  const auth = requireAuth(jwtSecret)

  function syncLiveSessionCoins(userId, coins) {
    const session = sessions?.get(String(userId))
    if (session?.game?.setTotalCoins && Number.isFinite(coins)) {
      session.game.setTotalCoins(coins)
    }
  }

  /**
   * Reads the userId out of a request's Bearer token IF one is present and
   * valid — used by routes that are public but want to personalize their
   * response (e.g. tagging owned collections) for a signed-in caller
   * without making auth a hard requirement. Returns null for a request
   * with no token or an invalid one, instead of rejecting it.
   */
  async function optionalUserId(req) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return null
    try {
      const payload = verifyAuthToken(token, jwtSecret)
      // Same tokenVersion check requireAuth applies (see its own comment)
      // — a stale token from before a password reset shouldn't silently
      // keep personalizing responses just because this path treats auth
      // as optional rather than required.
      const user = await User.findById(payload.sub).select('tokenVersion').lean()
      if (!user || (payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) return null
      return payload.sub
    } catch {
      return null
    }
  }

  /**
   * GET /api/blockchain/config
   * Public — everything the frontend needs to build an LSVP payment and
   * show accurate prices, without hardcoding anything network-specific.
   */
  router.get('/config', async (_req, res) => {
    try {
      const buyConfig = await getLsvpBuyConfig()
      const adminDepositAddress = lsvpMint ? await getAdminLsvpDepositAddress() : null
      // Tells the frontend whether LSVP is a classic SPL Token or a
      // Token-2022 (token extensions) mint — the two use different on-chain
      // programs, so the wallet-to-admin payment transaction the frontend
      // builds (see blockchainData.js's payLsvpToAdmin) has to be told which
      // one, the same way the backend's own tokenService.js does.
      const lsvpTokenProgram = lsvpMint ? (await getLsvpProgramId()).equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token' : null
      res.json({
        network: SOLANA_NETWORK,
        lsvpMint: lsvpMint?.toBase58() ?? null,
        lsvpTokenProgram,
        adminLsvpDepositAddress: adminDepositAddress?.toBase58() ?? null,
        coinsPerLsvp: buyConfig.coinsPerLsvp,
        approvalThresholdLsvp: buyConfig.approvalThresholdLsvp,
        dailyLimitLsvp: buyConfig.dailyLimitLsvp,
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/blockchain/wallet
   * Auth required — the player's currently linked wallet address (null if
   * they haven't connected one), plus its live on-chain LSVP balance.
   */
  router.get('/wallet', auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.sub).select('solanaWalletAddress')
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }
      const lsvpBalance = user.solanaWalletAddress ? await getWalletLsvpBalance(user.solanaWalletAddress) : 0
      res.json({ walletAddress: user.solanaWalletAddress, lsvpBalance })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/blockchain/wallet/challenge
   * Auth required — step 1 of linking (or changing) a wallet. Returns a
   * one-time message for the player's OWN wallet to sign (e.g.
   * wallet.signMessage() — never a transaction, no fee, nothing on-chain).
   * Nothing is linked yet here; see POST /wallet/link below.
   * Body: { walletAddress: string }
   */
  router.post('/wallet/challenge', auth, async (req, res) => {
    try {
      const walletAddress = req.body?.walletAddress?.trim()
      if (!isValidSolanaAddress(walletAddress)) {
        return res.status(400).json({ message: 'That does not look like a valid Solana wallet address' })
      }
      const challenge = await createWalletLinkChallenge(req.user.sub, walletAddress)
      res.json({ message: challenge.message, nonce: challenge.nonce, expiresAt: challenge.expiresAt })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/blockchain/wallet/link
   * Auth required — step 2: actually links (or changes) the player's
   * wallet, but ONLY once a valid ed25519 signature over the exact
   * challenge message from POST /wallet/challenge is presented — proving
   * the caller really controls this wallet's private key, not just its
   * public address. This — and requiring every purchase/claim route to
   * already have a wallet linked this way, rather than accepting whatever
   * address a request body claims — is what "linking or changing a wallet
   * requires a valid signature" means; see solana/walletAddress.js's doc
   * comment for what this replaced. Two players can still never link the
   * same wallet (User.solanaWalletAddress's unique index, unchanged).
   * Body: { walletAddress: string, nonce: string, signature: string (base58) }
   */
  router.post('/wallet/link', auth, async (req, res) => {
    try {
      const walletAddress = req.body?.walletAddress?.trim()
      const nonce = req.body?.nonce
      const signature = req.body?.signature
      if (!isValidSolanaAddress(walletAddress) || !nonce || !signature) {
        return res.status(400).json({ message: 'walletAddress, nonce and signature are all required' })
      }

      const challenge = await claimWalletLinkChallenge({ userId: req.user.sub, walletAddress, nonce })
      if (!challenge) {
        return res.status(409).json({ message: 'This linking request has expired or already been used — request a new one and sign it again' })
      }

      let verified = false
      try {
        const messageBytes = new TextEncoder().encode(challenge.message)
        const signatureBytes = bs58.decode(signature)
        const publicKeyBytes = new PublicKey(walletAddress).toBytes()
        verified = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)
      } catch {
        verified = false
      }

      if (!verified) {
        return res.status(400).json({ message: 'Signature does not match this wallet — linking failed' })
      }

      try {
        const linkedAddress = await linkWalletAddress(req.user.sub, walletAddress)
        res.json({ walletAddress: linkedAddress })
      } catch (linkError) {
        res.status(linkError.status || 500).json({ message: linkError.message })
      }
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/blockchain/nft-collections
   * Public catalog of every PUBLISHED collection with at least one
   * unsold NFT — this is the Game NFT section's data source. If the
   * request is authenticated, each collection is also tagged with
   * `alreadyOwned` so the frontend can show "OWNED" instead of a buy
   * button (a player may only own one NFT per collection).
   */
  router.get('/nft-collections', async (req, res) => {
    try {
      const collections = await NftCollection.find({ priceLsvp: { $ne: null } }).sort({ name: 1 })

      // The catalog itself is public, but a signed-in caller gets their
      // owned collections tagged too — see optionalUserId() above.
      const userId = await optionalUserId(req)
      let ownedCollectionAddresses = new Set()
      if (userId) {
        const owned = await NftMint.find({ ownerUserId: userId, status: 'sold' }).select('collectionMintAddress')
        ownedCollectionAddresses = new Set(owned.map((m) => m.collectionMintAddress))
      }

      const result = []
      for (const collection of collections) {
        const availableCount = await NftMint.countDocuments({
          collectionMintAddress: collection.collectionMintAddress,
          status: 'published',
        })
        if (availableCount === 0) continue

        result.push({
          collectionMintAddress: collection.collectionMintAddress,
          name: collection.name,
          image: collection.image,
          priceLsvp: collection.priceLsvp,
          availableCount,
          alreadyOwned: ownedCollectionAddresses.has(collection.collectionMintAddress),
        })
      }

      res.json({ collections: result })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/blockchain/nft-collections/me/owned
   * Auth required — which collections this player already owns an NFT
   * from (used by the frontend to mark cards OWNED without re-deriving it
   * from a big join on every catalog fetch).
   */
  router.get('/nft-collections/me/owned', auth, async (req, res) => {
    try {
      const owned = await NftMint.find({ ownerUserId: req.user.sub, status: 'sold' }).select('collectionMintAddress mintAddress name image transferFailed transferSignature soldAt')
      res.json({
        owned: owned.map((m) => ({
          collectionMintAddress: m.collectionMintAddress,
          mintAddress: m.mintAddress,
          name: m.name,
          image: m.image,
          // Delivery status for the player's own "My NFTs" display:
          // - 'delivered': on-chain transfer confirmed (transferSignature set, transferFailed not set)
          // - 'failed': the transfer to the player's wallet did not complete; ownership/sale is
          //   still intact and an admin can retry it (see blockchainAdmin.js failed-transfers flow)
          // - 'pending': sale recorded but no transfer attempt has resolved yet (shouldn't normally
          //   persist, since purchase awaits the transfer, but included for completeness/races)
          transferStatus: m.transferFailed ? 'failed' : m.transferSignature ? 'delivered' : 'pending',
          soldAt: m.soldAt,
        })),
      })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/blockchain/nft-collections/:collectionMintAddress/purchase
   * Auth required — buy one NFT from this collection with LSVP.
   * Body: { txSignature: string, walletAddress?: string } — txSignature is
   * the signature of an LSVP transfer the player's own wallet already sent
   * to the admin wallet (built + signed by the frontend via its connected
   * wallet — see solana/paymentVerification.js for why the backend can't
   * do this step itself). The paying wallet must already be linked AND
   * signature-verified (POST /wallet/challenge + /wallet/link) — this used
   * to auto-link whatever walletAddress the body claimed with no proof of
   * ownership; walletAddress here, if sent, is only cross-checked against
   * the account's already-linked wallet, never used to (re)link it.
   *
   * A player can only ever own ONE NFT per collection — enforced twice:
   * once as an early check (so a repeat buyer gets a clear error before
   * paying again — though they've already paid by the time this endpoint
   * runs), and again atomically at the database level (NftMint.js's
   * partial unique index) to close the race where two purchases for the
   * same collection land at the same instant. If that race is lost, or the
   * collection sells out between the pre-checks and the atomic update, the
   * LSVP payment is refunded on-chain automatically — the player is never
   * left having paid for nothing.
   */
  router.post('/nft-collections/:collectionMintAddress/purchase', auth, async (req, res) => {
    const userId = req.user.sub
    const { collectionMintAddress } = req.params
    const txSignature = req.body?.txSignature

    try {
      // Wallet must already be linked AND verified (see POST
      // /wallet/challenge + /wallet/link) — this route used to silently
      // (re)link whatever address the request body claimed with no proof
      // of ownership at all. See solana/walletAddress.js's doc comment.
      const user = await User.findById(userId).select('username solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before purchasing' })
      }
      if (req.body?.walletAddress && req.body.walletAddress !== user.solanaWalletAddress) {
        return res.status(400).json({ message: 'The connected wallet does not match your linked wallet' })
      }

      const collection = await NftCollection.findOne({ collectionMintAddress })
      if (!collection || collection.priceLsvp === null) {
        return res.status(404).json({ message: 'Collection not found or not for sale' })
      }

      const alreadyOwned = await NftMint.exists({ collectionMintAddress, ownerUserId: userId, status: 'sold' })
      if (alreadyOwned) {
        return res.status(409).json({ message: 'You already own an NFT from this collection' })
      }

      const hasStock = await NftMint.exists({ collectionMintAddress, status: 'published' })
      if (!hasStock) {
        return res.status(400).json({ message: 'This collection is sold out' })
      }

      const verification = await verifyLsvpPayment({
        txSignature,
        expectedAmountLsvp: collection.priceLsvp,
        payerWallet: user.solanaWalletAddress,
      })
      if (!verification.ok) {
        return res.status(400).json({ message: verification.reason })
      }

      // grant() runs at most once per payment (see claimPaymentAndGrant's
      // doc comment in models/LsvpPayment.js) — this is what makes a retry
      // of the same signature safe: it can never double-assign a mint or
      // double-send a refund/NFT transfer for one payment.
      const grant = async () => {
        // Atomically claim one published mint. Can fail (return null) for
        // two reasons: no stock left, or the partial unique index rejects
        // it because this user already owns one from this collection (a
        // race the pre-check above didn't catch). Either way, the payment
        // is already spent — refund it on-chain rather than leave the
        // player empty-handed.
        let mint
        try {
          mint = await NftMint.findOneAndUpdate(
            { collectionMintAddress, status: 'published' },
            { $set: { status: 'sold', ownerUserId: userId, soldAt: new Date() } },
            { new: true }
          )
        } catch (raceError) {
          if (raceError?.code !== 11000) throw raceError
          mint = null
        }

        if (!mint) {
          let refundSignature = null
          try {
            refundSignature = await transferLsvpFromAdmin(user.solanaWalletAddress, collection.priceLsvp)
          } catch (refundError) {
            // UNCERTAIN TRANSFER — the refund send/confirm failed, which
            // doesn't necessarily mean it never landed. Check before
            // logging this as a totally-failed refund (an admin working
            // from that log should know whether to also check on-chain).
            const status = await getTransferFinalStatus(refundError.signature)
            if (status.success) {
              refundSignature = refundError.signature
            } else {
              console.error(`CRITICAL: could not refund LSVP after failed NFT assignment (user ${userId}, collection ${collectionMintAddress}, landed=${status.landed}):`, refundError)
            }
          }
          return {
            status: 409,
            body: {
              message: refundSignature
                ? 'This collection just sold out (or you already own one) — your LSVP payment has been refunded'
                : 'This collection just sold out (or you already own one) — refund failed, please contact an admin',
            },
          }
        }

        // Send the actual NFT. If this fails, the sale still stands (the
        // player paid and owns it in our records) — flag it for an admin
        // to retry rather than unwind a payment that already succeeded.
        try {
          const signature = await transferNftFromAdmin(mint.mintAddress, user.solanaWalletAddress)
          mint.transferSignature = signature
          await mint.save()
        } catch (transferError) {
          const status = await getTransferFinalStatus(transferError.signature)
          if (status.success) {
            mint.transferSignature = transferError.signature
            mint.transferFailed = false
          } else {
            mint.transferFailed = true
            console.error(`NFT transfer failed/uncertain after successful sale (mint ${mint.mintAddress}, user ${userId}, landed=${status.landed}) — flagged for admin retry:`, transferError)
          }
          await mint.save()
        }

        return {
          status: 201,
          body: {
            message: mint.transferFailed
              ? `Purchased ${mint.name}! The on-chain transfer is still finishing — it'll arrive in your wallet shortly.`
              : `Purchased ${mint.name}!`,
            mint: { mintAddress: mint.mintAddress, name: mint.name, image: mint.image, transferPending: mint.transferFailed },
          },
        }
      }

      const result = await claimPaymentAndGrant({
        txSignature,
        userId,
        payerWallet: user.solanaWalletAddress,
        amountLsvp: collection.priceLsvp,
        purpose: 'nft_purchase',
        purposeRefId: collectionMintAddress,
        grant,
        getGrantedResponse: async () => {
          const mint = await NftMint.findOne({ collectionMintAddress, ownerUserId: userId, status: 'sold' })
          if (!mint) {
            return { status: 200, body: { message: 'This payment was already used for this collection.' } }
          }
          return {
            status: 200,
            body: {
              message: `Purchased ${mint.name}!`,
              mint: { mintAddress: mint.mintAddress, name: mint.name, image: mint.image, transferPending: mint.transferFailed },
            },
          }
        },
      })

      res.status(result.status).json(result.body)
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ message: error.message })
      }
      console.error(`NFT purchase error for user ${userId}, collection ${collectionMintAddress}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * POST /api/blockchain/lsvp/buy
   * Auth required — buy LSVP Tokens with Lava Coins. A purchase is sent
   * instantly (auto-approved) UNLESS either:
   *   - this single request alone is >= config.approvalThresholdLsvp, or
   *   - it would push this player's running total for the current
   *     calendar day (server-local time) to/over config.dailyLimitLsvp —
   *     so several smaller purchases that add up past the daily limit
   *     are routed to admin review exactly like one big purchase is.
   * Either way the request is never rejected outright for being large —
   * it's queued with status 'pending' for an admin to approve or reject
   * (see routes/blockchainAdmin.js). The daily running total counts both
   * already-approved and still-pending requests today, since a pending
   * request already reserves its amount against the day's allowance.
   * Body: { lsvpAmount: number, walletAddress?: string } — the paying
   * wallet must already be linked AND signature-verified (POST
   * /wallet/challenge + /wallet/link); walletAddress here, if sent, is
   * only cross-checked against the account's already-linked wallet, never
   * used to (re)link it — see solana/walletAddress.js's doc comment for
   * why auto-linking from a purchase call was removed.
   */
  router.post('/lsvp/buy', auth, async (req, res) => {
    const userId = req.user.sub
    const lsvpAmount = Number(req.body?.lsvpAmount)
    let reservedDateKey = null

    try {
      if (!Number.isInteger(lsvpAmount) || lsvpAmount <= 0) {
        return res.status(400).json({ message: 'Enter a positive whole number of LSVP Tokens' })
      }

      // Wallet must already be linked AND verified (see POST
      // /wallet/challenge + /wallet/link) — this route used to silently
      // (re)link whatever address the request body claimed with no proof
      // of ownership. See solana/walletAddress.js's doc comment.
      const user = await User.findById(userId).select('username coins solanaWalletAddress')
      if (!user?.solanaWalletAddress) {
        return res.status(400).json({ message: 'Link and verify a Solana wallet (Profile → Wallet) before purchasing' })
      }
      if (req.body?.walletAddress && req.body.walletAddress !== user.solanaWalletAddress) {
        return res.status(400).json({ message: 'The connected wallet does not match your linked wallet' })
      }

      const config = await getLsvpBuyConfig()
      const coinsSpent = lsvpAmount * config.coinsPerLsvp

      // Atomically RESERVE this purchase's amount against today's running
      // total BEFORE deciding auto-approve vs pending — this is what
      // closes the race where several parallel requests could each read
      // the same "total so far" (the old code's LsvpPurchaseRequest
      // aggregate), each independently decide they're still under the
      // daily limit, and all get auto-approved together — sending well
      // past config.dailyLimitLsvp. The increment itself is atomic
      // ($inc via findOneAndUpdate), so concurrent requests are strictly
      // serialized by Mongo and the running total this reads is never
      // stale. See models/LsvpDailyUsage.js.
      const dateKey = todayDateKey()
      const usage = await reserveLsvpDailyUsage(userId, dateKey, lsvpAmount)
      reservedDateKey = dateKey
      const totalTodayAfterThis = usage.totalLsvp

      // Needs admin approval if EITHER this one request alone clears the
      // per-request threshold, OR this reservation carried today's running
      // total to/over the daily limit. Once a player has crossed the daily
      // limit, every further purchase that day keeps needing approval,
      // whether it arrives as one big buy or many small ones.
      const wouldExceedDailyLimit = totalTodayAfterThis >= config.dailyLimitLsvp
      const needsApproval = lsvpAmount >= config.approvalThresholdLsvp || wouldExceedDailyLimit

      if (!needsApproval) {
        const chargedUser = await User.findOneAndUpdate(
          { _id: userId, coins: { $gte: coinsSpent } },
          { $inc: { coins: -coinsSpent } },
          { new: true }
        ).select('coins')

        if (!chargedUser) {
          await releaseLsvpDailyUsage(userId, dateKey, lsvpAmount)
          return res.status(400).json({ message: 'Insufficient Lava Coin balance' })
        }

        // Payouts-paused kill switch — checked only on the auto-approve
        // path (a pending request is already headed to admin review, so
        // the pause doesn't need to touch it). If paused, fall through to
        // the pending path instead of sending.
        let paused = false
        try {
          await requirePayoutsNotPaused()
        } catch {
          paused = true
        }

        if (!paused) {
          let signature
          try {
            signature = await transferLsvpFromAdmin(user.solanaWalletAddress, lsvpAmount)
          } catch (transferError) {
            // UNCERTAIN TRANSFER — send/confirm failing does not mean
            // nothing was sent (see tokenService.js's sendSignedTransfer).
            // Check the real on-chain status of this exact signature
            // before refunding coins — refunding a transfer that actually
            // landed would let the player double-spend their coins.
            const status = await getTransferFinalStatus(transferError.signature)
            if (status.success) {
              signature = transferError.signature
            } else if (status.landed === null) {
              // Genuinely unknown — do NOT refund (could be a double-pay)
              // and do NOT release the daily-limit reservation (it may
              // still have gone out). Tell the player to check back.
              console.error(`LSVP purchase transfer uncertain for user ${userId} (signature ${transferError.signature}):`, transferError)
              return res.status(500).json({ message: 'Could not confirm this purchase — please check your purchase history shortly before retrying.' })
            } else {
              const refunded = await User.findByIdAndUpdate(userId, { $inc: { coins: coinsSpent } }, { new: true }).select('coins')
              syncLiveSessionCoins(userId, refunded?.coins)
              await releaseLsvpDailyUsage(userId, dateKey, lsvpAmount)
              console.error(`LSVP purchase transfer failed for user ${userId} — coins refunded:`, transferError)
              return res.status(500).json({ message: `On-chain transfer failed: ${transferError.message} (coins refunded)` })
            }
          }

          // SIGNATURE COLLISION GUARD — Ed25519 signing is deterministic, so
          // two requests that happen to build a byte-identical transaction
          // (same destination wallet + same amount, landing in the same
          // blockhash window — easy to hit with rapid repeated buys) produce
          // the SAME signature. When that happens, only the first send is a
          // real new transfer; every later one either throws "already
          // processed" (handled above — status.success just means the
          // EARLIER transfer landed, not that THIS request sent anything
          // new) or, in rarer timing, returns normally from
          // transferLsvpFromAdmin without throwing at all. Either way, if a
          // LsvpPurchaseRequest already exists for this exact signature,
          // crediting this request too would double-charge the player for
          // one real transfer. Refund this request's coins and tell the
          // player plainly instead of silently recording a second delivery.
          const existingForSignature = await LsvpPurchaseRequest.findOne({ txSignature: signature })
          if (existingForSignature) {
            const refunded = await User.findByIdAndUpdate(userId, { $inc: { coins: coinsSpent } }, { new: true }).select('coins')
            syncLiveSessionCoins(userId, refunded?.coins)
            await releaseLsvpDailyUsage(userId, dateKey, lsvpAmount)
            console.error(`LSVP purchase for user ${userId} collided with an already-recorded transfer (signature ${signature}, existing request ${existingForSignature._id}) — coins refunded, no new transfer was sent for this request.`)
            return res.status(409).json({
              message: 'This purchase collided with another in-flight request and did not send a new transfer — your coins have been refunded. Please try again.',
            })
          }

          let request
          try {
            request = await LsvpPurchaseRequest.create({
              user: userId,
              username: user.username,
              walletAddress: user.solanaWalletAddress,
              lsvpAmount,
              coinsSpent,
              status: 'approved',
              autoApproved: true,
              txSignature: signature,
              reviewedAt: new Date(),
            })
          } catch (createError) {
            // Belt-and-suspenders for the unique index on txSignature
            // (models/LsvpPurchaseRequest.js) — this only fires if another
            // request won a dead-even race against the existingForSignature
            // check just above, which the findOne check alone can't rule
            // out. Same outcome either way: refund this request's coins,
            // it did not get its own transfer.
            if (createError?.code === 11000) {
              const refunded = await User.findByIdAndUpdate(userId, { $inc: { coins: coinsSpent } }, { new: true }).select('coins')
              syncLiveSessionCoins(userId, refunded?.coins)
              await releaseLsvpDailyUsage(userId, dateKey, lsvpAmount)
              console.error(`LSVP purchase for user ${userId} lost a race on signature ${signature} (duplicate-key on create) — coins refunded, no new transfer was sent for this request.`)
              return res.status(409).json({
                message: 'This purchase collided with another in-flight request and did not send a new transfer — your coins have been refunded. Please try again.',
              })
            }
            throw createError
          }

          syncLiveSessionCoins(userId, chargedUser.coins)

          return res.status(201).json({
            request,
            coins: chargedUser.coins,
            message: `Purchased ${lsvpAmount} LSVP Token${lsvpAmount === 1 ? '' : 's'} — sent to your wallet`,
          })
        }

        // Payouts are paused — refund the coin deduction we just made for
        // the auto-approve path and fall through to a pending request
        // instead, same as if it had needed approval in the first place.
        const refunded = await User.findByIdAndUpdate(userId, { $inc: { coins: coinsSpent } }, { new: true }).select('coins')
        syncLiveSessionCoins(userId, refunded?.coins)

        const request = await LsvpPurchaseRequest.create({
          user: userId,
          username: user.username,
          walletAddress: user.solanaWalletAddress,
          lsvpAmount,
          coinsSpent,
          status: 'pending',
          autoApproved: false,
        })

        return res.status(201).json({
          request,
          coins: refunded?.coins ?? user.coins,
          message: 'Automatic payouts are temporarily paused — your request is now pending admin approval',
        })
      }

      if (coinsSpent > (user.coins || 0)) {
        await releaseLsvpDailyUsage(userId, dateKey, lsvpAmount)
        return res.status(400).json({ message: 'Insufficient Lava Coin balance' })
      }

      const request = await LsvpPurchaseRequest.create({
        user: userId,
        username: user.username,
        walletAddress: user.solanaWalletAddress,
        lsvpAmount,
        coinsSpent,
        status: 'pending',
        autoApproved: false,
      })

      const pendingMessage = wouldExceedDailyLimit
        ? `This purchase would take you past today's ${config.dailyLimitLsvp} LSVP daily limit, so it needs admin approval — your request is now pending`
        : `Purchasing ${lsvpAmount} LSVP Tokens or more needs admin approval — your request is now pending`

      res.status(201).json({
        request,
        coins: user.coins,
        message: pendingMessage,
      })
    } catch (error) {
      if (reservedDateKey) {
        await releaseLsvpDailyUsage(userId, reservedDateKey, lsvpAmount).catch(() => {})
      }
      console.error(`LSVP purchase error for user ${userId}:`, error)
      res.status(500).json({ message: error.message })
    }
  })

  /**
   * GET /api/blockchain/lsvp/requests/me
   * Auth required — this player's own LSVP purchase request history.
   */
  router.get('/lsvp/requests/me', auth, async (req, res) => {
    try {
      const requests = await LsvpPurchaseRequest.find({ user: req.user.sub }).sort({ createdAt: -1 }).limit(100)
      res.json({ requests })
    } catch (error) {
      res.status(500).json({ message: error.message })
    }
  })

  return router
}

export default createBlockchainUserRouter

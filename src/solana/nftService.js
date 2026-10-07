import { Metaplex } from '@metaplex-foundation/js'
import { getOrCreateAssociatedTokenAccount, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { connection, adminPublicKey, requireAdminKeypair } from '../config/solana.js'
import { sendSignedTransfer } from './tokenService.js'

/**
 * NFT SERVICE — discovering which NFTs the admin wallet holds (grouped into
 * collections), and transferring one to a buyer's wallet.
 *
 * NFT "collections" here mean the standard Metaplex collection feature:
 * every NFT in a collection has its metadata's `collection` field pointing
 * at one shared "Collection NFT". That's what groups e.g. 500 individual NFT
 * mints into one "VolcanoSpoon Founders" collection the admin can publish
 * from. An NFT with no `collection` field at all is ignored — there'd be
 * nothing to group it under.
 *
 * A collection can additionally be "verified" on-chain (the Collection
 * NFT's authority has run a separate transaction confirming every member
 * really belongs to it). Verification matters for a PUBLIC marketplace,
 * where anyone could otherwise set a fake `collection` field to impersonate
 * a popular collection. It's not a real concern here: this scan only ever
 * looks at NFTs the admin's OWN wallet already holds, so an unverified
 * grouping is still trustworthy — it's simply been minted (e.g. by a
 * Devnet test script) without that extra step. So both verified and
 * unverified collections are shown; each collection's `verified` flag is
 * still returned so the admin dashboard can flag an unverified one, since
 * verifying is still good practice before selling to real players.
 */

function metaplex() {
  return Metaplex.make(connection)
}

/**
 * Scans the admin wallet and returns every verified-collection NFT it
 * holds, grouped by collection. Shape:
 *   [{
 *     collectionMintAddress, collectionName, collectionImage,
 *     items: [{ mintAddress, name, image }],
 *   }, ...]
 *
 * This talks to the Solana RPC (and fetches each NFT's off-chain metadata
 * JSON for its name/image) so it's not instant — it's meant to be called
 * from an admin "sync inventory" action, not on every page load.
 */
export async function scanAdminWalletNfts() {
  const mx = metaplex()
  const candidateMints = await findNftCandidateMints()

  // Load each candidate mint's metadata one at a time (findByMint reads one
  // deterministic on-chain address per mint) instead of Metaplex's
  // findAllByOwner, which needs the "getProgramAccounts" RPC method — many
  // RPC providers (including Alchemy's free tier) block that method outright
  // because it's expensive to serve, since it scans every account a program
  // owns rather than looking one up directly. findNftCandidateMints() below
  // narrows things down first using an indexed, always-available call, so
  // this is usually just a handful of lookups. A mint that turns out to have
  // no NFT metadata (shouldn't happen given the filtering below, but cheap
  // to guard) is just skipped rather than failing the whole sync.
  const held = (
    await Promise.all(
      candidateMints.map((mint) =>
        mx
          .nfts()
          .findByMint({ mintAddress: mint })
          .catch((error) => {
            console.warn(`Skipping ${mint.toBase58()} while scanning admin wallet — could not load its metadata:`, error.message)
            return null
          })
      )
    )
  )
    // Keep only NFTs that loaded successfully, belong to SOME collection
    // (an NFT with no `collection` field has nothing to group it under —
    // see the file header above for why verification isn't required), and
    // actually have the fields this file reads off of them. That last
    // check matters because findByMint() can return a "thin" record for a
    // token that isn't really an NFT (e.g. a stray 1-decimal-0 token that
    // isn't a Metaplex NFT at all) — skipping it here is simpler and safer
    // than letting a missing field crash the whole sync.
    //
    // NOTE: findByMint() returns an `Nft`/`Sft` model, NOT the plain
    // `Metadata` model — and confusingly, that model renames the mint's own
    // address from `mintAddress` to plain `address` (its `mintAddress`
    // field doesn't exist). `collection` isn't renamed, so that one's still
    // read the same way everywhere else in this file.
    .filter((nft) => nft?.address && nft?.collection?.address)

  const groups = new Map() // collectionMintAddress -> { verified, items[] }
  for (const nft of held) {
    const key = nft.collection.address.toBase58()
    if (!groups.has(key)) groups.set(key, { verified: nft.collection.verified, items: [] })
    groups.get(key).items.push(nft)
  }

  const collections = []
  for (const [collectionMintAddress, group] of groups) {
    const collectionInfo = await loadCollectionInfo(mx, collectionMintAddress)
    const resolvedItems = await Promise.all(group.items.map(loadNftDisplayInfo))

    collections.push({
      collectionMintAddress,
      collectionName: collectionInfo.name,
      collectionImage: collectionInfo.image,
      verified: group.verified,
      items: resolvedItems,
    })
  }

  return collections
}

/**
 * Every mint the admin wallet holds exactly 1 of, with 0 decimals — the
 * standard on-chain signature of an NFT (as opposed to a fungible token
 * like LSVP, which holds many units across multiple decimals). Uses
 * getParsedTokenAccountsByOwner, an indexed/cheap RPC call every provider
 * allows, unlike getProgramAccounts (see scanAdminWalletNfts above).
 */
async function findNftCandidateMints() {
  const { value } = await connection.getParsedTokenAccountsByOwner(adminPublicKey, { programId: TOKEN_PROGRAM_ID })
  return value
    .map((entry) => entry.account.data.parsed.info)
    .filter((info) => info.tokenAmount.amount === '1' && info.tokenAmount.decimals === 0)
    .map((info) => new PublicKey(info.mint))
}

/** Best-effort fetch of the Collection NFT's own name + image, for the collection card. Never throws — falls back to a placeholder. */
async function loadCollectionInfo(mx, collectionMintAddress) {
  try {
    const collectionNft = await mx.nfts().findByMint({ mintAddress: new PublicKey(collectionMintAddress) })
    const image = await loadImageFromUri(collectionNft.uri)
    return { name: collectionNft.name || 'Unnamed Collection', image }
  } catch (error) {
    console.warn(`Could not load collection metadata for ${collectionMintAddress}:`, error.message)
    return { name: 'Unnamed Collection', image: null }
  }
}

/** Best-effort fetch of one NFT's own display name + image. Never throws. */
async function loadNftDisplayInfo(nft) {
  const image = await loadImageFromUri(nft.uri)
  return {
    mintAddress: nft.address.toBase58(), // `nft.address` is the mint address on this model — see the note in scanAdminWalletNfts above.
    name: nft.name || 'Unnamed NFT',
    image,
  }
}

/**
 * Some NFT metadata (and the `image` field inside it) uses an `ipfs://` or
 * `ar://` URI instead of a normal https link — valid on-chain, but neither
 * `fetch()` here nor a browser's <img> tag can load those schemes directly.
 * Rewritten to a public gateway URL so both the metadata fetch below and
 * the image the frontend renders actually resolve. Anything else (a plain
 * https link, or already-gateway'd) is left untouched.
 *
 * Gateway choice matters here: most public IPFS gateways (ipfs.io,
 * dweb.link, nftstorage.link, w3s.link, cf-ipfs.com) block a cross-origin
 * <img> request — the same URL opens fine when navigated to directly, but
 * 403s (or is silently dropped) when hotlinked from another site, which is
 * exactly how the frontend loads these images. Confirmed against a real
 * synced collection's image across all of the above — gateway.pinata.cloud
 * was the one gateway that actually allows cross-origin <img> embedding, so
 * that's what's used here.
 */
export function resolveUri(uri) {
  if (!uri) return uri
  if (uri.startsWith('ipfs://')) {
    return `https://gateway.pinata.cloud/ipfs/${uri.slice('ipfs://'.length)}`
  }
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice('ar://'.length)}`
  }
  return uri
}

/** Fetches the `image` field out of an NFT's off-chain metadata JSON. Returns null on any failure instead of throwing — a missing image shouldn't break a sync. */
export async function loadImageFromUri(uri) {
  const metadataUrl = resolveUri(uri)
  if (!metadataUrl) return null
  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const json = await response.json()
    return resolveUri(json.image) ?? null
  } catch {
    return null
  }
}

/**
 * Transfers one specific NFT (by its mint address) from the admin wallet to
 * a buyer's wallet. NFTs are just SPL tokens with a supply of 1 and 0
 * decimals, so this is the same "transferChecked" call used for LSVP, just
 * with amount=1 and decimals=0 hardcoded — no separate NFT-specific
 * transfer instruction is needed.
 */
export async function transferNftFromAdmin(mintAddress, destinationWallet) {
  const admin = requireAdminKeypair()
  const mint = new PublicKey(mintAddress)
  const destination = destinationWallet instanceof PublicKey ? destinationWallet : new PublicKey(destinationWallet)

  const adminTokenAccount = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey)
  const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(connection, admin, mint, destination)

  const instruction = createTransferCheckedInstruction(
    adminTokenAccount.address,
    mint,
    destinationTokenAccount.address,
    admin.publicKey,
    1, // amount — always 1 for an NFT
    0 // decimals — always 0 for an NFT
  )

  // Signs locally before sending (see tokenService.js's sendSignedTransfer)
  // so the signature is known even if send/confirm fails — callers must
  // check getTransferFinalStatus(signature) on the resulting error before
  // assuming an NFT transfer never went out and retrying it (a real
  // double-send risk otherwise; an NFT can only ever be sent once, but
  // retrying an uncertain send could send it to the wrong outcome twice —
  // e.g. two transfer instructions racing on the same 1-supply token
  // account).
  return sendSignedTransfer(admin, [instruction])
}

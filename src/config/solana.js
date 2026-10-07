import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js'
import bs58 from 'bs58'

/**
 * SOLANA NETWORK CONFIG — the ONE place that decides "are we talking to
 * Devnet or Mainnet". Everything else in the backend (token transfers, NFT
 * scanning, payment verification) imports `connection`/`adminKeypair`/
 * `lsvpMint` from here instead of touching `process.env` or
 * `@solana/web3.js` directly, so switching networks is always just an env
 * var change — never a code change.
 *
 * How to switch networks:
 *   1. Set SOLANA_NETWORK=devnet or SOLANA_NETWORK=mainnet-beta in .env
 *   2. Make sure the matching LSVP_TOKEN_MINT_* env var is set for that
 *      network (a token mint address only exists on one network at a time)
 *   3. Restart the server
 * The admin wallet itself does NOT need to change — a Solana keypair's
 * public address is the same on every network, only its balances differ.
 */

const VALID_NETWORKS = ['devnet', 'mainnet-beta']

export const SOLANA_NETWORK = VALID_NETWORKS.includes(process.env.SOLANA_NETWORK)
  ? process.env.SOLANA_NETWORK
  : 'devnet'

if (!VALID_NETWORKS.includes(process.env.SOLANA_NETWORK)) {
  console.warn(
    `SOLANA_NETWORK is "${process.env.SOLANA_NETWORK ?? '(not set)'}" — falling back to "devnet". ` +
      `Set SOLANA_NETWORK to one of: ${VALID_NETWORKS.join(', ')}`
  )
}

export const isMainnet = SOLANA_NETWORK === 'mainnet-beta'

/** Pick the RPC URL for the active network — an env override if given, else Solana's public cluster endpoint. */
function resolveRpcUrl() {
  if (isMainnet) {
    return process.env.SOLANA_RPC_URL_MAINNET || clusterApiUrl('mainnet-beta')
  }
  return process.env.SOLANA_RPC_URL_DEVNET || clusterApiUrl('devnet')
}

/**
 * Pick the WebSocket endpoint used to wait for transaction confirmations
 * (Connection normally just derives this from the RPC URL by swapping
 * https:// for wss://, but that's the wrong move for some third-party RPC
 * providers — e.g. Alchemy's free/growth Devnet tier accepts normal RPC
 * calls fine but doesn't support the `signatureSubscribe` WebSocket method,
 * which makes every transfer's confirmation step hang retrying it and can
 * stall the process long enough for a second transaction's blockhash to
 * expire before it's even sent). Defaulting to Solana's own public cluster
 * WebSocket keeps confirmations working even when the HTTP RPC is a
 * provider that doesn't support them — set SOLANA_WS_URL_DEVNET/MAINNET to
 * override if your provider's own WebSocket endpoint does support it.
 */
function resolveWsUrl() {
  if (isMainnet) {
    return process.env.SOLANA_WS_URL_MAINNET || 'wss://api.mainnet-beta.solana.com'
  }
  return process.env.SOLANA_WS_URL_DEVNET || 'wss://api.devnet.solana.com'
}

export const connection = new Connection(resolveRpcUrl(), { commitment: 'confirmed', wsEndpoint: resolveWsUrl() })

/**
 * The LSVP Token's on-chain mint address for the active network. A mint
 * only ever exists on one network — a Devnet LSVP mint and a Mainnet LSVP
 * mint are two entirely different tokens — so which env var is read
 * automatically follows SOLANA_NETWORK above.
 */
const lsvpMintAddress = isMainnet
  ? process.env.LSVP_TOKEN_MINT_MAINNET
  : process.env.LSVP_TOKEN_MINT_DEVNET

export const lsvpMint = lsvpMintAddress ? new PublicKey(lsvpMintAddress) : null

if (!lsvpMint) {
  console.error(
    `LSVP token mint is not set for network "${SOLANA_NETWORK}" — set ` +
      `${isMainnet ? 'LSVP_TOKEN_MINT_MAINNET' : 'LSVP_TOKEN_MINT_DEVNET'} in .env. ` +
      `LSVP purchases and NFT payments will fail until this is set.`
  )
}

/**
 * The admin wallet — the single wallet that holds every NFT before it's
 * sold, and that LSVP purchases/refunds are paid out from. Loaded from a
 * base58-encoded secret key (the format Phantom/Solflare show when you
 * "Export Private Key"). Same keypair is used on Devnet and Mainnet; only
 * fund it with SOL/LSVP/NFTs on whichever network SOLANA_NETWORK points at.
 *
 * SECURITY: this key can move every token/NFT the admin wallet holds.
 * Never commit it, never log it, never send it to the frontend. Keep it out
 * of .env on any machine other than the server itself.
 */
function loadAdminKeypair() {
  const secret = process.env.ADMIN_WALLET_SECRET_KEY
  if (!secret) {
    console.error('ADMIN_WALLET_SECRET_KEY is not set — blockchain routes will fail until it is.')
    return null
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(secret))
  } catch (error) {
    console.error('ADMIN_WALLET_SECRET_KEY is set but is not a valid base58 secret key:', error.message)
    return null
  }
}

export const adminKeypair = loadAdminKeypair()
export const adminPublicKey = adminKeypair?.publicKey ?? null

/** Throws a clear error if the admin wallet isn't configured — call at the top of any route that needs to sign a transaction. */
export function requireAdminKeypair() {
  if (!adminKeypair) {
    throw new Error('Admin wallet is not configured (ADMIN_WALLET_SECRET_KEY missing/invalid)')
  }
  return adminKeypair
}

/** Throws a clear error if the LSVP mint isn't configured for the active network. */
export function requireLsvpMint() {
  if (!lsvpMint) {
    throw new Error(`LSVP token mint is not configured for network "${SOLANA_NETWORK}"`)
  }
  return lsvpMint
}

/** A Solana Explorer link for a transaction signature, pointed at whichever network is currently active — handy in admin UI and server logs. */
export function explorerTxUrl(signature) {
  const cluster = isMainnet ? '' : `?cluster=${SOLANA_NETWORK}`
  return `https://explorer.solana.com/tx/${signature}${cluster}`
}

console.log(
  `Solana config: network=${SOLANA_NETWORK} rpc=${resolveRpcUrl()} adminWallet=${adminPublicKey?.toBase58() ?? '(not set)'} lsvpMint=${lsvpMint?.toBase58() ?? '(not set)'}`
)

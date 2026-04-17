import { Keypair, PublicKey } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as bs58Mod from 'bs58';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

const bs58 = (bs58Mod as any).default ?? bs58Mod;

export interface GeneratedWallet {
  chain: string;
  walletAddress: string;
  walletPrivateKey: string;
}

/**
 * Generate a custodial wallet for the given chain.
 *
 * - `base` / `base-sepolia` / any EVM chain → secp256k1 keypair via viem.
 *   Address is the checksummed 0x... string; private key is stored as a 0x-prefixed hex.
 * - `solana` → Ed25519 keypair via @solana/web3.js. Address is the base58 pubkey;
 *   private key is base58(secretKey).
 *
 * The `chain` field is normalised and returned alongside the keys so callers
 * always know which scheme produced the pair.
 */
export function generateWalletForChain(chain: string): GeneratedWallet {
  const normalised = (chain || '').toLowerCase();
  if (normalised === 'solana') {
    const kp = Keypair.generate();
    return {
      chain: 'solana',
      walletAddress: kp.publicKey.toBase58(),
      walletPrivateKey: bs58.encode(kp.secretKey),
    };
  }
  // Default: treat anything non-solana as EVM.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    chain: normalised || 'base',
    walletAddress: account.address,
    walletPrivateKey: privateKey,
  };
}

/** Quick detector for the address format (for legacy records). */
export function walletFormatOf(address: string): 'evm' | 'solana' | 'unknown' {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  return 'unknown';
}

/**
 * Verify that `signature` is a signature of `message` produced by the
 * key pair controlling `walletAddress`. Dispatches by address format:
 *
 *   - 0x…      → ECDSA over secp256k1 (viem verifyMessage, EIP-191).
 *                Signature must be a 0x-prefixed hex string (65 bytes).
 *   - base58   → Ed25519 via @solana/web3.js + tweetnacl. Signature
 *                must be base58-encoded (as Solana wallets sign).
 *
 * Returns false on any decode/verify error instead of throwing, so the
 * caller can decide the user-facing error message.
 */
export async function verifyWalletSignature(
  walletAddress: string,
  signature: string,
  message: string,
): Promise<boolean> {
  const fmt = walletFormatOf(walletAddress);

  if (fmt === 'evm') {
    try {
      const sig = signature.startsWith('0x') ? signature : `0x${signature}`;
      return await verifyMessage({
        address: walletAddress as `0x${string}`,
        message,
        signature: sig as `0x${string}`,
      });
    } catch {
      return false;
    }
  }

  if (fmt === 'solana') {
    try {
      const pubkey = new PublicKey(walletAddress);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(signature);
      return nacl.sign.detached.verify(messageBytes, signatureBytes, pubkey.toBytes());
    } catch {
      return false;
    }
  }

  return false;
}

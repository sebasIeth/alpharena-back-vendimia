import { Keypair } from '@solana/web3.js';
import * as bs58Mod from 'bs58';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

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

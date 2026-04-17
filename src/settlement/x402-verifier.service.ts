import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  createPublicClient,
  http,
  parseAbiItem,
  decodeEventLog,
  getAddress,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { walletFormatOf } from '../common/wallet.util';

// viem's PublicClient has a chain-parameterised generic that doesn't
// unify cleanly between baseSepolia/base imports (base adds OP-Stack
// deposit tx types). We only use structural members (getTransactionReceipt)
// so `any` is the least-bad option here.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type EvmPublicClient = any;

const ERC20_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * Verifies agent stake payments via the x402 protocol before match starts.
 *
 * Supports both chains:
 *   - Solana: fetch tx via @solana/web3.js and compare pre/post token balances
 *     on the platform wallet's token account.
 *   - EVM (Base): fetch the tx receipt via viem, decode the ERC-20 Transfer
 *     logs, and confirm the recipient received ≥ expectedAmount of USDC.
 *
 * Chain is auto-detected from the expected recipient address format, so
 * callers don't have to thread an explicit chain through.
 */
@Injectable()
export class X402VerifierService {
  private readonly logger = new Logger(X402VerifierService.name);
  private connection: Connection | null = null;
  private evmClient: EvmPublicClient | null = null;

  constructor(private readonly configService: ConfigService) {
    const solRpc = this.configService.solanaRpcUrl;
    if (solRpc) {
      this.connection = new Connection(solRpc, 'confirmed');
    }
    const evmRpc = this.configService.baseRpcUrl;
    if (evmRpc) {
      const chain = this.configService.baseChainId === 8453 ? base : baseSepolia;
      this.evmClient = createPublicClient({
        chain,
        transport: http(evmRpc),
      });
    }
  }

  /**
   * Verify an x402 payment receipt by checking the on-chain transaction.
   *
   * @param txSignature - Solana tx signature OR EVM 0x-prefixed tx hash
   * @param expectedAmount - Expected payment amount (in smallest token units)
   * @param expectedRecipient - Expected recipient address (platform wallet)
   * @returns true if the transaction is valid and confirmed
   */
  async verifyStakePayment(
    txSignature: string,
    expectedAmount: bigint,
    expectedRecipient: string,
  ): Promise<{ valid: boolean; error?: string }> {
    const recipientFormat = walletFormatOf(expectedRecipient);
    if (recipientFormat === 'evm') {
      return this.verifyEvmPayment(txSignature, expectedAmount, expectedRecipient);
    }
    return this.verifySolanaPayment(txSignature, expectedAmount, expectedRecipient);
  }

  private async verifySolanaPayment(
    txSignature: string,
    expectedAmount: bigint,
    expectedRecipient: string,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.connection) {
      this.logger.warn('x402 verification skipped — Solana connection not available');
      return { valid: true }; // Permissive in no-op mode
    }

    try {
      const tx = await this.connection.getTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        return { valid: false, error: `Transaction ${txSignature} not found or not confirmed` };
      }

      if (tx.meta?.err) {
        return { valid: false, error: `Transaction ${txSignature} failed on-chain: ${JSON.stringify(tx.meta.err)}` };
      }

      const recipientPubkey = new PublicKey(expectedRecipient);
      const postBalances = tx.meta?.postTokenBalances ?? [];
      const preBalances = tx.meta?.preTokenBalances ?? [];

      const recipientPost = postBalances.find((b) => b.owner === recipientPubkey.toBase58());
      const recipientPre = preBalances.find((b) => b.owner === recipientPubkey.toBase58());

      if (!recipientPost) {
        return { valid: false, error: `Recipient ${expectedRecipient} not found in transaction token balances` };
      }

      const postAmount = BigInt(recipientPost.uiTokenAmount.amount);
      const preAmount = recipientPre ? BigInt(recipientPre.uiTokenAmount.amount) : BigInt(0);
      const receivedAmount = postAmount - preAmount;

      if (receivedAmount < expectedAmount) {
        return {
          valid: false,
          error: `Insufficient payment: expected ${expectedAmount.toString()}, received ${receivedAmount.toString()}`,
        };
      }

      this.logger.log(`x402 Solana payment verified: txSig=${txSignature}, amount=${receivedAmount.toString()}`);
      return { valid: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`x402 Solana verification failed: ${message}`);
      return { valid: false, error: message };
    }
  }

  private async verifyEvmPayment(
    txHash: string,
    expectedAmount: bigint,
    expectedRecipient: string,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.evmClient) {
      this.logger.warn('x402 verification skipped — EVM client not available');
      return { valid: true };
    }

    try {
      const hash = (txHash.startsWith('0x') ? txHash : `0x${txHash}`) as `0x${string}`;
      const receipt = await this.evmClient.getTransactionReceipt({ hash });

      if (!receipt) {
        return { valid: false, error: `Transaction ${txHash} not found or not mined` };
      }
      if (receipt.status !== 'success') {
        return { valid: false, error: `Transaction ${txHash} reverted on-chain` };
      }

      const expectedRecipientChecksum = getAddress(expectedRecipient);
      const expectedUsdc = getAddress(this.configService.baseUsdcAddress);

      // Scan Transfer(...) logs from the USDC contract where `to` matches
      // the expected recipient. Accept the first match whose `value` is
      // large enough — this handles the common case where a single tx
      // contains a single USDC transfer to the platform wallet.
      let totalReceived = BigInt(0);
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== expectedUsdc) continue;
        try {
          const decoded = decodeEventLog({
            abi: [ERC20_TRANSFER_EVENT],
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== 'Transfer') continue;
          const args = decoded.args as unknown as { from: string; to: string; value: bigint };
          if (getAddress(args.to) === expectedRecipientChecksum) {
            totalReceived += args.value;
          }
        } catch {
          // non-Transfer event on the USDC contract — ignore
        }
      }

      if (totalReceived === BigInt(0)) {
        return {
          valid: false,
          error: `No USDC Transfer to recipient ${expectedRecipient} found in tx ${txHash}`,
        };
      }
      if (totalReceived < expectedAmount) {
        return {
          valid: false,
          error: `Insufficient payment: expected ${expectedAmount.toString()}, received ${totalReceived.toString()}`,
        };
      }

      this.logger.log(`x402 EVM payment verified: txHash=${txHash}, amount=${totalReceived.toString()}`);
      return { valid: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`x402 EVM verification failed: ${message}`);
      return { valid: false, error: message };
    }
  }
}

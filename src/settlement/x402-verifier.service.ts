import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import {
  createPublicClient,
  http,
  decodeEventLog,
  type Address,
  type Chain,
} from 'viem';
import * as chains from 'viem/chains';
import { erc20Abi } from './contracts/arena-abi';

/**
 * Verifies agent stake payments via the x402 protocol on Base (EVM).
 *
 * Flow:
 *   1. Agent pays via x402 → receives payment receipt with tx hash
 *   2. Backend calls verifyStakePayment() with the receipt
 *   3. Service confirms the on-chain tx: correct amount, correct recipient, confirmed status
 */
@Injectable()
export class X402VerifierService {
  private readonly logger = new Logger(X402VerifierService.name);
  private publicClient: ReturnType<typeof createPublicClient> | null = null;

  constructor(private readonly configService: ConfigService) {
    const rpcUrl = this.configService.rpcUrl;
    if (rpcUrl) {
      const chainId = this.configService.chainId;
      const chain = this.resolveChain(chainId);
      this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    }
  }

  private resolveChain(chainId: number): Chain {
    for (const value of Object.values(chains)) {
      if (typeof value === 'object' && value !== null && 'id' in value && (value as Chain).id === chainId) {
        return value as Chain;
      }
    }
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  /**
   * Verify an x402 payment receipt by checking the on-chain transaction on Base.
   *
   * @param txHash - The Base transaction hash from the x402 receipt
   * @param expectedAmount - Expected payment amount (in smallest token units)
   * @param expectedRecipient - Expected recipient address (platform wallet)
   * @returns true if the transaction is valid and confirmed
   */
  async verifyStakePayment(
    txHash: string,
    expectedAmount: bigint,
    expectedRecipient: string,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.publicClient) {
      this.logger.warn('x402 verification skipped — RPC not configured');
      return { valid: true }; // Permissive in no-op mode
    }

    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });

      if (!receipt) {
        return { valid: false, error: `Transaction ${txHash} not found` };
      }

      if (receipt.status === 'reverted') {
        return { valid: false, error: `Transaction ${txHash} reverted` };
      }

      // Parse ERC-20 Transfer events from the receipt logs
      const transferEventSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const recipientLower = expectedRecipient.toLowerCase();

      let totalReceived = BigInt(0);

      for (const log of receipt.logs) {
        if (log.topics[0] !== transferEventSig) continue;

        try {
          const decoded = decodeEventLog({
            abi: [
              {
                type: 'event',
                name: 'Transfer',
                inputs: [
                  { name: 'from', type: 'address', indexed: true },
                  { name: 'to', type: 'address', indexed: true },
                  { name: 'value', type: 'uint256', indexed: false },
                ],
              },
            ],
            data: log.data,
            topics: log.topics,
          });

          const to = (decoded.args as any).to as string;
          const value = (decoded.args as any).value as bigint;

          if (to.toLowerCase() === recipientLower) {
            totalReceived += value;
          }
        } catch {
          continue;
        }
      }

      if (totalReceived < expectedAmount) {
        return {
          valid: false,
          error: `Insufficient payment: expected ${expectedAmount.toString()}, received ${totalReceived.toString()}`,
        };
      }

      this.logger.log(`x402 payment verified: txHash=${txHash}, amount=${totalReceived.toString()}`);
      return { valid: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`x402 verification failed: ${message}`);
      return { valid: false, error: message };
    }
  }
}

import { IsString, MinLength } from 'class-validator';

export class RegisterWalletDto {
  @IsString()
  @MinLength(32, { message: 'Invalid Solana wallet address' })
  walletAddress: string;

  @IsString()
  @MinLength(1, { message: 'Signature is required' })
  signature: string;

  @IsString()
  @MinLength(1, { message: 'Nonce is required' })
  nonce: string;
}

export class WalletNonceDto {
  @IsString()
  @MinLength(32, { message: 'Invalid Solana wallet address' })
  walletAddress: string;
}

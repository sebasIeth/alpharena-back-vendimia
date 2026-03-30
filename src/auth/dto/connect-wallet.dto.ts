import { IsString, MinLength, IsIn } from 'class-validator';

export class ConnectWalletDto {
  @IsString()
  @MinLength(32, { message: 'Invalid Solana wallet address' })
  walletAddress: string;

  @IsString()
  @MinLength(1, { message: 'Signature is required' })
  signature: string;
}

export class SwitchWalletDto {
  @IsIn(['custodial', 'external'], { message: 'walletType must be "custodial" or "external"' })
  walletType: string;
}

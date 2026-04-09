import { IsString, MinLength, MaxLength, IsArray, IsIn, IsOptional } from 'class-validator';

export class RegisterAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  agentProvider?: string;

  @IsOptional()
  @IsArray()
  @IsIn(['chess', 'poker', 'marrakech', 'reversi', 'uno'], { each: true })
  gameTypes?: string[];

  @IsOptional()
  @IsString()
  walletAddress?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

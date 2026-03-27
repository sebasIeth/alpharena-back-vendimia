import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SettlementService } from './settlement.service';
import { SettlementRouterService } from './settlement-router.service';
import { X402VerifierService } from './x402-verifier.service';
import { X402StakeController } from './x402-stake.controller';
import { X402PaymentStore } from './x402-payment-store.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiKeyAuthGuard } from '../common/guards/api-key-auth.guard';
import { JwtOrApiKeyGuard } from '../common/guards/jwt-or-apikey.guard';
import { Agent, AgentSchema } from '../database/schemas';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Agent.name, schema: AgentSchema }])],
  controllers: [X402StakeController],
  providers: [SettlementService, SettlementRouterService, X402VerifierService, X402StakeController, X402PaymentStore, JwtAuthGuard, ApiKeyAuthGuard, JwtOrApiKeyGuard],
  exports: [SettlementService, SettlementRouterService, X402VerifierService, X402StakeController, X402PaymentStore],
})
export class SettlementModule {}

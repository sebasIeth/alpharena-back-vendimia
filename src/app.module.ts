import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './common/config/config.module';
import { ConfigService } from './common/config/config.service';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { MatchesModule } from './matches/matches.module';
import { MatchmakingModule } from './matchmaking/matchmaking.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { SettlementModule } from './settlement/settlement.module';
import { RealtimeModule } from './realtime/realtime.module';
import { WorkerModule } from './worker/worker.module';
import { GameEngineModule } from './game-engine/game-engine.module';
import { OpenClawWsModule } from './openclaw-ws';
import { PlayModule } from './play/play.module';
import { MailModule } from './mail/mail.module';
import { ScheduledMatchesModule } from './scheduled-matches/scheduled-matches.module';
import { BettingModule } from './betting/betting.module';
import { AgentApiModule } from './agent-api/agent-api.module';
import { ReferralsModule } from './referrals/referrals.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.mongodbUri,
        maxPoolSize: 10,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      }),
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 20,
    }]),
    ScheduleModule.forRoot(),
    MailModule,
    OpenClawWsModule,
    AuthModule,
    AgentsModule,
    MatchesModule,
    MatchmakingModule,
    LeaderboardModule,
    OrchestratorModule,
    SettlementModule,
    RealtimeModule,
    PlayModule,
    ScheduledMatchesModule,
    BettingModule,
    AgentApiModule,
    ReferralsModule,
    WorkerModule,
    GameEngineModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

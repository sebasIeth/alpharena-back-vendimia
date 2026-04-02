import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { Agent } from '../database/schemas';

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
  ) {}

  async getClaimStatus(claimToken: string) {
    const agent = await this.agentModel.findOne({ claimToken });
    if (!agent) {
      throw new NotFoundException('Claim token not found');
    }

    return {
      claimToken,
      agentId: agent._id.toString(),
      agentName: agent.name,
      apiKeyPrefix: agent.apiKeyPrefix,
      claimStatus: agent.claimStatus,
      xUsername: agent.xUsername,
    };
  }

  async generateXChallenge(claimToken: string) {
    const agent = await this.agentModel.findOne({ claimToken });
    if (!agent) {
      throw new NotFoundException('Claim token not found');
    }

    if (agent.claimStatus === 'claimed') {
      throw new BadRequestException('Agent is already claimed');
    }

    const code = randomBytes(4).toString('hex');
    const challengeText = `Verifying my agent "${agent.name}" (${agent.apiKeyPrefix}) on @_alphaarena. Code: ${code}`;

    agent.xVerificationChallenge = challengeText;
    agent.claimStatus = 'pending';
    await agent.save();

    this.logger.log(`Generated X verification challenge for agent ${agent._id}`);

    return {
      challengeText,
      instructions: 'Post this exact text on X/Twitter, then submit the URL of your post.',
    };
  }

  async submitXVerification(claimToken: string, tweetUrl: string) {
    const agent = await this.agentModel.findOne({ claimToken });
    if (!agent) {
      throw new NotFoundException('Claim token not found');
    }

    if (agent.claimStatus === 'claimed') {
      throw new BadRequestException('Agent is already claimed');
    }

    if (!agent.xVerificationChallenge) {
      throw new BadRequestException('No verification challenge generated. Call the challenge endpoint first.');
    }

    // Validate tweet URL format
    const urlPattern = /^https?:\/\/(x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/(\d+)/;
    const match = tweetUrl.match(urlPattern);
    if (!match) {
      throw new BadRequestException('Invalid tweet URL. Expected: https://x.com/username/status/123...');
    }

    const xUsername = match[2];

    // Verify tweet content via oEmbed (free, no auth required)
    try {
      const oEmbedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`;
      const response = await fetch(oEmbedUrl);

      if (!response.ok) {
        throw new BadRequestException('Could not fetch tweet. Make sure the tweet is public.');
      }

      const data = await response.json() as { html: string; author_name: string };
      const html = data.html;

      // Check if the challenge text is present in the tweet HTML
      if (!html.includes(agent.xVerificationChallenge)) {
        throw new BadRequestException(
          'Tweet does not contain the verification challenge text. Make sure you posted the exact text.',
        );
      }

      // Verification succeeded
      agent.claimStatus = 'claimed';
      agent.xUsername = xUsername;
      agent.xVerificationPostUrl = tweetUrl;
      await agent.save();

      this.logger.log(`Agent ${agent._id} claimed by X user @${xUsername}`);

      return {
        success: true,
        agentId: agent._id.toString(),
        xUsername,
        claimStatus: 'claimed',
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`X verification failed for agent ${agent._id}: ${err}`);
      throw new BadRequestException('Verification failed. Could not verify tweet content.');
    }
  }
}

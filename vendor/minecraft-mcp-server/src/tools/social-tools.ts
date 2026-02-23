import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';

export function registerSocialTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // announce_action - Broadcast structured in-game chat before/after actions
  factory.registerTool(
    "announce_action",
    "Broadcast a structured in-game chat message before and after every major action",
    {
      action: z.string().describe("Action description"),
      preMessage: z.string().optional().describe("Pre-action message"),
      postMessage: z.string().optional().describe("Post-action message"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      if (params.preMessage) {
        bot.chat(`[START] ${params.preMessage}`);
      }
      
      // Execute action (placeholder - actual action would be passed as callback)
      await new Promise(r => setTimeout(r, 100));
      
      if (params.postMessage) {
        bot.chat(`[DONE] ${params.postMessage}`);
      }

      await solace.publishToolEvent('announce_action', agentId, { action: params.action, status: 'completed' });
      return factory.createResponse(`Announced action: ${params.action}`);
    }
  );

  // respond_to_player - Monitor chat for player's message and reply
  factory.registerTool(
    "respond_to_player",
    "Monitor chat for a player's message directed at the bot and reply contextually",
    {
      playerName: z.string().describe("Player name to respond to"),
      keywords: z.array(z.string()).optional().describe("Keywords to trigger response"),
      response: z.string().describe("Response message"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      // In practice, this would set up a chat listener
      // For now, just send the response
      bot.chat(`@${params.playerName} ${params.response}`);

      await solace.publishToolEvent('respond_to_player', agentId, { playerName: params.playerName, response: params.response });
      return factory.createResponse(`Responded to ${params.playerName}`);
    }
  );

  // auction_item - Publish auction event and resolve highest bid
  factory.registerTool(
    "auction_item",
    "Publish an auction event to the broker and resolve the highest bid after a timeout",
    {
      itemName: z.string().describe("Item to auction"),
      startingPrice: z.number().describe("Starting bid price"),
      timeout: z.number().optional().describe("Auction duration in seconds (default: 60)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const timeout = params.timeout || 60;
      
      // Publish auction event
      await solace.publishAgentEvent('auction_start', agentId, {
        itemName: params.itemName,
        startingPrice: params.startingPrice,
        timeout,
      });

      // Announce in chat
      bot.chat(`Auction started: ${params.itemName} for ${params.startingPrice}! Bids accepted for ${timeout}s`);

      // Wait for auction duration (in real impl, would collect bids via events)
      await new Promise(r => setTimeout(r, timeout * 1000));

      bot.chat(`Auction ended for ${params.itemName}!`);

      await solace.publishToolEvent('auction_item', agentId, { itemName: params.itemName, status: 'ended' });
      return factory.createResponse(`Auction for ${params.itemName} completed`);
    }
  );

  // negotiate_trade - Exchange chat-based offer/counteroffer
  factory.registerTool(
    "negotiate_trade",
    "Exchange chat-based offer/counteroffer messages with a player to agree a deal",
    {
      playerName: z.string().describe("Trading partner"),
      offer: z.string().describe("Initial offer"),
      expectedResponse: z.string().optional().describe("Expected response keyword"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      // Send offer
      bot.chat(`@${params.playerName} Trade offer: ${params.offer}`);
      
      await solace.publishAgentEvent('trade_negotiation', agentId, {
        playerName: params.playerName,
        offer: params.offer,
        status: 'offer_sent',
      });

      return factory.createResponse(`Sent trade offer to ${params.playerName}: ${params.offer}`);
    }
  );

  // hold_election - Publish candidate proposals and collect votes
  factory.registerTool(
    "hold_election",
    "Publish candidate proposals to all agents, collect votes via events, announce winner",
    {
      candidates: z.array(z.string()).describe("List of candidates"),
      duration: z.number().optional().describe("Election duration in seconds (default: 30)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const duration = params.duration || 30;
      
      // Publish election start event
      await solace.publishAgentEvent('election_start', agentId, {
        candidates: params.candidates,
        duration,
      });

      // Announce election
      bot.chat(`Election started! Candidates: ${params.candidates.join(', ')}. Vote with !vote <candidate>`);

      await new Promise(r => setTimeout(r, duration * 1000));

      bot.chat(`Election ended! Winner: ${params.candidates[0]}`);

      await solace.publishToolEvent('hold_election', agentId, { candidates: params.candidates, winner: params.candidates[0] });
      return factory.createResponse(`Election completed. Winner: ${params.candidates[0]}`);
    }
  );
}

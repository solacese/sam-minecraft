import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { log } from './logger.js';

/**
 * IdleAnimationManager - Makes bots feel more alive with idle behaviors
 * 
 * When idle: Look around randomly, look at players, look at other bots
 * When thinking: Switch between wood and stone in hand
 */
export class IdleAnimationManager {
  private bot: Bot;
  private isThinking: boolean = false;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private thinkingInterval: ReturnType<typeof setInterval> | null = null;
  private lastLookTime: number = 0;
  private nextLookDelay: number = 3000;
  private thinkingItemIndex: number = 0;
  private readonly thinkingItems = ['oak_planks', 'stone', 'oak_planks', 'cobblestone'];
  
  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Start the idle animation loop
   */
  start(): void {
    log('info', 'Starting idle animation system');
    
    // Main idle loop - runs every 500ms
    this.idleInterval = setInterval(() => {
      if (!this.isThinking) {
        this.performIdleBehavior();
      }
    }, 500);
  }

  /**
   * Set thinking state - switches to item-swapping animation
   */
  setThinking(thinking: boolean): void {
    this.isThinking = thinking;
    
    if (thinking) {
      this.startThinkingAnimation();
    } else {
      this.stopThinkingAnimation();
    }
  }

  /**
   * Stop all animations and cleanup
   */
  stop(): void {
    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }
    this.stopThinkingAnimation();
    log('info', 'Idle animation system stopped');
  }

  /**
   * Perform idle behavior - look around, at players, or at other bots
   */
  private performIdleBehavior(): void {
    const now = Date.now();
    
    // Check if it's time to look somewhere
    if (now - this.lastLookTime < this.nextLookDelay) {
      return;
    }
    
    this.lastLookTime = now;
    this.nextLookDelay = this.randomBetween(3000, 8000); // 3-8 seconds
    
    // Priority: 1) Look at nearby player, 2) Look at other bot, 3) Random look
    const target = this.findLookTarget();
    
    if (target) {
      this.lookAt(target);
    } else {
      this.lookRandom();
    }
  }

  /**
   * Find a target to look at (player or other bot)
   */
  private findLookTarget(): Vec3 | null {
    const pos = this.bot.entity.position;
    const entities = Object.values(this.bot.entities);
    
    // Find nearby players (within 10 blocks)
    const nearbyPlayers = entities.filter((e: any) => 
      e.type === 'player' && 
      e !== this.bot.entity &&
      e.position.distanceTo(pos) <= 10
    );
    
    // Find other bots (by username pattern)
    const otherBots = entities.filter((e: any) => 
      e.type === 'player' && 
      e !== this.bot.entity &&
      e.position.distanceTo(pos) <= 15 &&
      this.isAgentBot(e.username)
    );
    
    // 60% chance to look at player if nearby
    if (nearbyPlayers.length > 0 && Math.random() < 0.6) {
      const player = nearbyPlayers[Math.floor(Math.random() * nearbyPlayers.length)] as any;
      return player.position.offset(0, 1.6, 0); // Look at head height
    }
    
    // 40% chance to look at other bot if nearby
    if (otherBots.length > 0 && Math.random() < 0.4) {
      const otherBot = otherBots[Math.floor(Math.random() * otherBots.length)] as any;
      return otherBot.position.offset(0, 1.6, 0);
    }
    
    return null;
  }

  /**
   * Check if a username belongs to one of our agent bots
   */
  private isAgentBot(username: string): boolean {
    if (!username) return false;
    const agentNames = ['HandyHank', 'DesignDora', 'SupplySid', 'BuildBea', 'ForestFinn'];
    return agentNames.some(name => username.toLowerCase().includes(name.toLowerCase()));
  }

  /**
   * Look at a specific position
   */
  private lookAt(target: Vec3): void {
    try {
      this.bot.lookAt(target, false); // false = don't force (smooth movement)
    } catch (err) {
      // Ignore look errors
    }
  }

  /**
   * Look in a random direction
   */
  private lookRandom(): void {
    try {
      const pos = this.bot.entity.position;
      
      // Random offset within 10 blocks
      const dx = this.randomBetween(-10, 10);
      const dy = this.randomBetween(-2, 3); // Slight vertical variation
      const dz = this.randomBetween(-10, 10);
      
      const target = pos.offset(dx, dy, dz);
      this.bot.lookAt(target, false);
    } catch (err) {
      // Ignore look errors
    }
  }

  /**
   * Start the thinking animation (item switching)
   */
  private startThinkingAnimation(): void {
    this.thinkingItemIndex = 0;
    
    // Switch items every 800-1200ms
    this.thinkingInterval = setInterval(() => {
      this.switchThinkingItem();
    }, this.randomBetween(800, 1200));
    
    // Do first switch immediately
    this.switchThinkingItem();
  }

  /**
   * Stop the thinking animation
   */
  private stopThinkingAnimation(): void {
    if (this.thinkingInterval) {
      clearInterval(this.thinkingInterval);
      this.thinkingInterval = null;
    }
  }

  /**
   * Switch to the next thinking item (wood/stone)
   */
  private switchThinkingItem(): void {
    try {
      const item = this.thinkingItems[this.thinkingItemIndex];
      this.thinkingItemIndex = (this.thinkingItemIndex + 1) % this.thinkingItems.length;
      
      // Use /replaceitem to put the item in hand
      this.bot.chat(`/replaceitem entity @s weapon.mainhand minecraft:${item} 1`);
    } catch (err) {
      // Ignore errors - item switching is cosmetic
    }
  }

  /**
   * Random number between min and max (inclusive)
   */
  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
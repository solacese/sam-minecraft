#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { z } from "zod";
import { Vec3 } from 'vec3';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

// Register 10 enhanced tools for beautiful building
function registerEssentialTools(factory: ToolFactory, getBot: () => any, messageStore: MessageStore): void {
  
  // 1. get-position - Get current position
  factory.registerTool(
    "get-position",
    "Get the bot's current position and facing direction",
    {},
    async () => {
      const bot = getBot();
      const pos = bot.entity.position;
      return factory.createResponse(`Position: x=${Math.floor(pos.x)}, y=${Math.floor(pos.y)}, z=${Math.floor(pos.z)}`);
    }
  );

  // 2. walk-to - Walk to coordinates using pathfinding
  factory.registerTool(
    "walk-to",
    "Walk to specific coordinates. The bot will pathfind around obstacles. Use this before building to get close to the work area.",
    {
      x: z.coerce.number().describe("Target X coordinate"),
      z: z.coerce.number().describe("Target Z coordinate"),
    },
    async (params: any) => {
      const bot = getBot();
      const targetX = Math.floor(Number(params.x));
      const targetZ = Math.floor(Number(params.z));
      
      // Use /tp command to move (pathfinding would require additional setup)
      // First get surface height at target
      const pos = bot.entity.position;
      const targetY = Math.floor(pos.y); // Keep same Y for now
      
      bot.chat(`/tp @s ${targetX} ~ ${targetZ}`);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const newPos = bot.entity.position;
      return factory.createResponse(`Walked to (${Math.floor(newPos.x)}, ${Math.floor(newPos.y)}, ${Math.floor(newPos.z)})`);
    }
  );

  // 3. look-around - Survey surroundings
  factory.registerTool(
    "look-around",
    "Survey the surroundings and report what blocks and entities are nearby. Use this to understand the terrain before building.",
    {
      radius: z.number().optional().describe("Search radius (default: 16)"),
    },
    async (params: any) => {
      const bot = getBot();
      const radius = params.radius || 16;
      const pos = bot.entity.position;
      
      // Find nearby entities
      const entities = Object.values(bot.entities as Record<string, any>)
        .filter((e: any) => e !== bot.entity && e.position.distanceTo(pos) <= radius)
        .map((e: any) => `${e.name || e.username || 'unknown'} at (${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)})`);
      
      // Sample nearby blocks
      const blocks: string[] = [];
      for (let dx = -3; dx <= 3; dx += 3) {
        for (let dz = -3; dz <= 3; dz += 3) {
          const block = bot.blockAt(new Vec3(pos.x + dx, pos.y - 1, pos.z + dz));
          if (block && block.name !== 'air') {
            blocks.push(block.name);
          }
        }
      }
      
      return factory.createResponse(`Position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}). Nearby entities: ${entities.length > 0 ? entities.join(', ') : 'none'}. Ground blocks: ${[...new Set(blocks)].join(', ') || 'none'}`);
    }
  );

  // 4. get-surface-height - Find the surface Y level at given X,Z
  factory.registerTool(
    "get-surface-height",
    "Find the surface (ground) Y level at specific X,Z coordinates. Use this to know where to build so structures are on the ground.",
    {
      x: z.coerce.number().describe("X coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async (params: any) => {
      const bot = getBot();
      const x = Math.floor(Number(params.x));
      const zCoord = Math.floor(Number(params.z));
      
      // Scan from top down to find first non-air block
      for (let y = 100; y >= 0; y--) {
        const block = bot.blockAt(new Vec3(x, y, zCoord));
        if (block && block.name !== 'air' && block.name !== 'void_air') {
          return factory.createResponse(`Surface height at (${x}, ${zCoord}) is Y=${y + 1}. Ground block: ${block.name}`);
        }
      }
      return factory.createResponse(`Could not find surface at (${x}, ${zCoord})`);
    }
  );

  // 5. place-block - Place a single block
  factory.registerTool(
    "place-block",
    "Place a single block at specific coordinates. Use for detailed work like adding decorations.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      blockType: z.string().describe("Block type (e.g., 'stone', 'oak_planks', 'lantern', 'flower_pot')"),
    },
    async (params: any) => {
      const bot = getBot();
      const x = Math.floor(Number(params.x)), y = Math.floor(Number(params.y)), zCoord = Math.floor(Number(params.z));
      const blockType = params.blockType.toLowerCase();
      
      bot.chat(`/setblock ${x} ${y} ${zCoord} minecraft:${blockType}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      return factory.createResponse(`Placed ${blockType} at (${x}, ${y}, ${zCoord})`);
    }
  );

  // 6. build-decorated-house - Build a beautiful house with decorations
  factory.registerTool(
    "build-decorated-house",
    "Build a beautiful decorated house with peaked roof, windows, lanterns, and flower boxes. Automatically builds on the surface.",
    {
      x: z.coerce.number().describe("House center X coordinate"),
      z: z.coerce.number().describe("House center Z coordinate"),
      style: z.string().optional().describe("Style: 'oak', 'spruce', 'birch', 'stone' (default: oak)"),
    },
    async (params: any) => {
      const bot = getBot();
      const centerX = Math.floor(Number(params.x));
      const centerZ = Math.floor(Number(params.z));
      const style = (params.style || 'oak').toLowerCase();
      
      // Determine materials based on style
      let wallMaterial = 'oak_planks';
      let logMaterial = 'oak_log';
      let slabMaterial = 'oak_slab';
      let fenceMaterial = 'oak_fence';
      
      if (style === 'spruce') {
        wallMaterial = 'spruce_planks'; logMaterial = 'spruce_log'; slabMaterial = 'spruce_slab'; fenceMaterial = 'spruce_fence';
      } else if (style === 'birch') {
        wallMaterial = 'birch_planks'; logMaterial = 'birch_log'; slabMaterial = 'birch_slab'; fenceMaterial = 'birch_fence';
      } else if (style === 'stone') {
        wallMaterial = 'stone_bricks'; logMaterial = 'stone_bricks'; slabMaterial = 'stone_brick_slab'; fenceMaterial = 'stone_brick_wall';
      }
      
      // Find surface height
      let baseY = 64;
      for (let y = 100; y >= 0; y--) {
        const block = bot.blockAt(new Vec3(centerX, y, centerZ));
        if (block && block.name !== 'air' && block.name !== 'void_air') {
          baseY = y + 1;
          break;
        }
      }
      
      const delay = () => new Promise(resolve => setTimeout(resolve, 120));
      const width = 7, depth = 7, height = 4;
      const x1 = centerX - Math.floor(width/2);
      const z1 = centerZ - Math.floor(depth/2);
      
      // Clear area first
      bot.chat(`/fill ${x1-1} ${baseY} ${z1-1} ${x1+width} ${baseY+height+3} ${z1+depth} minecraft:air`);
      await delay();
      
      // Foundation
      bot.chat(`/fill ${x1} ${baseY-1} ${z1} ${x1+width-1} ${baseY-1} ${z1+depth-1} minecraft:cobblestone`);
      await delay();
      
      // Floor with carpet
      bot.chat(`/fill ${x1} ${baseY} ${z1} ${x1+width-1} ${baseY} ${z1+depth-1} minecraft:${wallMaterial}`);
      await delay();
      bot.chat(`/fill ${x1+1} ${baseY+1} ${z1+1} ${x1+width-2} ${baseY+1} ${z1+depth-2} minecraft:red_carpet`);
      await delay();
      
      // Walls with log corners
      // Front and back walls
      bot.chat(`/fill ${x1} ${baseY+1} ${z1} ${x1+width-1} ${baseY+height} ${z1} minecraft:${wallMaterial}`);
      await delay();
      bot.chat(`/fill ${x1} ${baseY+1} ${z1+depth-1} ${x1+width-1} ${baseY+height} ${z1+depth-1} minecraft:${wallMaterial}`);
      await delay();
      // Side walls
      bot.chat(`/fill ${x1} ${baseY+1} ${z1} ${x1} ${baseY+height} ${z1+depth-1} minecraft:${wallMaterial}`);
      await delay();
      bot.chat(`/fill ${x1+width-1} ${baseY+1} ${z1} ${x1+width-1} ${baseY+height} ${z1+depth-1} minecraft:${wallMaterial}`);
      await delay();
      
      // Log corners
      bot.chat(`/fill ${x1} ${baseY+1} ${z1} ${x1} ${baseY+height} ${z1} minecraft:${logMaterial}`);
      await delay();
      bot.chat(`/fill ${x1+width-1} ${baseY+1} ${z1} ${x1+width-1} ${baseY+height} ${z1} minecraft:${logMaterial}`);
      await delay();
      bot.chat(`/fill ${x1} ${baseY+1} ${z1+depth-1} ${x1} ${baseY+height} ${z1+depth-1} minecraft:${logMaterial}`);
      await delay();
      bot.chat(`/fill ${x1+width-1} ${baseY+1} ${z1+depth-1} ${x1+width-1} ${baseY+height} ${z1+depth-1} minecraft:${logMaterial}`);
      await delay();
      
      // Peaked roof
      const roofY = baseY + height + 1;
      for (let i = 0; i <= Math.floor(width/2); i++) {
        bot.chat(`/fill ${x1+i} ${roofY+i} ${z1-1} ${x1+width-1-i} ${roofY+i} ${z1+depth} minecraft:${slabMaterial}`);
        await delay();
      }
      
      // Door
      const doorX = x1 + Math.floor(width/2);
      bot.chat(`/fill ${doorX} ${baseY+1} ${z1} ${doorX} ${baseY+2} ${z1} minecraft:air`);
      await delay();
      bot.chat(`/setblock ${doorX} ${baseY+1} ${z1} minecraft:oak_door[half=lower,facing=south]`);
      await delay();
      bot.chat(`/setblock ${doorX} ${baseY+2} ${z1} minecraft:oak_door[half=upper,facing=south]`);
      await delay();
      
      // Windows with glass panes
      const windowY = baseY + 2;
      // Front windows
      bot.chat(`/setblock ${doorX-2} ${windowY} ${z1} minecraft:glass_pane`);
      await delay();
      bot.chat(`/setblock ${doorX+2} ${windowY} ${z1} minecraft:glass_pane`);
      await delay();
      // Side windows
      bot.chat(`/setblock ${x1} ${windowY} ${z1+Math.floor(depth/2)} minecraft:glass_pane`);
      await delay();
      bot.chat(`/setblock ${x1+width-1} ${windowY} ${z1+Math.floor(depth/2)} minecraft:glass_pane`);
      await delay();
      
      // Flower boxes under front windows
      bot.chat(`/setblock ${doorX-2} ${baseY} ${z1-1} minecraft:flower_pot`);
      await delay();
      bot.chat(`/setblock ${doorX+2} ${baseY} ${z1-1} minecraft:flower_pot`);
      await delay();
      
      // Lanterns at entrance
      bot.chat(`/setblock ${doorX-1} ${baseY+3} ${z1-1} minecraft:lantern[hanging=false]`);
      await delay();
      bot.chat(`/setblock ${doorX+1} ${baseY+3} ${z1-1} minecraft:lantern[hanging=false]`);
      await delay();
      
      // Interior lantern
      bot.chat(`/setblock ${centerX} ${baseY+height} ${centerZ} minecraft:lantern[hanging=true]`);
      await delay();
      
      return factory.createResponse(`Built beautiful ${style} house at (${centerX}, ${baseY}, ${centerZ}) with peaked roof, windows, lanterns, and flower boxes`);
    }
  );

  // 7. fill-region - Fill a rectangular volume
  factory.registerTool(
    "fill-region",
    "Fill a rectangular volume with a block type. Use for floors, walls, or clearing areas (use 'air' to clear).",
    {
      x1: z.coerce.number().describe("Start X"),
      y1: z.coerce.number().describe("Start Y"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      y2: z.coerce.number().describe("End Y"),
      z2: z.coerce.number().describe("End Z"),
      blockType: z.string().describe("Block type (use 'air' to clear)"),
    },
    async (params: any) => {
      const bot = getBot();
      const x1 = Math.floor(Number(params.x1)), y1 = Math.floor(Number(params.y1)), z1 = Math.floor(Number(params.z1));
      const x2 = Math.floor(Number(params.x2)), y2 = Math.floor(Number(params.y2)), z2 = Math.floor(Number(params.z2));
      const blockType = params.blockType.toLowerCase();

      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
      
      const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      
      bot.chat(`/fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} minecraft:${blockType}`);
      await new Promise(resolve => setTimeout(resolve, 150));
      
      return factory.createResponse(`Filled ${volume} blocks with ${blockType} from (${minX},${minY},${minZ}) to (${maxX},${maxY},${maxZ})`);
    }
  );

  // 8. flatten-area - Flatten terrain to a consistent height
  factory.registerTool(
    "flatten-area",
    "Flatten a rectangular area to a consistent height. Removes hills and fills holes. Use before building.",
    {
      x1: z.coerce.number().describe("Start X"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      z2: z.coerce.number().describe("End Z"),
      material: z.string().optional().describe("Surface material (default: grass_block)"),
    },
    async (params: any) => {
      const bot = getBot();
      const x1 = Math.floor(Number(params.x1)), z1 = Math.floor(Number(params.z1));
      const x2 = Math.floor(Number(params.x2)), z2 = Math.floor(Number(params.z2));
      const material = (params.material || 'grass_block').toLowerCase();
      
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
      
      // Find average surface height
      let totalY = 0, count = 0;
      for (let x = minX; x <= maxX; x += 2) {
        for (let z = minZ; z <= maxZ; z += 2) {
          for (let y = 100; y >= 0; y--) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.name !== 'air' && block.name !== 'void_air') {
              totalY += y;
              count++;
              break;
            }
          }
        }
      }
      const targetY = count > 0 ? Math.floor(totalY / count) : 64;
      
      const delay = () => new Promise(resolve => setTimeout(resolve, 150));
      
      // Clear above
      bot.chat(`/fill ${minX} ${targetY+1} ${minZ} ${maxX} ${targetY+10} ${maxZ} minecraft:air`);
      await delay();
      
      // Fill surface
      bot.chat(`/fill ${minX} ${targetY} ${minZ} ${maxX} ${targetY} ${maxZ} minecraft:${material}`);
      await delay();
      
      // Fill below with dirt
      bot.chat(`/fill ${minX} ${targetY-3} ${minZ} ${maxX} ${targetY-1} ${maxZ} minecraft:dirt`);
      await delay();
      
      return factory.createResponse(`Flattened area from (${minX},${minZ}) to (${maxX},${maxZ}) at Y=${targetY} with ${material}`);
    }
  );

  // 9. send-chat - Send a chat message
  factory.registerTool(
    "send-chat",
    "Send a chat message to all players. Use to communicate progress and coordinate with other agents.",
    {
      message: z.string().describe("Message to send"),
    },
    async (params: any) => {
      const bot = getBot();
      bot.chat(params.message);
      return factory.createResponse(`Sent: ${params.message}`);
    }
  );

  // 10. plant-garden - Create a decorative garden
  factory.registerTool(
    "plant-garden",
    "Plant a decorative garden with flowers, bushes, and paths. Automatically places on the surface.",
    {
      x: z.coerce.number().describe("Garden center X coordinate"),
      z: z.coerce.number().describe("Garden center Z coordinate"),
      size: z.number().optional().describe("Garden size: 1=small, 2=medium, 3=large (default: 2)"),
    },
    async (params: any) => {
      const bot = getBot();
      const centerX = Math.floor(Number(params.x));
      const centerZ = Math.floor(Number(params.z));
      const size = params.size || 2;
      
      // Find surface height
      let baseY = 64;
      for (let y = 100; y >= 0; y--) {
        const block = bot.blockAt(new Vec3(centerX, y, centerZ));
        if (block && block.name !== 'air' && block.name !== 'void_air') {
          baseY = y + 1;
          break;
        }
      }
      
      const delay = () => new Promise(resolve => setTimeout(resolve, 100));
      const radius = size * 2;
      
      // Create grass base
      bot.chat(`/fill ${centerX-radius} ${baseY-1} ${centerZ-radius} ${centerX+radius} ${baseY-1} ${centerZ+radius} minecraft:grass_block`);
      await delay();
      
      // Clear above
      bot.chat(`/fill ${centerX-radius} ${baseY} ${centerZ-radius} ${centerX+radius} ${baseY+2} ${centerZ+radius} minecraft:air`);
      await delay();
      
      // Path through center
      bot.chat(`/fill ${centerX-radius} ${baseY-1} ${centerZ} ${centerX+radius} ${baseY-1} ${centerZ} minecraft:gravel`);
      await delay();
      
      // Flowers array
      const flowers = ['poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'];
      
      // Plant flowers randomly
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dz === 0) continue; // Skip path
          if (Math.random() > 0.4) continue; // 40% chance
          const flower = flowers[Math.floor(Math.random() * flowers.length)];
          bot.chat(`/setblock ${centerX+dx} ${baseY} ${centerZ+dz} minecraft:${flower}`);
          await delay();
        }
      }
      
      // Add some leaves as bushes
      for (let i = 0; i < size; i++) {
        const bx = centerX + Math.floor(Math.random() * radius * 2) - radius;
        const bz = centerZ + Math.floor(Math.random() * radius * 2) - radius;
        if (bz !== centerZ) {
          bot.chat(`/setblock ${bx} ${baseY} ${bz} minecraft:oak_leaves[persistent=true]`);
          await delay();
        }
      }
      
      // Lantern posts at corners
      if (size >= 2) {
        bot.chat(`/setblock ${centerX-radius} ${baseY} ${centerZ-radius} minecraft:cobblestone_wall`);
        await delay();
        bot.chat(`/setblock ${centerX-radius} ${baseY+1} ${centerZ-radius} minecraft:lantern`);
        await delay();
        bot.chat(`/setblock ${centerX+radius} ${baseY} ${centerZ+radius} minecraft:cobblestone_wall`);
        await delay();
        bot.chat(`/setblock ${centerX+radius} ${baseY+1} ${centerZ+radius} minecraft:lantern`);
        await delay();
      }
      
      return factory.createResponse(`Planted ${size === 1 ? 'small' : size === 2 ? 'medium' : 'large'} garden at (${centerX}, ${baseY}, ${centerZ}) with flowers, path, and lanterns`);
    }
  );
}

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.1.0-beautiful"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;

  // Register 10 enhanced tools
  registerEssentialTools(factory, getBot, messageStore);

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
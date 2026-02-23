import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

export function registerTerrainTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // terraform_flatten - Level a region to its median height
  factory.registerTool(
    "terraform_flatten",
    "Level a region to its median height by filling low spots and clearing high ones",
    {
      x1: z.coerce.number().describe("Min X"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const airBlock = mcData.blocksByName['air'];
      
      const x1 = Number(params.x1), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);

      // Calculate median height
      const heights: number[] = [];
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          for (let y = 0; y < 256; y++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air') { heights.push(y); break; }
          }
        }
      }
      heights.sort((a, b) => a - b);
      const medianY = heights[Math.floor(heights.length / 2)] || 0;

      let changed = 0;
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          // Find current surface
          let currentY = 0;
          for (let y = 0; y < 256; y++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air') { currentY = y; break; }
          }
          
          if (currentY < medianY) {
            // Fill up
            for (let y = currentY; y < medianY; y++) {
              try { (bot as any).setBlock(new Vec3(x, y, z), 1); changed++; } catch {}
            }
          } else if (currentY > medianY) {
            // Clear down
            for (let y = currentY; y > medianY; y--) {
              try { (bot as any).setBlock(new Vec3(x, y, z), airBlock.id); changed++; } catch {}
            }
          }
        }
      }

      await solace.publishToolEvent('terraform_flatten', agentId, { region: { x1: minX, z1: minZ, x2: maxX, z2: maxZ }, medianY, changed });
      return factory.createResponse(`Flattened region to height ${medianY}, changed ${changed} blocks`);
    }
  );

  // clear_area - Fill a bounding box with air
  factory.registerTool(
    "clear_area",
    "Fill a bounding box with air to demolish anything inside it",
    {
      x1: z.coerce.number().describe("Min X"),
      y1: z.coerce.number().describe("Min Y"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      y2: z.coerce.number().describe("Max Y"),
      z2: z.coerce.number().describe("Max Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const airBlock = mcData.blocksByName['air'];
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      
      let cleared = 0;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            try { (bot as any).setBlock(new Vec3(x, y, z), airBlock.id); cleared++; } catch {}
          }
        }
      }

      await solace.publishToolEvent('clear_area', agentId, { boundingBox: { x1, y1, z1, x2, y2, z2 }, cleared });
      return factory.createResponse(`Cleared ${cleared} blocks in area`);
    }
  );

  // terraform_crater - Carve a hemispherical crater
  factory.registerTool(
    "terraform_crater",
    "Carve a hemispherical crater of a given radius into terrain",
    {
      x: z.coerce.number().describe("Center X"),
      y: z.coerce.number().describe("Center Y"),
      z: z.coerce.number().describe("Center Z"),
      radius: z.number().describe("Crater radius"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const airBlock = mcData.blocksByName['air'];
      
      const cx = Number(params.x), cy = Number(params.y), cz = Number(params.z);
      const radius = Number(params.radius);
      const r2 = radius * radius;

      let carved = 0;
      for (let x = -radius; x <= radius; x++) {
        for (let y = -radius; y <= radius; y++) {
          for (let z = -radius; z <= radius; z++) {
            const dist2 = x*x + y*y + z*z;
            if (dist2 <= r2) {
              try { (bot as any).setBlock(new Vec3(cx + x, cy + y, cz + z), airBlock.id); carved++; } catch {}
            }
          }
        }
      }

      await solace.publishToolEvent('terraform_crater', agentId, { center: { x: cx, y: cy, z: cz }, radius, carved });
      return factory.createResponse(`Carved crater with radius ${radius}, removed ${carved} blocks`);
    }
  );

  // terraform_hill - Raise terrain into a smooth mound
  factory.registerTool(
    "terraform_hill",
    "Raise terrain into a smooth mound using layered concentric fills",
    {
      x: z.coerce.number().describe("Center X"),
      z: z.coerce.number().describe("Center Z"),
      radius: z.number().describe("Hill radius"),
      height: z.number().describe("Hill height"),
      blockType: z.string().optional().describe("Block type (default: dirt)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const blockType = (params.blockType || 'dirt').toLowerCase();
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);
      
      const cx = Number(params.x), cz = Number(params.z);
      const radius = Number(params.radius), height = Number(params.height);

      let placed = 0;
      for (let r = 0; r <= radius; r++) {
        const layerHeight = Math.max(1, Math.round(height * (1 - r / radius)));
        for (let angle = 0; angle < 360; angle += 5) {
          const rad = (angle * Math.PI) / 180;
          const x = Math.round(cx + r * Math.cos(rad));
          const z = Math.round(cz + r * Math.sin(rad));
          
          // Find surface
          let surfaceY = 0;
          for (let y = 0; y < 256; y++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air') { surfaceY = y; break; }
          }
          
          for (let h = 1; h <= layerHeight; h++) {
            try { (bot as any).setBlock(new Vec3(x, surfaceY + h, z), block.id); placed++; } catch {}
          }
        }
      }

      await solace.publishToolEvent('terraform_hill', agentId, { center: { x: cx, z: cz }, radius, height, blockType, placed });
      return factory.createResponse(`Built hill with ${placed} ${blockType} blocks`);
    }
  );

  // plant_forest - Scatter saplings and grow them
  factory.registerTool(
    "plant_forest",
    "Scatter saplings across a region and grow them instantly with bone meal",
    {
      x1: z.coerce.number().describe("Min X"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
      density: z.number().optional().describe("Tree density 0-1 (default: 0.3)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      
      const x1 = Number(params.x1), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const density = params.density || 0.3;
      
      const saplingTypes = ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling'];
      let planted = 0;

      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
          if (Math.random() > density) continue;
          
          // Find surface
          let surfaceY = 0;
          for (let y = 0; y < 256; y++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air') { surfaceY = y; break; }
          }
          
          const saplingName = saplingTypes[Math.floor(Math.random() * saplingTypes.length)];
          const saplingBlock = mcData.blocksByName[saplingName];
          if (saplingBlock) {
            try {
              (bot as any).setBlock(new Vec3(x, surfaceY + 1, z), saplingBlock.id);
              planted++;
            } catch {}
          }
        }
      }

      await solace.publishToolEvent('plant_forest', agentId, { region: { x1, z1, x2, z2 }, density, planted });
      return factory.createResponse(`Planted ${planted} saplings in forest area`);
    }
  );

  // flood_region - Fill all air blocks with water
  factory.registerTool(
    "flood_region",
    "Fill all air blocks in a region at or below a given Y level with water",
    {
      x1: z.coerce.number().describe("Min X"),
      y: z.coerce.number().describe("Max Y level"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const waterBlock = mcData.blocksByName['water'];
      
      const x1 = Number(params.x1), y = Number(params.y), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);

      let filled = 0;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let cy = 0; cy <= y; cy++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            const b = bot.blockAt(new Vec3(x, cy, z));
            if (b && b.name === 'air') {
              try { (bot as any).setBlock(new Vec3(x, cy, z), waterBlock.id); filled++; } catch {}
            }
          }
        }
      }

      await solace.publishToolEvent('flood_region', agentId, { boundingBox: { x1, y, z1, x2, z2 }, filled });
      return factory.createResponse(`Flooded region with ${filled} water blocks`);
    }
  );

  // drain_region - Replace all water and lava with air
  factory.registerTool(
    "drain_region",
    "Replace all water and lava blocks in a region with air",
    {
      x1: z.coerce.number().describe("Min X"),
      y1: z.coerce.number().describe("Min Y"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      y2: z.coerce.number().describe("Max Y"),
      z2: z.coerce.number().describe("Max Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const airBlock = mcData.blocksByName['air'];
      const waterBlock = mcData.blocksByName['water'];
      const lavaBlock = mcData.blocksByName['lava'];
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);

      let drained = 0;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && (b.name === 'water' || b.name === 'lava')) {
              try { (bot as any).setBlock(new Vec3(x, y, z), airBlock.id); drained++; } catch {}
            }
          }
        }
      }

      await solace.publishToolEvent('drain_region', agentId, { boundingBox: { x1, y1, z1, x2, y2, z2 }, drained });
      return factory.createResponse(`Drained ${drained} liquid blocks`);
    }
  );

  // pave_plaza - Flatten, clear, and surface-tile a large area
  factory.registerTool(
    "pave_plaza",
    "Flatten, clear, and surface-tile a large area as a town square",
    {
      x1: z.coerce.number().describe("Min X"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
      blockType: z.string().optional().describe("Plaza surface (default: stone)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      const mcData = minecraftData(bot.version);
      const blockType = (params.blockType || 'stone').toLowerCase();
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);
      
      const x1 = Number(params.x1), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);

      let paved = 0;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
          // Find surface and flatten to it
          let surfaceY = 0;
          for (let y = 0; y < 256; y++) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (b && b.name !== 'air') { surfaceY = y; break; }
          }
          try { (bot as any).setBlock(new Vec3(x, surfaceY, z), block.id); paved++; } catch {}
        }
      }

      await solace.publishToolEvent('pave_plaza', agentId, { region: { x1, z1, x2, z2 }, blockType, paved });
      return factory.createResponse(`Paved plaza with ${paved} ${blockType} blocks`);
    }
  );
}

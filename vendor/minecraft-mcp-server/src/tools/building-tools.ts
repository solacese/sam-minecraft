import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

export function registerBuildingTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // fill_region - Fill a rectangular volume with any block type
  factory.registerTool(
    "fill_region",
    "Fill a rectangular volume with any block type in one call",
    {
      x1: z.coerce.number().describe("Start X coordinate"),
      y1: z.coerce.number().describe("Start Y coordinate"),
      z1: z.coerce.number().describe("Start Z coordinate"),
      x2: z.coerce.number().describe("End X coordinate"),
      y2: z.coerce.number().describe("End Y coordinate"),
      z2: z.coerce.number().describe("End Z coordinate"),
      blockType: z.string().describe("Block type to fill with (e.g., 'stone', 'oak_planks')"),
    },
    async (params: {
      x1: number | string;
      y1: number | string;
      z1: number | string;
      x2: number | string;
      y2: number | string;
      z2: number | string;
      blockType: string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      const blockType = params.blockType.toLowerCase();

      // Get block ID
      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) {
        return factory.createErrorResponse(`Unknown block type: ${blockType}`);
      }

      // Fill the region
      let filled = 0;
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            try {
              await bot.placeBlock(
                bot.blockAt(new Vec3(x, y, z - 1))!,
                new Vec3(0, 0, -1)
              );
              filled++;
            } catch {
              // Skip if can't place
            }
          }
        }
      }

      // Use setBlock for bulk placement (more efficient)
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            try {
              bot.setBlock(new Vec3(x, y, z), block.id);
              filled++;
            } catch {
              // Skip errors
            }
          }
        }
      }

      await solace.publishToolEvent('fill_region', agentId, {
        boundingBox: { x1: minX, y1: minY, z1: minZ, x2: maxX, y2: maxY, z2: maxZ },
        blockType,
        filled,
      });

      return factory.createResponse(`Filled ${filled} blocks with ${blockType} in region (${minX},${minY},${minZ}) to (${maxX},${maxY},${maxZ})`);
    }
  );

  // place_hollow_box - Place walls, floor, and ceiling of a room
  factory.registerTool(
    "place_hollow_box",
    "Place walls, floor, and ceiling of a room leaving the interior empty",
    {
      x1: z.coerce.number().describe("Start X coordinate"),
      y1: z.coerce.number().describe("Start Y coordinate"),
      z1: z.coerce.number().describe("Start Z coordinate"),
      x2: z.coerce.number().describe("End X coordinate"),
      y2: z.coerce.number().describe("End Y coordinate"),
      z2: z.coerce.number().describe("End Z coordinate"),
      blockType: z.string().describe("Block type for walls/floor/ceiling"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);

      let placed = 0;

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            // Only place on surfaces (not interior)
            const isSurface = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
            if (isSurface) {
              try {
                bot.setBlock(new Vec3(x, y, z), block.id);
                placed++;
              } catch { /* skip */ }
            }
          }
        }
      }

      await solace.publishToolEvent('place_hollow_box', agentId, {
        boundingBox: { x1: minX, y1: minY, z1: minZ, x2: maxX, y2: maxY, z2: maxZ },
        blockType, placed,
      });

      return factory.createResponse(`Placed hollow box with ${placed} ${blockType} blocks`);
    }
  );

  // place_wall - Place a single flat vertical wall
  factory.registerTool(
    "place_wall",
    "Place a single flat vertical wall between two corner coordinates",
    {
      x1: z.coerce.number().describe("Corner 1 X"),
      y1: z.coerce.number().describe("Corner 1 Y"),
      z1: z.coerce.number().describe("Corner 1 Z"),
      x2: z.coerce.number().describe("Corner 2 X"),
      y2: z.coerce.number().describe("Corner 2 Y"),
      z2: z.coerce.number().describe("Corner 2 Z"),
      blockType: z.string().describe("Block type"),
      height: z.number().optional().describe("Wall height (default: 3)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      const blockType = params.blockType.toLowerCase();
      const wallHeight = params.height || 3;

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;

      // Determine wall orientation
      if (Math.abs(x1 - x2) >= Math.abs(z1 - z2)) {
        // X-oriented wall
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        for (let x = minX; x <= maxX; x++) {
          for (let h = 0; h < wallHeight; h++) {
            try {
              bot.setBlock(new Vec3(x, y1 + h, z1), block.id);
              placed++;
            } catch { /* skip */ }
          }
        }
      } else {
        // Z-oriented wall
        const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
        for (let z = minZ; z <= maxZ; z++) {
          for (let h = 0; h < wallHeight; h++) {
            try {
              bot.setBlock(new Vec3(x1, y1 + h, z), block.id);
              placed++;
            } catch { /* skip */ }
          }
        }
      }

      await solace.publishToolEvent('place_wall', agentId, {
        corner1: { x1, y1, z1 }, corner2: { x2, y2, z2 }, blockType, wallHeight, placed,
      });

      return factory.createResponse(`Placed wall with ${placed} ${blockType} blocks`);
    }
  );

  // build_road - Pave a straight road with auto terrain clearance
  factory.registerTool(
    "build_road",
    "Pave a straight road between two points with auto terrain clearance",
    {
      x1: z.coerce.number().describe("Start X"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      z2: z.coerce.number().describe("End Z"),
      width: z.number().optional().describe("Road width (default: 4)"),
      blockType: z.string().describe("Road block type (default: cobblestone)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const width = params.width || 4;
      const blockType = (params.blockType || 'cobblestone').toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      const halfWidth = Math.floor(width / 2);
      let placed = 0;

      // Interpolate between points
      const steps = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
      for (let i = 0; i <= steps; i++) {
        const t = steps > 0 ? i / steps : 0;
        const x = Math.round(x1 + (x2 - x1) * t);
        const z = Math.round(z1 + (z2 - z1) * t);
        
        // Get ground level and flatten
        let y = 0;
        for (let checkY = 0; checkY < 256; checkY++) {
          const b = bot.blockAt(new Vec3(x, checkY, z));
          if (b && b.name !== 'air') { y = checkY; break; }
        }

        for (let w = -halfWidth; w <= halfWidth; w++) {
          const walloc = x2 !== x1 ? new Vec3(x, y, z + w) : new Vec3(x + w, y, z);
          try {
            bot.setBlock(walloc, block.id);
            placed++;
          } catch { /* skip */ }
        }
      }

      await solace.publishToolEvent('build_road', agentId, {
        start: { x1, z1 }, end: { x2, z2 }, width, blockType, placed,
      });

      return factory.createResponse(`Built road with ${placed} ${blockType} blocks`);
    }
  );

  // build_bridge - Span a gap with a flat bridge
  factory.registerTool(
    "build_bridge",
    "Span a gap or river with a flat bridge of configurable width and material",
    {
      x1: z.coerce.number().describe("Start X"),
      y: z.coerce.number().describe("Y level"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      z2: z.coerce.number().describe("End Z"),
      width: z.number().optional().describe("Bridge width (default: 4)"),
      blockType: z.string().describe("Bridge material"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y = Number(params.y), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const width = params.width || 4;
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      const halfWidth = Math.floor(width / 2);
      let placed = 0;

      const steps = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
      for (let i = 0; i <= steps; i++) {
        const t = steps > 0 ? i / steps : 0;
        const x = Math.round(x1 + (x2 - x1) * t);
        const z = Math.round(z1 + (z2 - z1) * t);

        for (let w = -halfWidth; w <= halfWidth; w++) {
          const walloc = x2 !== x1 ? new Vec3(x, y, z + w) : new Vec3(x + w, y, z);
          try {
            bot.setBlock(walloc, block.id);
            placed++;
          } catch { /* skip */ }
        }
      }

      await solace.publishToolEvent('build_bridge', agentId, {
        start: { x1, y, z1 }, end: { x2, z2 }, width, blockType, placed,
      });

      return factory.createResponse(`Built bridge with ${placed} ${blockType} blocks`);
    }
  );

  // build_tower - Erect a hollow circular or square tower
  factory.registerTool(
    "build_tower",
    "Erect a hollow circular or square tower of a given radius and height",
    {
      x: z.coerce.number().describe("Center X"),
      y: z.coerce.number().describe("Base Y"),
      z: z.coerce.number().describe("Center Z"),
      radius: z.number().describe("Tower radius"),
      height: z.number().describe("Tower height"),
      shape: z.enum(['circular', 'square']).optional().describe("Tower shape"),
      blockType: z.string().describe("Building material"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const cx = Number(params.x), cy = Number(params.y), cz = Number(params.z);
      const radius = Number(params.radius);
      const height = Number(params.height);
      const shape = params.shape || 'square';
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;

      for (let h = 0; h < height; h++) {
        const y = cy + h;
        
        if (shape === 'circular') {
          for (let angle = 0; angle < 360; angle += 5) {
            const rad = (angle * Math.PI) / 180;
            const x = Math.round(cx + radius * Math.cos(rad));
            const z = Math.round(cz + radius * Math.sin(rad));
            try {
              bot.setBlock(new Vec3(x, y, z), block.id);
              placed++;
            } catch { /* skip */ }
          }
        } else {
          // Square tower
          for (let i = -radius; i <= radius; i++) {
            try {
              bot.setBlock(new Vec3(cx + radius, y, cz + i), block.id);
              bot.setBlock(new Vec3(cx - radius, y, cz + i), block.id);
              bot.setBlock(new Vec3(cx + i, y, cz + radius), block.id);
              bot.setBlock(new Vec3(cx + i, y, cz - radius), block.id);
              placed += 4;
            } catch { /* skip */ }
          }
        }
      }

      await solace.publishToolEvent('build_tower', agentId, {
        center: { x: cx, y: cy, z: cz }, radius, height, shape, blockType, placed,
      });

      return factory.createResponse(`Built ${shape} tower with ${placed} ${blockType} blocks`);
    }
  );

  // build_staircase - Place a diagonal staircase
  factory.registerTool(
    "build_staircase",
    "Place a diagonal staircase connecting two Y levels at a given position",
    {
      x: z.coerce.number().describe("Base X"),
      y: z.coerce.number().describe("Start Y"),
      z: z.coerce.number().describe("Base Z"),
      endY: z.coerce.number().describe("End Y level"),
      direction: z.enum(['north', 'south', 'east', 'west']).optional().describe("Direction"),
      blockType: z.string().describe("Stair material"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x = Number(params.x), y = Number(params.y), z = Number(params.z);
      const endY = Number(params.endY);
      const direction = params.direction || 'south';
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;
      const steps = Math.abs(endY - y);

      const dirVec = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[direction] as number[];

      for (let i = 0; i < steps; i++) {
        const stepY = endY > y ? y + i : y - i;
        const xPos = x + dirVec[0] * i;
        const zPos = z + dirVec[1] * i;
        
        try {
          bot.setBlock(new Vec3(xPos, stepY, zPos), block.id);
          placed++;
        } catch { /* skip */ }
      }

      await solace.publishToolEvent('build_staircase', agentId, {
        start: { x, y, z }, endY, direction, blockType, placed,
      });

      return factory.createResponse(`Built staircase with ${placed} steps`);
    }
  );

  // build_dome - Generate a spherical dome
  factory.registerTool(
    "build_dome",
    "Generate a spherical dome using a voxel-sphere algorithm around a center point",
    {
      x: z.coerce.number().describe("Center X"),
      y: z.coerce.number().describe("Center Y"),
      z: z.coerce.number().describe("Center Z"),
      radius: z.number().describe("Dome radius"),
      blockType: z.string().describe("Dome material"),
      hollow: z.boolean().optional().describe("Make dome hollow (default: true)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const cx = Number(params.x), cy = Number(params.y), cz = Number(params.z);
      const radius = Number(params.radius);
      const blockType = params.blockType.toLowerCase();
      const hollow = params.hollow !== false;

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;
      const r2 = radius * radius;

      for (let x = -radius; x <= radius; x++) {
        for (let y = 0; y <= radius; y++) {
          for (let z = -radius; z <= radius; z++) {
            const dist2 = x*x + y*y + z*z;
            
            if (hollow) {
              if (dist2 <= r2 && dist2 >= (radius - 1) * (radius - 1)) {
                try {
                  bot.setBlock(new Vec3(cx + x, cy + y, cz + z), block.id);
                  placed++;
                } catch { /* skip */ }
              }
            } else {
              if (dist2 <= r2) {
                try {
                  bot.setBlock(new Vec3(cx + x, cy + y, cz + z), block.id);
                  placed++;
                } catch { /* skip */ }
              }
            }
          }
        }
      }

      await solace.publishToolEvent('build_dome', agentId, {
        center: { x: cx, y: cy, z: cz }, radius, blockType, hollow, placed,
      });

      return factory.createResponse(`Built dome with ${placed} ${blockType} blocks`);
    }
  );

  // build_arch - Place a parabolic archway
  factory.registerTool(
    "build_arch",
    "Place a parabolic archway of configurable width, height, and material",
    {
      x: z.coerce.number().describe("Center X"),
      y: z.coerce.number().describe("Base Y"),
      z: z.coerce.number().describe("Center Z"),
      width: z.number().describe("Arch width"),
      height: z.number().describe("Arch height"),
      blockType: z.string().describe("Arch material"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const cx = Number(params.x), cy = Number(params.y), cz = Number(params.z);
      const width = Number(params.width);
      const height = Number(params.height);
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;

      for (let x = -Math.floor(width/2); x <= Math.floor(width/2); x++) {
        // Parabolic curve: y = -4h/w^2 * x^2 + h
        const normalizedX = (2 * x) / width;
        const archHeight = Math.round(height * (1 - normalizedX * normalizedX));
        
        for (let h = 0; h <= archHeight; h++) {
          try {
            bot.setBlock(new Vec3(cx + x, cy + h, cz), block.id);
            placed++;
          } catch { /* skip */ }
        }
      }

      await solace.publishToolEvent('build_arch', agentId, {
        center: { x: cx, y: cy, z: cz }, width, height, blockType, placed,
      });

      return factory.createResponse(`Built arch with ${placed} ${blockType} blocks`);
    }
  );

  // place_roof - Add a sloped or flat roof
  factory.registerTool(
    "place_roof",
    "Add a sloped or flat roof to an existing hollow box structure",
    {
      x1: z.coerce.number().describe("Building min X"),
      y: z.coerce.number().describe("Roof Y level"),
      z1: z.coerce.number().describe("Building min Z"),
      x2: z.coerce.number().describe("Building max X"),
      z2: z.coerce.number().describe("Building max Z"),
      style: z.enum(['flat', 'sloped', 'pyramid']).optional().describe("Roof style"),
      blockType: z.string().describe("Roof material"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y = Number(params.y), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const style = params.style || 'sloped';
      const blockType = params.blockType.toLowerCase();

      const mcData = minecraftData(bot.version);
      const block = mcData.blocksByName[blockType];
      if (!block) return factory.createErrorResponse(`Unknown block: ${blockType}`);

      let placed = 0;
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
      const width = maxX - minX;
      const depth = maxZ - minZ;

      if (style === 'flat') {
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            try {
              bot.setBlock(new Vec3(x, y, z), block.id);
              placed++;
            } catch { /* skip */ }
          }
        }
      } else if (style === 'sloped') {
        for (let x = minX; x <= maxX; x++) {
          const roofY = y + Math.round((x - minX) / width * 2);
          for (let z = minZ; z <= maxZ; z++) {
            try {
              bot.setBlock(new Vec3(x, roofY, z), block.id);
              placed++;
            } catch { /* skip */ }
          }
        }
      } else if (style === 'pyramid') {
        const maxOffset = Math.max(width, depth) / 2;
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            const xOffset = Math.abs(x - (minX + maxX) / 2);
            const zOffset = Math.abs(z - (minZ + maxZ) / 2);
            const roofY = y + Math.round(maxOffset - Math.max(xOffset, zOffset));
            try {
              bot.setBlock(new Vec3(x, roofY, z), block.id);
              placed++;
            } catch { /* skip */ }
          }
        }
      }

      await solace.publishToolEvent('place_roof', agentId, {
        boundingBox: { x1: minX, z1: minZ, x2: maxX, z2: maxZ }, y, style, blockType, placed,
      });

      return factory.createResponse(`Built ${style} roof with ${placed} ${blockType} blocks`);
    }
  );

  // place_floor_pattern - Tile a floor with alternating pattern
  factory.registerTool(
    "place_floor_pattern",
    "Tile a floor with an alternating or checkerboard multi-block pattern",
    {
      x1: z.coerce.number().describe("Min X"),
      y: z.coerce.number().describe("Floor Y"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
      blockType1: z.string().describe("Primary block type"),
      blockType2: z.string().optional().describe("Secondary block type (default: air)"),
      pattern: z.enum(['checkerboard', 'stripes_x', 'stripes_z', 'solid']).optional().describe("Pattern type"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y = Number(params.y), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      const blockType1 = params.blockType1.toLowerCase();
      const blockType2 = (params.blockType2 || 'stone').toLowerCase();
      const pattern = params.pattern || 'checkerboard';

      const mcData = minecraftData(bot.version);
      const block1 = mcData.blocksByName[blockType1];
      const block2 = mcData.blocksByName[blockType2];
      if (!block1 || !block2) return factory.createErrorResponse(`Unknown block type`);

      let placed = 0;
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);

      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          let useBlock1 = true;

          if (pattern === 'checkerboard') {
            useBlock1 = (x + z) % 2 === 0;
          } else if (pattern === 'stripes_x') {
            useBlock1 = x % 2 === 0;
          } else if (pattern === 'stripes_z') {
            useBlock1 = z % 2 === 0;
          }

          const block = useBlock1 ? block1 : block2;
          try {
            bot.setBlock(new Vec3(x, y, z), block.id);
            placed++;
          } catch { /* skip */ }
        }
      }

      await solace.publishToolEvent('place_floor_pattern', agentId, {
        boundingBox: { x1: minX, z1: minZ, x2: maxX, z2: maxZ }, y,
        blockType1, blockType2, pattern, placed,
      });

      return factory.createResponse(`Placed floor with ${placed} blocks in ${pattern} pattern`);
    }
  );

  // replicate_structure - Copy and paste a snapshot
  factory.registerTool(
    "replicate_structure",
    "Copy a snapshot artifact and paste it at a new offset coordinate",
    {
      snapshotJson: z.string().describe("JSON string of the snapshot (from snapshot_region)"),
      offsetX: z.coerce.number().describe("Offset X from original position"),
      offsetY: z.coerce.number().describe("Offset Y from original position"),
      offsetZ: z.coerce.number().describe("Offset Z from original position"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const offsetX = Number(params.offsetX);
      const offsetY = Number(params.offsetY);
      const offsetZ = Number(params.offsetZ);

      let snapshot;
      try {
        snapshot = JSON.parse(params.snapshotJson);
      } catch {
        return factory.createErrorResponse("Invalid snapshot JSON");
      }

      const mcData = minecraftData(bot.version);
      let placed = 0;

      for (const blockData of snapshot.blocks || []) {
        const { x, y, z, type } = blockData;
        const block = mcData.blocksByName[type];
        if (block) {
          try {
            bot.setBlock(
              new Vec3(x + offsetX, y + offsetY, z + offsetZ),
              block.id
            );
            placed++;
          } catch { /* skip */ }
        }
      }

      await solace.publishToolEvent('replicate_structure', agentId, {
        offset: { x: offsetX, y: offsetY, z: offsetZ }, blocksReplicated: placed,
      });

      return factory.createResponse(`Replicated structure with ${placed} blocks`);
    }
  );
}

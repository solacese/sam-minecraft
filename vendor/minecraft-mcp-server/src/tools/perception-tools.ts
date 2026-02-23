import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import { Vec3 } from 'vec3';

export function registerPerceptionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // snapshot_region - Serialize every block in a bounding box to JSON
  factory.registerTool(
    "snapshot_region",
    "Serialize every block in a bounding box to a JSON artifact for later replay",
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
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      
      const blocks: {x: number, y: number, z: number, type: string}[] = [];
      
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.name !== 'air') {
              blocks.push({ x, y, z, type: block.name });
            }
          }
        }
      }

      const snapshot = { blocks, boundingBox: { x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2) } };
      
      await solace.publishToolEvent('snapshot_region', agentId, { blockCount: blocks.length, boundingBox: snapshot.boundingBox });
      return factory.createResponse(JSON.stringify(snapshot));
    }
  );

  // scan_resources - Survey a large radius for all distinct block types
  factory.registerTool(
    "scan_resources",
    "Survey a large radius for all distinct block types and return a resource map",
    {
      x: z.coerce.number().describe("Center X"),
      y: z.coerce.number().describe("Center Y"),
      z: z.coerce.number().describe("Center Z"),
      radius: z.number().optional().describe("Scan radius (default: 16)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const cx = Number(params.x), cy = Number(params.y), cz = Number(params.z);
      const radius = Number(params.radius || 16);
      
      const resources: Record<string, number> = {};
      
      for (let x = cx - radius; x <= cx + radius; x++) {
        for (let y = Math.max(0, cy - radius); y <= cy + radius; y++) {
          for (let z = cz - radius; z <= cz + radius; z++) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.name !== 'air') {
              resources[block.name] = (resources[block.name] || 0) + 1;
            }
          }
        }
      }

      await solace.publishToolEvent('scan_resources', agentId, { center: { x: cx, y: cy, z: cz }, radius, uniqueTypes: Object.keys(resources).length });
      
      let response = `Found ${Object.keys(resources).length} unique block types in radius ${radius}:\n\n`;
      const sorted = Object.entries(resources).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted.slice(0, 20)) {
        response += `${type}: ${count}\n`;
      }
      return factory.createResponse(response);
    }
  );

  // get_elevation_map - Sample Y heights across an XZ grid
  factory.registerTool(
    "get_elevation_map",
    "Sample Y heights across an XZ grid and return a 2D elevation array",
    {
      x1: z.coerce.number().describe("Min X"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      z2: z.coerce.number().describe("Max Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), z1 = Number(params.z1);
      const x2 = Number(params.x2), z2 = Number(params.z2);
      
      const elevations: number[][] = [];
      
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        const row: number[] = [];
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
          let y = 0;
          for (let checkY = 0; checkY < 256; checkY++) {
            const b = bot.blockAt(new Vec3(x, checkY, z));
            if (b && b.name !== 'air') { y = checkY; break; }
          }
          row.push(y);
        }
        elevations.push(row);
      }

      await solace.publishToolEvent('get_elevation_map', agentId, { region: { x1, z1, x2, z2 }, gridSize: elevations.length });
      return factory.createResponse(JSON.stringify({ elevations, minX: Math.min(x1, x2), minZ: Math.min(z1, z2) }));
    }
  );

  // find_flat_land - Search for largest naturally flat buildable area
  factory.registerTool(
    "find_flat_land",
    "Search the surroundings for the largest naturally flat buildable area",
    {
      x: z.coerce.number().describe("Search center X"),
      z: z.coerce.number().describe("Search center Z"),
      maxRadius: z.number().optional().describe("Max search radius (default: 32)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const cx = Number(params.x), cz = Number(params.z);
      const maxRadius = Number(params.maxRadius || 32);
      
      let bestX = cx, bestZ = cz, bestSize = 0;
      
      for (let r = 1; r <= maxRadius; r++) {
        for (let x = cx - r; x <= cx + r; x++) {
          for (let z = cz - r; z <= cz + r; z++) {
            // Check 5x5 area flatness
            let flat = true, baseY = -1;
            for (let dx = 0; dx < 5 && flat; dx++) {
              for (let dz = 0; dz < 5 && flat; dz++) {
                let y = 0;
                for (let checkY = 0; checkY < 256; checkY++) {
                  const b = bot.blockAt(new Vec3(x + dx, checkY, z + dz));
                  if (b && b.name !== 'air') { y = checkY; break; }
                }
                if (baseY === -1) baseY = y;
                else if (Math.abs(y - baseY) > 1) flat = false;
              }
            }
            if (flat && baseY !== -1) {
              const size = 25; // 5x5
              if (size > bestSize) { bestSize = size; bestX = x; bestZ = z; }
            }
          }
        }
      }

      await solace.publishToolEvent('find_flat_land', agentId, { center: { x: cx, z: cz }, maxRadius, found: { x: bestX, z: bestZ, size: bestSize } });
      return factory.createResponse(`Found flat land at (${bestX}, ${bestZ}) with size ${bestSize}`);
    }
  );

  // detect_players_nearby - Return names and distances of players in range
  factory.registerTool(
    "detect_players_nearby",
    "Return names and distances of all players within a configurable range",
    {
      range: z.number().optional().describe("Detection range (default: 32)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const range = Number(params.range || 32);
      const botPos = bot.entity.position;
      const players: {name: string, distance: number}[] = [];
      
      for (const player of Object.values(bot.players)) {
        if (player.entity) {
          const dist = Math.sqrt(
            Math.pow(player.entity.position.x - botPos.x, 2) +
            Math.pow(player.entity.position.z - botPos.z, 2)
          );
          if (dist <= range) {
            players.push({ name: player.username, distance: Math.round(dist) });
          }
        }
      }

      await solace.publishToolEvent('detect_players_nearby', agentId, { range, found: players.length });
      
      if (players.length === 0) return factory.createResponse(`No players within ${range} blocks`);
      let response = `Found ${players.length} player(s) within ${range} blocks:\n`;
      for (const p of players.sort((a, b) => a.distance - b.distance)) {
        response += `${p.name}: ${p.distance} blocks\n`;
      }
      return factory.createResponse(response);
    }
  );

  // read_sign - Read text content of a sign block
  factory.registerTool(
    "read_sign",
    "Read and return the text content of a sign block at given coordinates",
    {
      x: z.coerce.number().describe("Sign X"),
      y: z.coerce.number().describe("Sign Y"),
      z: z.coerce.number().describe("Sign Z"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x = Number(params.x), y = Number(params.y), z = Number(params.z);
      const block = bot.blockAt(new Vec3(x, y, z));
      
      if (!block || !block.name.includes('sign')) {
        return factory.createErrorResponse(`No sign found at (${x}, ${y}, ${z})`);
      }

      // Sign metadata contains text
      const signData = block;
      const text = (block as any).getProperties?.() || {};
      
      await solace.publishToolEvent('read_sign', agentId, { position: { x, y, z }, text: JSON.stringify(text) });
      return factory.createResponse(`Sign at (${x}, ${y}, ${z}): ${JSON.stringify(text)}`);
    }
  );
}

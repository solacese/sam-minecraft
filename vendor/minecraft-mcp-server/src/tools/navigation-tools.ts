import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

export function registerNavigationTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // pathfind_and_escort - Navigate to a destination while guiding a player
  factory.registerTool(
    "pathfind_and_escort",
    "Navigate to a destination using pathfinding while guiding a player to follow",
    {
      targetX: z.coerce.number().describe("Target X coordinate"),
      targetY: z.coerce.number().describe("Target Y coordinate"),
      targetZ: z.coerce.number().describe("Target Z coordinate"),
      playerName: z.string().optional().describe("Player name to escort (optional)"),
    },
    async (params: {
      targetX: number | string;
      targetY: number | string;
      targetZ: number | string;
      playerName?: string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const targetX = Number(params.targetX);
      const targetY = Number(params.targetY);
      const targetZ = Number(params.targetZ);

      // Use bot.pathfinder.goto() with GoalNear
      const goal = new goals.GoalNear(targetX, targetY, targetZ, 2);

      try {
        await bot.pathfinder.goto(goal);

        // If player specified, send them messages
        if (params.playerName) {
          bot.chat(`@${params.playerName} Follow me to (${targetX}, ${targetY}, ${targetZ})!`);
        }

        await solace.publishToolEvent('pathfind_and_escort', agentId, {
          target: { x: targetX, y: targetY, z: targetZ },
          playerName: params.playerName,
        });

        return factory.createResponse(`Pathfinding to (${targetX}, ${targetY}, ${targetZ}) - arrived successfully`);
      } catch (error) {
        return factory.createErrorResponse(`Failed to pathfind: ${error}`);
      }
    }
  );

  // patrol_route - Walk a square or circular patrol path
  factory.registerTool(
    "patrol_route",
    "Walk a square or circular patrol path, announcing presence at each waypoint",
    {
      centerX: z.coerce.number().describe("Center X of patrol route"),
      centerZ: z.coerce.number().describe("Center Z of patrol route"),
      radius: z.number().describe("Patrol route radius"),
      rounds: z.number().optional().describe("Number of rounds (default: 1)"),
      shape: z.enum(['square', 'circular']).optional().describe("Patrol shape"),
    },
    async (params: {
      centerX: number | string;
      centerZ: number | string;
      radius: number | string;
      rounds?: number | string;
      shape?: string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const cx = Number(params.centerX);
      const cz = Number(params.centerZ);
      const radius = Number(params.radius);
      const rounds = Number(params.rounds || 1);
      const shape = params.shape || 'square';

      const waypoints: { x: number; y: number; z: number }[] = [];

      if (shape === 'square') {
        // Square patrol: 4 corners
        waypoints.push({ x: cx - radius, y: 0, z: cz - radius });
        waypoints.push({ x: cx + radius, y: 0, z: cz - radius });
        waypoints.push({ x: cx + radius, y: 0, z: cz + radius });
        waypoints.push({ x: cx - radius, y: 0, z: cz + radius });
      } else {
        // Circular patrol: 8 points
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const x = Math.round(cx + radius * Math.cos(angle));
          const z = Math.round(cz + radius * Math.sin(angle));
          // Find ground level
          let y = 0;
          for (let checkY = 0; checkY < 256; checkY++) {
            const b = bot.blockAt(new Vec3(x, checkY, z));
            if (b && b.name !== 'air') { y = checkY; break; }
          }
          waypoints.push({ x, y, z });
        }
      }

      let visited = 0;

      for (let r = 0; r < rounds; r++) {
        for (const waypoint of waypoints) {
          // Announce arrival
          bot.chat(`Patrolling waypoint at (${waypoint.x}, ${waypoint.z})`);

          try {
            const goal = new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, 2);
            await bot.pathfinder.goto(goal);
            visited++;
          } catch {
            // Continue patrol even if one waypoint fails
          }
        }
      }

      await solace.publishToolEvent('patrol_route', agentId, {
        center: { x: cx, z: cz },
        radius,
        rounds,
        shape,
        waypointsVisited: visited,
      });

      return factory.createResponse(`Patrolled ${rounds} round(s), visited ${visited} waypoints`);
    }
  );

  // navigate_to_player - Find nearest player and walk to them
  factory.registerTool(
    "navigate_to_player",
    "Find the nearest player and navigate to their position",
    {
      playerName: z.string().optional().describe("Specific player name, or find nearest"),
      maxDistance: z.number().optional().describe("Max distance to search (default: 100)"),
    },
    async (params: {
      playerName?: string;
      maxDistance?: number | string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const maxDistance = Number(params.maxDistance || 100);
      let targetPlayer: { username: string; entity: any } | null = null;
      let minDist = maxDistance;

      const botPos = bot.entity.position;

      if (params.playerName) {
        // Find specific player
        const player = bot.players[params.playerName];
        if (player && player.entity) {
          targetPlayer = player;
        } else {
          return factory.createErrorResponse(`Player ${params.playerName} not found`);
        }
      } else {
        // Find nearest player
        for (const player of Object.values(bot.players)) {
          if (player.entity && player.username !== bot.username) {
            const dist = player.entity.position.distanceTo(botPos);
            if (dist < minDist) {
              minDist = dist;
              targetPlayer = player;
            }
          }
        }
      }

      if (!targetPlayer) {
        return factory.createErrorResponse("No player found within range");
      }

      const target = targetPlayer.entity.position;
      const targetX = Math.floor(target.x);
      const targetY = Math.floor(target.y);
      const targetZ = Math.floor(target.z);

      try {
        const goal = new goals.GoalNear(targetX, targetY, targetZ, 2);
        await bot.pathfinder.goto(goal);

        await solace.publishToolEvent('navigate_to_player', agentId, {
          playerName: targetPlayer.username,
          distance: Math.round(minDist),
        });

        return factory.createResponse(`Navigated to player ${targetPlayer.username} at distance ${Math.round(minDist)}`);
      } catch (error) {
        return factory.createErrorResponse(`Failed to navigate to player: ${error}`);
      }
    }
  );

  // return_to_base - Navigate back to spawn point or defined home
  factory.registerTool(
    "return_to_base",
    "Navigate back to spawn point or a defined home position",
    {
      homeX: z.coerce.number().optional().describe("Home X (default: spawn)"),
      homeY: z.coerce.number().optional().describe("Home Y (default: spawn)"),
      homeZ: z.coerce.number().optional().describe("Home Z (default: spawn)"),
    },
    async (params: {
      homeX?: number | string;
      homeY?: number | string;
      homeZ?: number | string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      let targetX: number, targetY: number, targetZ: number;

      if (params.homeX !== undefined && params.homeY !== undefined && params.homeZ !== undefined) {
        targetX = Number(params.homeX);
        targetY = Number(params.homeY);
        targetZ = Number(params.homeZ);
      } else {
        // Use spawn point
        const spawn = bot.spawnPoint;
        if (!spawn) {
          return factory.createErrorResponse("No spawn point available");
        }
        targetX = Math.floor(spawn.x);
        targetY = Math.floor(spawn.y);
        targetZ = Math.floor(spawn.z);
      }

      try {
        const goal = new goals.GoalNear(targetX, targetY, targetZ, 2);
        await bot.pathfinder.goto(goal);

        await solace.publishToolEvent('return_to_base', agentId, {
          target: { x: targetX, y: targetY, z: targetZ },
        });

        return factory.createResponse(`Returned to base at (${targetX}, ${targetY}, ${targetZ})`);
      } catch (error) {
        return factory.createErrorResponse(`Failed to return to base: ${error}`);
      }
    }
  );

  // explore_cardinal - Explore in all 4 cardinal directions
  factory.registerTool(
    "explore_cardinal",
    "Explore in all 4 cardinal directions (N, S, E, W) to discover new terrain",
    {
      distance: z.number().optional().describe("Exploration distance per direction (default: 50)"),
      announce: z.boolean().optional().describe("Announce discoveries in chat (default: true)"),
    },
    async (params: {
      distance?: number | string;
      announce?: boolean;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const distance = Number(params.distance || 50);
      const announce = params.announce !== false;

      const botPos = bot.entity.position;
      const directions = [
        { name: 'North', dx: 0, dz: -1 },
        { name: 'South', dx: 0, dz: 1 },
        { name: 'East', dx: 1, dz: 0 },
        { name: 'West', dx: -1, dz: 0 },
      ];

      const discoveries: { direction: string; x: number; z: number; blocks: number }[] = [];

      for (const dir of directions) {
        const targetX = Math.round(botPos.x + dir.dx * distance);
        const targetZ = Math.round(botPos.z + dir.dz * distance);

        // Find ground level at target
        let targetY = 0;
        for (let y = 0; y < 256; y++) {
          const b = bot.blockAt(new Vec3(targetX, y, targetZ));
          if (b && b.name !== 'air') { targetY = y; break; }
        }

        try {
          const goal = new goals.GoalNear(targetX, targetY, targetZ, 2);
          await bot.pathfinder.goto(goal);

          // Scan nearby blocks
          let blockCount = 0;
          for (let x = targetX - 5; x <= targetX + 5; x++) {
            for (let y = targetY - 2; y <= targetY + 5; y++) {
              for (let z = targetZ - 5; z <= targetZ + 5; z++) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && b.name !== 'air') blockCount++;
              }
            }
          }

          discoveries.push({
            direction: dir.name,
            x: targetX,
            z: targetZ,
            blocks: blockCount,
          });

          if (announce) {
            bot.chat(`Explored ${dir.name}: found ${blockCount} blocks at (${targetX}, ${targetZ})`);
          }
        } catch {
          if (announce) {
            bot.chat(`Could not explore ${dir.name}`);
          }
        }
      }

      await solace.publishToolEvent('explore_cardinal', agentId, {
        distance,
        discoveries,
      });

      let response = `Explored ${directions.length} cardinal directions (${distance} blocks each):\n`;
      for (const d of discoveries) {
        response += `${d.direction}: (${d.x}, ${d.z}) - ${d.blocks} blocks\n`;
      }

      return factory.createResponse(response);
    }
  );
}

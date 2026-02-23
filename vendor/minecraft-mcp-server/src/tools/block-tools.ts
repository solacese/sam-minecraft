import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      blockType: z.string().optional().describe("Block item name to equip before placing (for example: 'stone', 'oak_planks')"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async (params: { x: number | string; y: number | string; z: number | string; blockType?: string; faceDirection?: FaceDirection }) => {
      const x = Number(params.x);
      const y = Number(params.y);
      const z = Number(params.z);
      const blockType = params.blockType?.toLowerCase();
      const faceDirection = params.faceDirection ?? 'down';

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return factory.createErrorResponse("Invalid coordinates: x, y, z must be finite numbers.");
      }

      const bot = getBot();
      const placePos = new Vec3(x, y, z);
      const blockAtPos = bot.blockAt(placePos);

      if (blockType) {
        const itemToEquip = bot.inventory.items().find(
          (item) => item.name === blockType || item.name.includes(blockType)
        );

        if (!itemToEquip) {
          return factory.createResponse(
            `Cannot place '${blockType}' at (${x}, ${y}, ${z}): matching item not found in inventory`
          );
        }

        try {
          if (!bot.heldItem || bot.heldItem.name !== itemToEquip.name) {
            await bot.equip(itemToEquip, 'hand');
          }
        } catch (equipError) {
          return factory.createResponse(
            `Cannot place '${blockType}' at (${x}, ${y}, ${z}): failed to equip item (${equipError})`
          );
        }
      } else if (!bot.heldItem) {
        return factory.createResponse(
          `Cannot place block at (${x}, ${y}, ${z}): no item in hand. Provide blockType or use equip-item first`
        );
      }

      if (blockAtPos && blockAtPos.name !== 'air') {
        return factory.createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      let foundReference = false;
      let lastPlaceError: unknown = undefined;

      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.name !== 'air' && referenceBlock.boundingBox !== 'empty') {
          foundReference = true;

          try {
            if (!bot.canSeeBlock(referenceBlock)) {
              const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
              await bot.pathfinder.goto(goal);
            }
          } catch (moveError) {
            lastPlaceError = moveError;
            log('warn', `Failed to move for placement using ${face.direction} face: ${moveError}`);
            continue;
          }

          await bot.lookAt(placePos, true);

          try {
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
            return factory.createResponse(
              `Placed ${bot.heldItem?.name ?? 'block'} at (${x}, ${y}, ${z}) using ${face.direction} face`
            );
          } catch (placeError) {
            lastPlaceError = placeError;
            log('warn', `Failed to place using ${face.direction} face: ${placeError}`);
            continue;
          }
        }
      }

      if (foundReference && lastPlaceError) {
        return factory.createResponse(
          `Failed to place block at (${x}, ${y}, ${z}): placement failed (${String(lastPlaceError)})`
        );
      }

      return factory.createResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async (params: { x: number | string; y: number | string; z: number | string }) => {
      const x = Number(params.x);
      const y = Number(params.y);
      const z = Number(params.z);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return factory.createErrorResponse("Invalid coordinates: x, y, z must be finite numbers.");
      }

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.dig(block);
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async (params: { x: number | string; y: number | string; z: number | string }) => {
      const x = Number(params.x);
      const y = Number(params.y);
      const z = Number(params.z);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return factory.createErrorResponse("Invalid coordinates: x, y, z must be finite numbers.");
      }

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    }
  );

  factory.registerTool(
    "find-block",
    "Find the nearest block of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.number().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ blockType, maxDistance = 16 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      const block = bot.findBlock({
        matching: blockId,
        maxDistance: maxDistance
      });

      if (!block) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    }
  );
}

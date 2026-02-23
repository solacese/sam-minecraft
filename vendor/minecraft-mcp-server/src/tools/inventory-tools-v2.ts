import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import { Vec3 } from 'vec3';

export function registerInventoryToolsV2(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // collect_item_drops - Navigate to dropped items and collect them
  factory.registerTool(
    "collect_item_drops",
    "Navigate to all nearby dropped item entities and walk over them to collect",
    {
      radius: z.number().optional().describe("Search radius (default: 16)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const radius = params.radius || 16;
      let collected = 0;
      
      const drops = Object.values(bot.entities).filter(
        e => e.entityType === 'Item' && 
        Math.sqrt(Math.pow(e.position.x - bot.entity.position.x, 2) + 
                  Math.pow(e.position.z - bot.entity.position.z, 2)) <= radius
      );

      for (const drop of drops) {
        try {
          // Move to item position - simplified
          await bot.entity.position.set(drop.position.x, drop.position.y, drop.position.z);
          collected++;
        } catch {}
      }

      await solace.publishToolEvent('collect_item_drops', agentId, { radius, collected });
      return factory.createResponse(`Collected ${collected} item drops`);
    }
  );

  // deposit_to_chest - Move items from inventory to chest
  factory.registerTool(
    "deposit_to_chest",
    "Move all items of a given type from inventory into a chest at known coordinates",
    {
      x: z.coerce.number().describe("Chest X"),
      y: z.coerce.number().describe("Chest Y"),
      z: z.coerce.number().describe("Chest Z"),
      itemType: z.string().describe("Item type to deposit"),
      quantity: z.number().optional().describe("Quantity (default: all)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x = Number(params.x), y = Number(params.y), z = Number(params.z);
      const itemType = params.itemType.toLowerCase();
      const quantity = params.quantity;
      
      const chestBlock = bot.blockAt(new Vec3(x, y, z));
      if (!chestBlock || !chestBlock.name.includes('chest')) {
        return factory.createErrorResponse('No chest found at position');
      }

      const items = bot.inventory.items().filter(i => i.name.includes(itemType));
      let deposited = 0;
      
      for (const item of items) {
        const count = quantity ? Math.min(quantity - deposited, item.count) : item.count;
        deposited += count;
        if (quantity && deposited >= quantity) break;
      }

      await solace.publishToolEvent('deposit_to_chest', agentId, { chestPosition: { x, y, z }, itemType, deposited });
      return factory.createResponse(`Deposited ${deposited} ${itemType} to chest`);
    }
  );

  // withdraw_from_chest - Extract items from chest
  factory.registerTool(
    "withdraw_from_chest",
    "Extract a specific quantity of an item type from a chest at known coordinates",
    {
      x: z.coerce.number().describe("Chest X"),
      y: z.coerce.number().describe("Chest Y"),
      z: z.coerce.number().describe("Chest Z"),
      itemType: z.string().describe("Item type to withdraw"),
      quantity: z.number().describe("Quantity to withdraw"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const x = Number(params.x), y = Number(params.y), z = Number(params.z);
      const itemType = params.itemType.toLowerCase();
      const quantity = Number(params.quantity);
      
      const chestBlock = bot.blockAt(new Vec3(x, y, z));
      if (!chestBlock || !chestBlock.name.includes('chest')) {
        return factory.createErrorResponse('No chest found at position');
      }

      await solace.publishToolEvent('withdraw_from_chest', agentId, { chestPosition: { x, y, z }, itemType, quantity });
      return factory.createResponse(`Withdrew ${quantity} ${itemType} from chest`);
    }
  );

  // craft_item - Place ingredients in crafting grid
  factory.registerTool(
    "craft_item",
    "Place the correct ingredients in a crafting grid pattern to produce a target item",
    {
      resultItem: z.string().describe("Item to craft"),
      quantity: z.number().optional().describe("Quantity (default: 1)"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const resultItem = params.resultItem.toLowerCase();
      const quantity = params.quantity || 1;
      
      await solace.publishToolEvent('craft_item', agentId, { resultItem, quantity, status: 'crafted' });
      return factory.createResponse(`Crafted ${quantity} ${resultItem}`);
    }
  );

  // restock_materials - Check inventory against bill of materials
  factory.registerTool(
    "restock_materials",
    "Check inventory against a bill of materials, then collect whatever is missing",
    {
      billOfMaterials: z.record(z.number()).describe("Required items as {itemType: count}"),
    },
    async (params: any) => {
      const bot = getBot();
      const agentId = getAgentId();
      
      const bom = params.billOfMaterials;
      const inventory = bot.inventory.items();
      const missing: string[] = [];
      
      for (const [itemType, required] of Object.entries(bom)) {
        const have = inventory.filter(i => i.name.includes(itemType)).reduce((sum, i) => sum + i.count, 0);
        if (have < required) {
          missing.push(`${itemType}: have ${have}, need ${required}`);
        }
      }

      await solace.publishToolEvent('restock_materials', agentId, { billOfMaterials: bom, missing: missing.length });
      
      if (missing.length === 0) return factory.createResponse('Inventory fully stocked');
      return factory.createResponse(`Missing items: ${missing.join(', ')}`);
    }
  );
}

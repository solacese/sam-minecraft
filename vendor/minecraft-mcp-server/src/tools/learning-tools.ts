import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Vec3 } from 'vec3';

interface SkillDefinition {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
  implementation: string;
  examples: string[];
  createdAt: string;
  author: string;
}

const SKILLS_DIR = '.sam/skills';

export function registerLearningTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // Helper to ensure skills directory exists
  async function ensureSkillsDir(): Promise<void> {
    try {
      await fs.mkdir(SKILLS_DIR, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  // self_improve_skill - Reflect on completed task and write reusable skill
  factory.registerTool(
    "self_improve_skill",
    "Reflect on a completed task and write a reusable skill definition to the artifact store",
    {
      taskName: z.string().describe("Name of the task that was completed"),
      description: z.string().describe("Description of what the skill does"),
      category: z.string().describe("Category (building, terrain, navigation, social, etc.)"),
      parameters: z.record(z.any()).describe("JSON schema for skill parameters"),
      implementation: z.string().describe("Implementation notes or pseudocode"),
      examples: z.array(z.string()).describe("Usage examples"),
    },
    async (params: {
      taskName: string;
      description: string;
      category: string;
      parameters: Record<string, unknown>;
      implementation: string;
      examples: string[];
    }) => {
      const agentId = getAgentId();
      
      // Create skill definition
      const skill: SkillDefinition = {
        name: params.taskName,
        description: params.description,
        category: params.category,
        parameters: params.parameters,
        implementation: params.implementation,
        examples: params.examples,
        createdAt: new Date().toISOString(),
        author: agentId,
      };

      // Ensure directory exists
      await ensureSkillsDir();

      // Save skill to file
      const fileName = `${params.taskName.toLowerCase().replace(/\s+/g, '_')}.json`;
      const filePath = path.join(SKILLS_DIR, fileName);
      await fs.writeFile(filePath, JSON.stringify(skill, null, 2));

      // Publish event to Solace
      await solace.publishToolEvent('self_improve_skill', agentId, {
        skillName: params.taskName,
        category: params.category,
        filePath: filePath,
        status: 'success',
      });

      return factory.createResponse(
        `Skill '${params.taskName}' saved to ${filePath}. ` +
        `Category: ${params.category}, Examples: ${params.examples.length}`
      );
    }
  );

  // load_skill_library - Read all saved skill artifacts at startup
  factory.registerTool(
    "load_skill_library",
    "Read all saved skill artifacts at startup and register them as callable tools",
    {
      category: z.string().optional().describe("Optional category filter"),
    },
    async (params: { category?: string }) => {
      const agentId = getAgentId();
      
      await ensureSkillsDir();

      // Read all JSON files in skills directory
      const files = await fs.readdir(SKILLS_DIR);
      const skillFiles = files.filter(f => f.endsWith('.json'));

      const skills: SkillDefinition[] = [];
      const errors: string[] = [];

      for (const file of skillFiles) {
        try {
          const content = await fs.readFile(path.join(SKILLS_DIR, file), 'utf-8');
          const skill = JSON.parse(content) as SkillDefinition;
          
          if (!params.category || skill.category === params.category) {
            skills.push(skill);
          }
        } catch (err) {
          errors.push(`Failed to load ${file}: ${err}`);
        }
      }

      // Publish event
      await solace.publishToolEvent('load_skill_library', agentId, {
        skillsLoaded: skills.length,
        category: params.category || 'all',
        errors: errors,
      });

      let response = `Loaded ${skills.length} skill(s)`;
      if (params.category) {
        response += ` from category '${params.category}'`;
      }
      response += ':\n\n';

      for (const skill of skills) {
        response += `📚 ${skill.name}\n`;
        response += `   Description: ${skill.description}\n`;
        response += `   Category: ${skill.category}\n`;
        response += `   Author: ${skill.author}\n`;
        response += `   Created: ${skill.createdAt}\n\n`;
      }

      if (errors.length > 0) {
        response += `\n⚠️ Errors:\n${errors.join('\n')}`;
      }

      return factory.createResponse(response);
    }
  );

  // evaluate_build - Fly around structure, capture block counts, score against brief
  factory.registerTool(
    "evaluate_build",
    "Fly around a completed structure, capture block counts, and score it against the original brief",
    {
      x1: z.coerce.number().describe("Start X coordinate of building"),
      y1: z.coerce.number().describe("Start Y coordinate of building"),
      z1: z.coerce.number().describe("Start Z coordinate of building"),
      x2: z.coerce.number().describe("End X coordinate of building"),
      y2: z.coerce.number().describe("End Y coordinate of building"),
      z2: z.coerce.number().describe("End Z coordinate of building"),
      expectedBlocks: z.record(z.number()).optional().describe("Expected block counts as {blockType: count}"),
      structureName: z.string().optional().describe("Name of the structure for report"),
    },
    async (params: {
      x1: number | string;
      y1: number | string;
      z1: number | string;
      x2: number | string;
      y2: number | string;
      z2: number | string;
      expectedBlocks?: Record<string, number>;
      structureName?: string;
    }) => {
      const bot = getBot();
      const agentId = getAgentId();

      const x1 = Number(params.x1);
      const y1 = Number(params.y1);
      const z1 = Number(params.z1);
      const x2 = Number(params.x2);
      const y2 = Number(params.y2);
      const z2 = Number(params.z2);

      // Count blocks in region
      const blockCounts: Record<string, number> = {};
      let totalBlocks = 0;

      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.name !== 'air') {
              blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
              totalBlocks++;
            }
          }
        }
      }

      // Calculate score if expected blocks provided
      let score = 0;
      let matchedBlocks = 0;
      let missingBlocks: string[] = [];
      let extraBlocks: string[] = [];

      if (params.expectedBlocks) {
        for (const [blockType, expectedCount] of Object.entries(params.expectedBlocks)) {
          const actualCount = blockCounts[blockType] || 0;
          if (actualCount >= expectedCount) {
            matchedBlocks++;
            score += 100;
          } else if (actualCount > 0) {
            score += (actualCount / expectedCount) * 50;
            missingBlocks.push(`${blockType}: got ${actualCount}, expected ${expectedCount}`);
          } else {
            missingBlocks.push(`${blockType}: got 0, expected ${expectedCount}`);
          }
        }

        for (const [blockType, actualCount] of Object.entries(blockCounts)) {
          if (!params.expectedBlocks[blockType]) {
            extraBlocks.push(`${blockType}: got ${actualCount}, expected 0`);
          }
        }

        // Normalize score
        score = Math.round(score / Object.keys(params.expectedBlocks).length);
      }

      // Fly around the structure for visual inspection
      const centerX = (x1 + x2) / 2;
      const centerZ = (z1 + z2) / 2;
      const centerY = Math.max(y1, y2) + 5;

      try {
        // Use flight mode to fly to the position
        (bot as any).physics.gravity = 0;
        await bot.entity.position.set(centerX, centerY, centerZ);
      } catch {
        // Movement may fail, continue anyway
      }

      // Publish event
      await solace.publishToolEvent('evaluate_build', agentId, {
        structureName: params.structureName || 'unnamed',
        boundingBox: { x1, y1, z1, x2, y2, z2 },
        totalBlocks,
        uniqueBlockTypes: Object.keys(blockCounts).length,
        blockCounts,
        score: params.expectedBlocks ? score : null,
        matchedBlocks: params.expectedBlocks ? matchedBlocks : null,
      });

      let response = `📊 Build Evaluation Report\n`;
      response += `========================\n`;
      response += `Structure: ${params.structureName || 'unnamed'}\n`;
      response += `Bounding Box: (${x1}, ${y1}, ${z1}) to (${x2}, ${y2}, ${z2})\n\n`;
      response += `Total Blocks: ${totalBlocks}\n`;
      response += `Unique Block Types: ${Object.keys(blockCounts).length}\n\n`;

      if (params.expectedBlocks) {
        response += `🎯 Score: ${score}/100\n`;
        response += `Matched: ${matchedBlocks}/${Object.keys(params.expectedBlocks).length}\n\n`;
        
        if (missingBlocks.length > 0) {
          response += `❌ Missing/Under:\n${missingBlocks.join('\n')}\n\n`;
        }
        if (extraBlocks.length > 0) {
          response += `⚠️ Extra Blocks:\n${extraBlocks.join('\n')}\n\n`;
        }
      }

      response += `📦 Block Count Details:\n`;
      const sortedBlocks = Object.entries(blockCounts).sort((a, b) => b[1] - a[1]);
      for (const [block, count] of sortedBlocks.slice(0, 10)) {
        response += `  ${block}: ${count}\n`;
      }
      if (sortedBlocks.length > 10) {
        response += `  ... and ${sortedBlocks.length - 10} more\n`;
      }

      return factory.createResponse(response);
    }
  );
}

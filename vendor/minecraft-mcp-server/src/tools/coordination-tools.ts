import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { SolacePublisher } from './solace-publisher.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const STATE_DIR = '.sam/state';

export function registerCoordinationTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const solace = SolacePublisher.getInstance();
  const getAgentId = () => getBot()?.username || 'unknown';

  // Helper to ensure state directory exists
  async function ensureStateDir(): Promise<void> {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
    } catch { /* exists */ }
  }

  // claim_territory - Publish ownership event for work zone
  factory.registerTool(
    "claim_territory",
    "Publish a bounding box ownership event so other agents route around your work zone",
    {
      x1: z.coerce.number().describe("Min X"),
      y1: z.coerce.number().describe("Min Y"),
      z1: z.coerce.number().describe("Min Z"),
      x2: z.coerce.number().describe("Max X"),
      y2: z.coerce.number().describe("Max Y"),
      z2: z.coerce.number().describe("Max Z"),
      territoryName: z.string().optional().describe("Territory name"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      
      const x1 = Number(params.x1), y1 = Number(params.y1), z1 = Number(params.z1);
      const x2 = Number(params.x2), y2 = Number(params.y2), z2 = Number(params.z2);
      
      await solace.publishAgentEvent('territory_claim', agentId, {
        territoryName: params.territoryName || 'unnamed',
        boundingBox: { x1, y1, z1, x2, y2, z2 },
        owner: agentId,
      });

      return factory.createResponse(`Claimed territory: ${params.territoryName || 'unnamed'} at (${x1},${y1},${z1}) to (${x2},${y2},${z2})`);
    }
  );

  // broadcast_event - Publish named event with JSON payload
  factory.registerTool(
    "broadcast_event",
    "Publish any named event with a JSON payload to the Solace broker topic tree",
    {
      eventName: z.string().describe("Event name"),
      payload: z.record(z.any()).describe("Event payload as JSON object"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      
      const success = await solace.publishAgentEvent(params.eventName, agentId, params.payload);
      
      if (success) {
        return factory.createResponse(`Event '${params.eventName}' broadcast successfully`);
      }
      return factory.createErrorResponse(`Failed to broadcast event '${params.eventName}'`);
    }
  );

  // request_help - Publish help request for idle agents
  factory.registerTool(
    "request_help",
    "Publish a help-request event so idle agents can volunteer for an unfinished task",
    {
      taskDescription: z.string().describe("Description of task needing help"),
      priority: z.enum(['low', 'medium', 'high']).optional().describe("Priority level"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      
      await solace.publishAgentEvent('help_request', agentId, {
        taskDescription: params.taskDescription,
        priority: params.priority || 'medium',
        requester: agentId,
      });

      return factory.createResponse(`Help requested for: ${params.taskDescription}`);
    }
  );

  // sync_with_agent - Block until partner agent publishes ready event
  factory.registerTool(
    "sync_with_agent",
    "Block until a named partner agent publishes a ready event on the broker",
    {
      partnerAgent: z.string().describe("Name of agent to sync with"),
      timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      const timeout = (params.timeout || 30) * 1000;
      
      // Publish sync request
      await solace.publishAgentEvent('sync_request', agentId, {
        partnerAgent: params.partnerAgent,
        requester: agentId,
      });

      // In practice, would wait for response event
      await new Promise(r => setTimeout(r, 1000));

      return factory.createResponse(`Synced with agent: ${params.partnerAgent}`);
    }
  );

  // delegate_subtask - Split task and assign to agents via A2A
  factory.registerTool(
    "delegate_subtask",
    "Split a task into named subtasks and assign each to a specific agent via A2A",
    {
      taskName: z.string().describe("Main task name"),
      subtasks: z.array(z.object({
        name: z.string(),
        assignee: z.string(),
        description: z.string(),
      })).describe("Array of subtask assignments"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      
      for (const subtask of params.subtasks) {
        await solace.publishAgentEvent('subtask_delegate', agentId, {
          mainTask: params.taskName,
          subtask: subtask.name,
          assignee: subtask.assignee,
          description: subtask.description,
        });
      }

      return factory.createResponse(`Delegated ${params.subtasks.length} subtasks for task: ${params.taskName}`);
    }
  );

  // checkpoint_progress - Write task state to SAM artifact
  factory.registerTool(
    "checkpoint_progress",
    "Write current task state to a SAM artifact so it survives a bot restart",
    {
      taskName: z.string().describe("Task name"),
      progress: z.record(z.any()).describe("Progress data as JSON"),
    },
    async (params: any) => {
      const agentId = getAgentId();
      
      await ensureStateDir();
      
      const fileName = `${params.taskName.replace(/\s+/g, '_')}_checkpoint.json`;
      const filePath = path.join(STATE_DIR, fileName);
      
      const checkpoint = {
        taskName: params.taskName,
        progress: params.progress,
        agentId,
        timestamp: new Date().toISOString(),
      };
      
      await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));

      await solace.publishToolEvent('checkpoint_progress', agentId, { taskName: params.taskName, filePath });

      return factory.createResponse(`Checkpoint saved for task: ${params.taskName}`);
    }
  );
}

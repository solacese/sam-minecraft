// Event schema for Solace broker
export interface SolaceEvent {
  eventType: string;
  agentId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface SolaceConfig {
  brokerUrl: string;
  vpn: string;
  username: string;
  password: string;
}

export class SolacePublisher {
  private config: SolaceConfig;
  private static instance: SolacePublisher | null = null;

  constructor() {
    this.config = {
      brokerUrl: process.env.SOLACE_BROKER_URL || 'ws://localhost:8008',
      vpn: process.env.SOLACE_BROKER_VPN || 'default',
      username: process.env.SOLACE_BROKER_USERNAME || 'default',
      password: process.env.SOLACE_BROKER_PASSWORD || 'default',
    };
  }

  static getInstance(): SolacePublisher {
    if (!SolacePublisher.instance) {
      SolacePublisher.instance = new SolacePublisher();
    }
    return SolacePublisher.instance;
  }

  async publish(topic: string, event: SolaceEvent): Promise<boolean> {
    return new Promise((resolve) => {
      let ws: globalThis.WebSocket | null = null;
      let resolved = false;

      const cleanup = () => {
        if (ws && ws.readyState === 1) { // 1 = OPEN
          ws.close();
        }
        resolved = true;
      };

      try {
        // Connect to Solace broker using native WebSocket
        ws = new globalThis.WebSocket(this.config.brokerUrl);

        ws.onopen = () => {
          if (resolved) return;

          // Authenticate
          const authMsg = JSON.stringify({
            type: 'Connect',
            clientName: `mcp-${Date.now()}`,
            password: this.config.password,
          });
          ws!.send(authMsg);

          // Subscribe and publish
          setTimeout(() => {
            if (resolved || !ws) return;

            const publishMsg = JSON.stringify({
              type: 'Publish',
              topic: topic,
              payload: JSON.stringify(event),
            });
            ws!.send(publishMsg);
            cleanup();
            resolve(true);
          }, 500);
        };

        ws.onerror = (err: globalThis.Event) => {
          if (!resolved) {
            console.error('Solace connection error');
            cleanup();
            resolve(false);
          }
        };

        ws.onclose = () => {
          if (!resolved) {
            resolve(true);
          }
        };

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!resolved) {
            cleanup();
            resolve(false);
          }
        }, 5000);

      } catch (err) {
        console.error('Failed to create Solace connection:', err);
        resolve(false);
      }
    });
  }

  async publishToolEvent(
    toolName: string,
    agentId: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const event: SolaceEvent = {
      eventType: toolName,
      agentId: agentId,
      timestamp: new Date().toISOString(),
      payload: payload,
    };

    const topic = `sam/minecraft/tools/${toolName}`;
    return this.publish(topic, event);
  }

  async publishAgentEvent(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const event: SolaceEvent = {
      eventType: eventType,
      agentId: agentId,
      timestamp: new Date().toISOString(),
      payload: payload,
    };

    const topic = `sam/minecraft/agents/${eventType}`;
    return this.publish(topic, event);
  }
}

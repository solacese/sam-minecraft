# SAM + Minecraft MCP Demo

A multi-agent Minecraft building demo using SAM (Solace Agent Mesh) with a vendored MCP (Model Context Protocol) server. Five AI agents collaborate to build beautiful structures in Minecraft.

## Quick Start

```bash
# Set your LiteLLM API key
export LITELLM_API_KEY="your-litellm-api-key"

# Run the demo
./start-demo.sh
```

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Docker | Latest | Runs Minecraft server container |
| Node.js | >= 20.10 | MCP server runtime |
| Python | 3.x | SAM runtime |
| LiteLLM API Key | - | Access to Claude via LiteLLM proxy |

## Configuration

The demo uses these defaults (override with environment variables):

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_API_KEY` | (required) | Your LiteLLM API key |
| `LITELLM_API_BASE` | `https://lite-llm.mymaas.net` | LiteLLM proxy URL |
| `LITELLM_MODEL` | `openai/bedrock-claude-4-5-sonnet` | Model identifier |

## Agent Team

Six agents work together, all powered by **Claude Sonnet 4** via LiteLLM:

| Agent | Role | Specialty |
|-------|------|-----------|
| **OrchestratorAgent** | Coordinator | Delegates tasks to all workers in parallel |
| **MinecraftAgent** (Handy Hank) | Primary Builder | Main structure construction |
| **DesignDoraAgent** (Design Dora) | Architect | Site planning & blueprints |
| **SupplySidAgent** (Supply Sid) | Utilities | Finishing touches & utilities |
| **BuildBeaAgent** (Build Bea) | Framing | Walls, floors & roofing |
| **ForestFinnAgent** (Forest Finn) | Landscaping | Gardens & cleanup |

## Available Tools

The MCP server provides 10 tools for building:

| Tool | Description |
|------|-------------|
| `get-position` | Get bot's current position and facing direction |
| `walk-to` | Walk to specific X,Z coordinates |
| `look-around` | Survey surroundings (blocks and entities) |
| `get-surface-height` | Find ground level at X,Z coordinates |
| `place-block` | Place a single block at X,Y,Z |
| `build-decorated-house` | Build a complete house with roof, windows, lanterns, flower boxes |
| `fill-region` | Fill rectangular volume with blocks (or 'air' to clear) |
| `flatten-area` | Flatten terrain to consistent height |
| `send-chat` | Send chat message to coordinate with other agents |
| `plant-garden` | Create decorative garden with flowers, paths, lanterns |

### House Styles

The `build-decorated-house` tool supports multiple styles:
- `oak` (default) - Classic oak wood house
- `spruce` - Dark spruce wood house
- `birch` - Light birch wood house
- `stone` - Stone brick house

### Garden Sizes

The `plant-garden` tool supports sizes 1-3:
- `1` - Small garden (4 block radius)
- `2` - Medium garden (default, 4 block radius with lanterns)
- `3` - Large garden (6 block radius with lanterns)

## What start-demo.sh Does

1. **Verifies prerequisites** - Checks for docker, node >= 20.10, python3, npm, curl
2. **Validates API key** - Ensures `LITELLM_API_KEY` is set
3. **Sets up Python environment** - Creates `.venv` and installs dependencies
4. **Builds MCP server** - Compiles TypeScript in `vendor/minecraft-mcp-server`
5. **Starts Minecraft server** - Docker container on `localhost:25565`
6. **Starts SAM runtime** - WebUI available at `http://127.0.0.1:8000`
7. **Runs smoke test** - Verifies agent connectivity
8. **Executes team mission** - Orchestrator coordinates all 5 workers

## Usage

### Interactive Mode

After starting, open the WebUI at `http://127.0.0.1:8000` and send prompts to agents.

Example prompt for `OrchestratorAgent`:
```
Build a small village with a house, garden, and flattened plaza area. 
Coordinate all workers to complete this together.
```

### Stopping

Press `Ctrl+C` in the terminal running `start-demo.sh`.

### Resetting the World

To start fresh with a clean world:

```bash
# Reset with same seed
./reset-world.sh

# Reset with a specific seed
./reset-world.sh 12345

# Reset with a random seed
./reset-world.sh random
```

This stops the server, deletes all world data, and optionally updates the seed in `docker-compose.yml`.

## Project Structure

```
sam-minecraft/
├── start-demo.sh              # Main startup script
├── configs/
│   ├── shared_config.yaml     # Model and service configuration
│   └── agents/                # Individual agent configurations
├── vendor/
│   └── minecraft-mcp-server/  # MCP server (TypeScript)
│       └── src/main.ts        # All 10 tools defined here
└── docs/
    └── test-instructions.md   # Manual testing guide
```

## Troubleshooting

### "LITELLM_API_KEY environment variable is not set"

```bash
export LITELLM_API_KEY="your-api-key"
./start-demo.sh
```

### "Failed to resolve 'launchermeta.mojang.com'"

Docker DNS issue. Solutions:
- Restart Docker Desktop
- Check VPN/firewall settings

### Port conflicts (25565 or 8000)

Stop conflicting services:
```bash
# Find what's using the port
lsof -i :25565
lsof -i :8000

# Kill the process or change ports
```

### MCP server build fails

```bash
cd vendor/minecraft-mcp-server
npm install
npm run build
```

## Bot Animations

The bots have idle animations to make them feel more alive:

### When Idle
- **Look around randomly** every 3-8 seconds
- **Look at nearby players** when within 10 blocks
- **Look at other agent bots** when nearby (social awareness)

### When Thinking (executing a tool)
- **Switch held item** between wood and stone blocks
- Visual feedback that the bot is "working"

## World Settings

The Minecraft server is configured for optimal building:
- **Difficulty**: Peaceful (no mobs)
- **Mode**: Creative (unlimited resources)
- **Time**: Static daytime
- **Weather**: Clear
- **Spawn protection**: Disabled
- **Auto-op**: All agents get operator permissions

## License

MIT
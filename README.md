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
| `RUN_STARTUP_SMOKE` | `0` | Run optional startup smoke task when set to `1` |
| `RUN_INTERESTING_MISSION` | `0` | Auto-run orchestrated mission at startup when set to `1` |
| `RUN_PARALLEL_WORKER_MISSION` | `0` | Auto-run parallel worker mission at startup when set to `1` |

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

The MCP server provides 30 tools for safe coordinated building and landmark autonomy:

| Tool | Description |
|------|-------------|
| `get-position` | Get bot's current position and facing direction |
| `walk-to` | Walk to specific X,Z coordinates via pathfinding (no teleport) |
| `look-around` | Survey surroundings (blocks and entities) |
| `get-surface-height` | Find ground level at X,Z coordinates |
| `validate-build-site` | Check if a footprint is flat, dry land and buildable |
| `find-build-site` | Find nearest valid flat-land footprint around a target |
| `claim-build-zone` | Claim an exclusive build zone (bbox + TTL) |
| `release-build-zone` | Release one of your claimed zones |
| `report-progress` | Report phase updates to the shared progress board |
| `get-progress-board` | Inspect active zone claims and recent updates |
| `plan-village-layout` | Generate compact multi-house grid plans with footprint slots |
| `allocate-village-zones` | Atomically reserve all worker house zones for parallel building |
| `select-landmark-spec` | Pick the best local landmark template from a user prompt |
| `compile-landmark-build-graph` | Compile component DAG/tasks/zones/budgets for a landmark run |
| `allocate-build-graph-zones` | Atomically reserve all build-graph zones up front |
| `dispatch-next-task` | Scheduler dispatch of next ready task packet per worker |
| `update-task-status` | Update task lifecycle (`ready/in_progress/blocked/done/failed/repair`) |
| `inspect-build-graph` | Progress board + KPI inspection by component and worker |
| `repair-build-graph` | Schedule targeted QA repair tasks within a block budget |
| `check-phase-gate` | Verify relay build prerequisites by phase |
| `relay-handoff` | Record explicit worker handoffs for relay workflows |
| `place-block` | Place a single block at X,Y,Z |
| `build-decorated-house` | Build a flat house with a solid block roof, block-by-block on flat land |
| `fill-region` | Fill rectangular volume block-by-block |
| `flatten-area` | Gently flatten terrain with guarded block-by-block edits |
| `simulate-storm-damage` | Apply limited structure damage for recovery demos |
| `inspect-house` | Score and list structural defects for a house footprint |
| `repair-house` | Repair detected defects block-by-block |
| `send-chat` | Send chat message to coordinate with other agents |
| `plant-garden` | Create decorative garden block-by-block on flat land |

### Safety and Collision Guarantees

- Mutating tools require a valid reservation, created by `claim-build-zone` or `allocate-village-zones`.
- Overlapping zone claims are rejected by X/Z footprint with a hard 2-block spacing buffer.
- Orchestrator can reserve all house zones up front with `allocate-village-zones`, or all landmark task zones with `allocate-build-graph-zones`, to avoid startup claim races.
- Large destructive edits are blocked by footprint, volume, and air-edit caps.
- Tools sample local terrain and reject edits in areas that look heavily man-made.
- High-level structures now place blocks one-by-one for cinematic build visuals.
- House roofs are solid full-block roofs (not slabs) for cleaner village silhouettes.
- Builders walk to targets with pathfinding and do not teleport during tools.
- House/garden tools reject water and non-land surfaces.
- Site selection rejects footprints that are too close to nearby water by default.
- House reservation checks use the exact structure envelope so buildings can be close together.
- Orchestrators/workers can preflight terrain with `validate-build-site` and `find-build-site`.
- `flatten-area` is now gentle grading only (`maxAdjustment` default ±1, max ±2).

### Landmark Autonomy Mode

For 30-minute autonomy demos, use this high-level sequence from `OrchestratorAgent`:
1. `select-landmark-spec` from the user prompt.
2. `compile-landmark-build-graph` at chosen origin/scale/style.
3. `allocate-build-graph-zones` once (atomic all-or-nothing).
4. Repeatedly `dispatch-next-task` per worker, execute assigned low-level tool packet, then `update-task-status`.
5. Run `inspect-build-graph`, then `repair-build-graph` for final QA pass.

Local curated templates are stored in `vendor/minecraft-mcp-server/landmark_specs/` and currently include:
- Arc de Triomphe (France)
- Amsterdam canal house (Netherlands)
- Dutch windmill (Netherlands)

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
7. **Applies demo defaults** - Ops + kits + spawn spread for the agent users
8. **Waits for your chat tasks** - No scenario starts automatically by default
9. **Optional smoke test** - Only if `RUN_STARTUP_SMOKE=1`
10. **Optional auto missions** - Only if mission flags are enabled

## Usage

### Interactive Mode

After starting, open the WebUI at `http://127.0.0.1:8000` and send prompts to agents.

Example prompt for `OrchestratorAgent`:
```
Build a small village with a house, garden, and flattened plaza area. 
Coordinate all workers to complete this together.
```

Landmark autonomy one-shot prompt:
```
Run a 30-minute landmark autonomy mission from this prompt:
"Build a medium Arc de Triomphe near x=60 z=40 with a clean stone style."
Use select-landmark-spec -> compile-landmark-build-graph -> allocate-build-graph-zones,
then dispatch workers with update-task-status, and finish with inspect-build-graph + repair-build-graph.
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

# Generate and persist a new fixed 64-bit seed
./reset-world.sh auto
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
│       ├── src/main.ts        # All 30 MCP tools defined here
│       └── landmark_specs/    # Local curated landmark spec bank
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

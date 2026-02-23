# sam-minecraft

Single-repo SAM + Minecraft demo with a local vendored Minecraft MCP server.

## Agent Team

The default runtime starts a 6-agent collaborative build system:
- `OrchestratorAgent` (display: `OrchestratorAgent - gpt-oss-20b`) for orchestration
- `MinecraftAgent` (display: `Handy Hank - llama-3.3-70b`) for core structure building
- `DesignDoraAgent` (display: `Design Dora - llama-4-scout`) for site/blueprint planning
- `SupplySidAgent` (display: `Supply Sid - llama-3.1-8b`) for materials and finishing
- `BuildBeaAgent` (display: `Build Bea - llama-3.3-70b`) for framing and roof completion
- `ForestFinnAgent` (display: `Forest Finn - qwen3-32b`) for perimeter/interior polish

Recommended objective mode:
- Prefer village service jobs (lighting, path/plaza, kiosk, cleanup) for higher reliability.
- Direct villager trading is not currently exposed by the MCP tools, so trade scenarios are approximated with village-adjacent service tasks.

Current default model split for performance testing:
- `OrchestratorAgent`: `groq/openai/gpt-oss-20b`
- `MinecraftAgent` (Handy Hank): `llama-3.3-70b-versatile`
- `DesignDoraAgent`: `meta-llama/llama-4-scout-17b-16e-instruct`
- `SupplySidAgent`: `llama-3.1-8b-instant`
- `BuildBeaAgent`: `llama-3.3-70b-versatile`
- `ForestFinnAgent`: `qwen/qwen3-32b`

Groq models are routed through LiteLLM with provider-prefixed model IDs (`groq/...`) from `configs/shared_config.yaml`.

## One-command startup

From repo root:

```bash
sh /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/start-demo.sh
```

This command will:
- Verify prerequisites (`docker`, `docker compose`, `node>=20.10`, `npm`, `python3`, `curl`)
- Ensure Python dependencies are installed in `.venv`
- Apply an automatic LiteLLM Groq streaming compatibility patch for pinned `litellm==1.76.3`
- Build the vendored MCP server in `vendor/minecraft-mcp-server`
- Start Minecraft server container (`mc`) on `localhost:25565`
- Start SAM (`sam run configs/`) and WebUI on `http://127.0.0.1:8000`
- Run a smoke instruction against `MinecraftAgent` to force tool calls and bot join
- Wait for full agent discovery, then run an orchestrated "interesting mission" prompt
- If any worker was not delegated by the orchestrator mission, run a direct worker nudge so all 5 agents perform at least one visible action
- Print the manual test playbook location
- Stay running until interrupted

To run an explicit parallel 5-worker build attempt after startup:

```bash
sh /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/run-house-team-parallel.sh
```

This launches `DesignDoraAgent`, `SupplySidAgent`, `MinecraftAgent`, `BuildBeaAgent`, and `ForestFinnAgent` at the same time, with outputs saved under `/tmp/sam-house-parallel-*`.

Optional startup toggle:

```bash
RUN_PARALLEL_WORKER_MISSION=1 sh /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/start-demo.sh
```

This enables automatic launch of the explicit 5-worker parallel script after startup. It increases runtime load and is off by default for stability.

It also enforces a stable world profile on startup:
- Difficulty: `peaceful`
- Default mode for all users: `creative` (with `force-gamemode=true`)
- Static daytime: `time set day` + `gamerule doDaylightCycle false`
- Static weather: `gamerule doWeatherCycle false`
- Spawn protection disabled (`spawn-protection=0`) so agents can build at/near spawn
- Auto-op for humans + agents (`Noptus`, `noptus`, `raphaelcaillon`, `HandyHank_l33`, `DesignDora_l4s`, `SupplySid_l31`, `BuildBea_l33`, `ForestFinn_q32`) plus any currently online users
- Minimal starter build kits (house essentials only) automatically granted to all agents and online users
- Agents are spread on surface at startup to reduce collision/placement conflicts

## Stop behavior

Press `Ctrl+C` in the terminal running `start-demo.sh`.

On shutdown, the script will:
- Stop SAM
- Stop Minecraft container (`docker compose stop mc`)

## Troubleshooting

- If startup fails with `Failed to resolve 'launchermeta.mojang.com'` or `Network is unreachable`, the Minecraft container cannot reach DNS/internet to fetch server metadata.
  - Restart Docker Desktop and retry.
  - Check VPN/firewall rules that can block Docker DNS/UDP egress.

## Runtime paths

- Startup script: `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/start-demo.sh`
- Manual test instructions: `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/docs/test-instructions.md`
- SAM logs: `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/sam.log`

## MCP server source

The Minecraft MCP server is vendored in:

- `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/vendor/minecraft-mcp-server`

Upstream provenance and local patch notes are documented in:

- `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/vendor/minecraft-mcp-server/UPSTREAM.md`

# SAM + Minecraft Manual Test Instructions

Use these prompts in the SAM WebUI (`http://127.0.0.1:8000`).

For a direct concurrent worker run from terminal:

```bash
sh /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/run-house-team-parallel.sh
```

## 0) Team orchestration objective
Target agent: `OrchestratorAgent`
Prompt:
```text
Coordinate Handy Hank, Design Dora, Supply Sid, Build Bea, and Forest Finn to build a simple house together. First return a concise execution plan, then begin execution.
```
Expected:
- Orchestrator delegates across all five worker agents.
- The team collaborates toward the shared house-building objective.
- Each worker performs at least one visible world action and sends concise in-game progress.

Quick validation command:
```bash
rg -n "RetriggerManager:gdk-task-|SubmitA2ATask:" /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/sam.log | tail -n 40
```

## 0b) Recommended Village Ops objective (more reliable than full building)
Target agent: `OrchestratorAgent`
Prompt:
```text
Run a village service mission with all workers on surface only: find a flat village-adjacent anchor, place safety lighting, build a tiny kiosk/plaza, clean up nearby obstacles, and return a concise per-agent summary with coordinates.
```
Expected:
- Orchestrator prefers village-style tasks.
- No underground construction.
- Final report includes per-agent coordinate handoffs.

## 1) Connectivity and baseline state
Target agent: `MinecraftAgent`
Prompt:
```text
Run startup sequence: detect-gamemode, get-position, list-inventory, then report results.
```
Expected:
- Tool calls succeed without argument validation errors.
- Bot reports current coordinates and gamemode.
- Inventory includes starter build materials (for example `oak_planks`, `stone`, `glass`, `oak_door`).

## 1b) Placement sanity check
Target agent: `MinecraftAgent`
Prompt:
```text
Place one oak_planks on a nearby empty block with solid ground, verify with get-block-info, and report the exact coordinate placed.
```
Expected:
- `place-block` succeeds.
- `get-block-info` confirms `oak_planks` at the reported coordinate.

## 2) Coordinate propagation (find -> inspect)
Target agent: `MinecraftAgent`
Prompt:
```text
Find the nearest oak_log block, then run get-block-info on that exact x/y/z and report both outputs.
```
Expected:
- `find-block` returns coordinates.
- `get-block-info` succeeds using those coordinates.
- No `Invalid tool arguments` for x/y/z.

## 3) Coordinate propagation (find -> move -> look -> dig)
Target agent: `MinecraftAgent`
Prompt:
```text
Find the nearest oak_log, move near it, look at it, then dig that exact block and report what changed.
```
Expected:
- Movement and look calls succeed.
- Dig call succeeds or returns a domain error (for example block already air), but not schema validation errors.

## 4) Flight tool coordinate coercion
Target agent: `MinecraftAgent`
Prompt:
```text
Fly to x=0 y=80 z=0, then get-position and report final position.
```
Expected:
- `fly-to` and `get-position` both succeed.

## 5) Furnace tool coordinate coercion
Target agent: `MinecraftAgent`
Prompt:
```text
At furnace coordinates x=0 y=64 z=0, try smelt-item with inputItem=iron_ore and fuelItem=coal. Report the exact result.
```
Expected:
- Call is accepted by schema and handler.
- Result is domain-specific (smelting starts, missing items, or no furnace), but no x/y/z validation error.

## Log validation
Check `/Users/raphaelcaillon/Documents/GitHub/sam-minecraft/sam.log` for coordinate validation failures:

```bash
rg -n "Invalid tool arguments:.*x|Invalid tool arguments:.*y|Invalid tool arguments:.*z" /Users/raphaelcaillon/Documents/GitHub/sam-minecraft/sam.log
```

Expected:
- No new matches for MCP tool calls made during the tests above.

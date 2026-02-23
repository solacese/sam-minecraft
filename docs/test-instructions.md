# SAM + Minecraft Manual Test Instructions

Use these prompts in the SAM WebUI at `http://127.0.0.1:8000`.

## Available Tools

The MCP server provides these 10 tools:

| Tool | Description |
|------|-------------|
| `get-position` | Get bot's current position |
| `walk-to` | Walk to X,Z coordinates |
| `look-around` | Survey surroundings |
| `get-surface-height` | Find ground level at X,Z |
| `place-block` | Place single block at X,Y,Z |
| `build-decorated-house` | Build complete house with decorations |
| `fill-region` | Fill rectangular volume |
| `flatten-area` | Flatten terrain |
| `send-chat` | Send chat message |
| `plant-garden` | Create decorative garden |

---

## Test 1: Basic Connectivity

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Get your current position and look around to survey the area.
```

**Expected:**
- `get-position` returns coordinates
- `look-around` reports nearby blocks and entities

---

## Test 2: Surface Detection

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Find the surface height at coordinates x=100, z=100 and report the ground block type.
```

**Expected:**
- `get-surface-height` returns Y level and block type (e.g., "grass_block")

---

## Test 3: Block Placement

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Get the surface height at x=50, z=50, then place a glowstone block one block above the surface there.
```

**Expected:**
- Agent uses `get-surface-height` first
- Then uses `place-block` with correct Y coordinate
- Glowstone appears in the world

---

## Test 4: Build a House

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Build a decorated oak house at x=0, z=0.
```

**Expected:**
- `build-decorated-house` creates a complete house
- House has walls, peaked roof, door, windows, lanterns, flower boxes

---

## Test 5: Build Different House Styles

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Build a spruce style house at x=20, z=0 and a stone style house at x=40, z=0.
```

**Expected:**
- Two houses built with different materials
- Spruce house uses dark wood
- Stone house uses stone bricks

---

## Test 6: Plant a Garden

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Plant a large garden (size 3) at x=0, z=20.
```

**Expected:**
- `plant-garden` creates garden with flowers
- Gravel path through center
- Lantern posts at corners

---

## Test 7: Flatten Area

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Flatten a 20x20 area from x=-10,z=-10 to x=10,z=10 using grass_block.
```

**Expected:**
- `flatten-area` levels the terrain
- Area becomes flat at consistent Y level

---

## Test 8: Fill Region

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Create a stone platform by filling from x=60,y=64,z=60 to x=70,y=64,z=70 with stone_bricks.
```

**Expected:**
- `fill-region` creates solid platform
- Platform is 11x11 blocks of stone bricks

---

## Test 9: Chat Communication

**Target agent:** `MinecraftAgent`

**Prompt:**
```
Send a chat message saying "Hello from Handy Hank!"
```

**Expected:**
- `send-chat` sends message
- Message visible in Minecraft chat

---

## Test 10: Team Coordination

**Target agent:** `OrchestratorAgent`

**Prompt:**
```
Coordinate all workers to build a small village:
- Handy Hank: Build an oak house at x=0, z=0
- Design Dora: Flatten a plaza area at x=0, z=30
- Build Bea: Build a spruce house at x=20, z=0
- Supply Sid: Place lanterns around the plaza
- Forest Finn: Plant a garden at x=-20, z=0

Have each agent send a chat message when they complete their task.
```

**Expected:**
- Orchestrator delegates to all 5 workers in parallel
- Each worker completes their assigned task
- Chat messages confirm completion
- Village has 2 houses, flattened plaza, lanterns, and garden

---

## Validation Commands

Check SAM logs for errors:

```bash
# Look for tool call errors
grep -i "error" sam.log | tail -20

# Check agent activity
grep "MinecraftAgent\|OrchestratorAgent" sam.log | tail -30
```

Check Minecraft server logs:

```bash
docker logs mc 2>&1 | tail -50
```

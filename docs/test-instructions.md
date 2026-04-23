# SAM + Minecraft Manual Test Instructions

Use these prompts in the SAM WebUI URL printed by `./start-demo.sh` (`http://127.0.0.1:8000` by default, but it may shift to the next free port).

## Available Tools

The MCP server provides these 31 tools:

| Tool | Description |
|------|-------------|
| `get-position` | Get bot's current position |
| `walk-to` | Move to X,Z coordinates via pathfinding (no teleport) |
| `look-around` | Survey surroundings |
| `get-surface-height` | Find ground level at X,Z |
| `validate-build-site` | Validate footprint is dry buildable land, including gently flattenable terrain |
| `find-build-site` | Find nearest valid dry-land footprint around a target center |
| `claim-build-zone` | Orchestrator-only zone assignment with TTL |
| `release-build-zone` | Orchestrator-only zone release |
| `report-progress` | Add progress event to coordination board |
| `get-my-build-zones` | View the current worker's assigned zones |
| `get-progress-board` | View claims and progress events |
| `plan-village-layout` | Generate compact multi-house grid plans |
| `allocate-village-zones` | Atomically reserve all worker house zones for parallel building |
| `lookup-grabcraft-landmarks` | Search `grabcraft.com` for landmark/building candidates and show template mapping |
| `discover-landmark-candidates` | Rank local landmark candidates for broad cultural prompts |
| `select-landmark-spec` | Select the nearest local landmark template from prompt, preferring GrabCraft-matched templates when relevant |
| `plan-landmark-mission` | Discover, optionally consult `grabcraft.com`, choose, auto-place, and compile a landmark mission in one call |
| `compile-landmark-build-graph` | Build component DAG/tasks/zones/budgets for landmark run |
| `allocate-build-graph-zones` | Atomically pre-claim all graph zones before execution |
| `dispatch-next-task` | Dispatch next ready graph task for a worker |
| `update-task-status` | Update graph task status (`ready`..`repair`) |
| `inspect-build-graph` | Graph KPI and component/worker progress board |
| `repair-build-graph` | Schedule repair tasks with a budget |
| `check-phase-gate` | Legacy relay helper |
| `relay-handoff` | Legacy relay helper |
| `place-block` | Place single block at X,Y,Z |
| `build-decorated-house` | Build decorated flat house with a solid roof, block-by-block on land |
| `fill-region` | Fill volume block-by-block |
| `flatten-area` | Gently flatten terrain with safety limits |
| `simulate-storm-damage` | Apply controlled damage for recovery demos |
| `inspect-house` | Evaluate house defects and quality score |
| `repair-house` | Patch house defects block-by-block |
| `send-chat` | Send chat message |
| `plant-garden` | Create decorative garden block-by-block on land |

---

## Test 1: Basic Connectivity

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Get your current position and use look-around with radius 12.
```

**Expected:**
- `get-position` returns coordinates
- `look-around` returns nearby entities and ground samples

---

## Test 2: Orchestrator Assignment + Progress Board

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Claim a zone with zoneId "test_claim_hank" assignedTo "MinecraftAgent" from x=2 y=60 z=2 to x=8 y=95 z=8.
Then report-progress with taskId "manual-test", zoneId "test_claim_hank", phase "claimed", note "zone assigned to MinecraftAgent".
Then call get-progress-board with taskId "manual-test".
```

**Expected:**
- `claim-build-zone` succeeds
- assignment belongs to `MinecraftAgent`
- claim conflicts are enforced by X/Z footprint (Y range is metadata)
- `get-progress-board` shows the active assignment and event

---

## Test 2b: Terrain Preflight

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Use validate-build-site for x1=2 z1=2 x2=8 z2=8.
Then use find-build-site near centerX=6 centerZ=6 width=7 depth=7 searchRadius=12.
```

**Expected:**
- `validate-build-site` reports VALID/INVALID with flatten recommendation metadata
- `find-build-site` returns a dry land footprint plus suggested claim bounds

---

## Test 3: Worker Reads Assigned Zone + Single Block Placement

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Use get-my-build-zones first and confirm you were assigned test_claim_hank.
Then use get-surface-height at x=5 z=5 and place one glowstone at that surface y.
After that, report-progress taskId "manual-test", zoneId "test_claim_hank", phase "building", note "placed marker".
```

**Expected:**
- `get-my-build-zones` shows `test_claim_hank`
- `place-block` succeeds only because the zone was preassigned by the orchestrator
- Glowstone appears in world
- progress event appears in the board

---

## Test 4: Build House Block-by-Block

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Build a decorated oak house at x=6 z=6 inside your assigned zone.
Then report-progress taskId "manual-test", zoneId "test_claim_hank", phase "completed", note "house done".
```

**Expected:**
- `build-decorated-house` runs with many block placements (not bulk `/fill`)
- house has roof, windows, door, and lanterns
- progress board shows the completed event

---

## Test 5: Overlap Rejection

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Try to claim overlapping zone zoneId "bea_overlap" assignedTo "BuildBeaAgent" from x=4 y=60 z=4 to x=8 y=95 z=8.
```

**Expected:**
- `claim-build-zone` fails with a conflict against `test_claim_hank`

---

## Test 6: Support Zone Assignment + Garden Execution

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Claim a non-overlapping zone "finn_zone_test" assignedTo "ForestFinnAgent" from x=24 y=60 z=24 to x=36 y=95 z=36.
Then report-progress taskId "manual-test", zoneId "finn_zone_test", phase "claimed", note "garden zone assigned".
```

**Expected:**
- support zone assignment succeeds

**Follow-up target agent:** `ForestFinnAgent`

**Prompt:**
```text
Use get-my-build-zones and confirm you were assigned finn_zone_test.
Then flatten-area from x=24 z=24 to x=34 z=34 using grass_block and maxAdjustment=1.
Plant-garden at x=30 z=30 with size=2.
Report-progress taskId "manual-test", zoneId "finn_zone_test", phase "completed".
```

**Expected:**
- assigned zone is visible to ForestFinn
- flatten and garden succeed inside the assigned zone
- flatten only does minor grading
- edits are block-by-block and visually gradual

---

## Test 7: Team Coordination

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Coordinate all workers to build a village while enforcing safe coordination:
- Only you may claim or assign zones
- Workers must use get-my-build-zones before any mutating tool
- Each worker must call report-progress phases building/completed, or blocked if unassigned
- Zones must be non-overlapping
- Any flatten-area call should use maxAdjustment=1 by default, and maxAdjustment=2 only for dry land footprints that need it
- Build 3 decorated houses and one garden
- End with per-worker summary
```

**Expected:**
- all 6 peers delegated in parallel
- orchestrator assigns non-overlapping zones before work starts
- workers read their assignments instead of self-claiming
- progress board shows per-worker phases
- no building overlap

---

## Test 8: Landmark Autonomy (30-Minute Loop)

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Run a landmark autonomy mission from this single prompt:
"Build a medium Arc de Triomphe inspired landmark near x=60 z=40, with a clean stone style."

Required flow:
1) plan-landmark-mission
2) allocate-build-graph-zones
3) dispatch-next-task for each worker in parallel
4) workers execute assigned tool packets and you call update-task-status
5) inspect-build-graph and then repair-build-graph for QA
6) finish with KPIs: component completion %, blocks placed/budget %, ETA, repair backlog
```

**Expected:**
- spec is selected from the local bank without web dependency
- graph is compiled with dependencies and per-task owners
- zone allocation is atomic and conflict-free
- workers execute differentiated component tasks in parallel
- final QA/repair pass runs and KPIs are reported

---

## Validation Commands

Check SAM logs:

```bash
grep -i "claim-build-zone\|get-my-build-zones\|report-progress\|Zone claim conflict\|not fully preassigned\|orchestrator-only\|error" sam.log | tail -80
```

Check Minecraft server logs:

```bash
docker compose logs --no-color --tail=80 mc
```

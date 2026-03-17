# SAM + Minecraft Manual Test Instructions

Use these prompts in the SAM WebUI at `http://127.0.0.1:8000`.

## Available Tools

The MCP server provides these 30 tools:

| Tool | Description |
|------|-------------|
| `get-position` | Get bot's current position |
| `walk-to` | Move to X,Z coordinates via pathfinding (no teleport) |
| `look-around` | Survey surroundings |
| `get-surface-height` | Find ground level at X,Z |
| `validate-build-site` | Validate footprint is flat, dry buildable land |
| `find-build-site` | Find nearest valid footprint around a target center |
| `claim-build-zone` | Claim exclusive build bbox with TTL |
| `release-build-zone` | Release a claimed zone |
| `report-progress` | Add progress event to coordination board |
| `get-progress-board` | View claims and progress events |
| `plan-village-layout` | Generate compact multi-house grid plans |
| `allocate-village-zones` | Atomically reserve all worker house zones for parallel building |
| `select-landmark-spec` | Select the nearest local landmark template from prompt |
| `compile-landmark-build-graph` | Build component DAG/tasks/zones/budgets for landmark run |
| `allocate-build-graph-zones` | Atomically pre-claim all graph zones before execution |
| `dispatch-next-task` | Dispatch next ready graph task for a worker |
| `update-task-status` | Update graph task status (`ready`..`repair`) |
| `inspect-build-graph` | Graph KPI and component/worker progress board |
| `repair-build-graph` | Schedule repair tasks with a budget |
| `check-phase-gate` | Validate relay prerequisite phases |
| `relay-handoff` | Record explicit worker handoffs |
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

## Test 2: Claim + Progress Board

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Claim a zone with zoneId "test_claim_hank" from x=2 y=60 z=2 to x=8 y=95 z=8.
Then report-progress with taskId "manual-test", zoneId "test_claim_hank", phase "claimed", note "zone reserved".
Then call get-progress-board with taskId "manual-test".
```

**Expected:**
- `claim-build-zone` succeeds
- Claim ownership/conflicts are enforced by X/Z footprint (Y range is metadata)
- `report-progress` logs claimed phase
- `get-progress-board` shows active claim + event

---

## Test 2b: Terrain Preflight

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Use validate-build-site for x1=2 z1=2 x2=8 z2=8.
Then use find-build-site near centerX=6 centerZ=6 width=7 depth=7 searchRadius=12.
```

**Expected:**
- `validate-build-site` reports VALID/INVALID with details
- `find-build-site` returns a land footprint and suggested claim coordinates

---

## Test 3: Single Block Placement in Claimed Zone

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Use get-surface-height at x=5 z=5, then place-block one glowstone at that surface y.
After that, report-progress taskId "manual-test", zoneId "test_claim_hank", phase "building", note "placed marker".
```

**Expected:**
- `place-block` succeeds only because zone is claimed
- Glowstone appears in world
- progress event appears in board

---

## Test 4: Build House Block-by-Block

**Target agent:** `MinecraftAgent`

**Prompt:**
```text
Build a decorated oak house at x=6 z=6 inside your claimed zone.
Then report-progress taskId "manual-test", zoneId "test_claim_hank", phase "completed", note "house done".
```

**Expected:**
- `build-decorated-house` runs with many block placements (not bulk `/fill`)
- House has roof/windows/door/lanterns
- progress board shows completed event

---

## Test 5: Overlap Rejection

**Target agent:** `BuildBeaAgent`

**Prompt:**
```text
Try to claim overlapping zone zoneId "bea_overlap" from x=4 y=60 z=4 to x=8 y=95 z=8.
```

**Expected:**
- `claim-build-zone` fails with conflict against `test_claim_hank`

---

## Test 6: Claimed Flatten + Garden

**Target agent:** `ForestFinnAgent`

**Prompt:**
```text
Claim a non-overlapping zone "finn_zone_test" from x=24 y=60 z=24 to x=36 y=95 z=36.
Report-progress taskId "manual-test", zoneId "finn_zone_test", phase "claimed".
Flatten-area from x=24 z=24 to x=34 z=34 using grass_block and maxAdjustment=1.
Plant-garden at x=30 z=30 with size=2.
Report-progress taskId "manual-test", zoneId "finn_zone_test", phase "completed".
```

**Expected:**
- zone claim succeeds
- flatten and garden succeed within claim
- flatten only does minor grading (no aggressive terrain wipe)
- edits are block-by-block and visually gradual

---

## Test 7: Team Coordination

**Target agent:** `OrchestratorAgent`

**Prompt:**
```text
Coordinate all workers to build a village while enforcing safe coordination:
- Each worker must validate terrain (validate-build-site/find-build-site) before claiming
- Each worker must claim-build-zone before any mutating tool
- Each worker must call report-progress phases claimed/building/completed
- Zones must be non-overlapping
- Any flatten-area call must use maxAdjustment=1
- Build 3 decorated houses and one garden
- End with per-worker summary
```

**Expected:**
- all 5 peers delegated in parallel
- each worker claims non-overlapping zones
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
1) select-landmark-spec
2) compile-landmark-build-graph
3) allocate-build-graph-zones
4) dispatch-next-task for each worker in parallel
5) workers execute assigned tool packets and you call update-task-status
6) inspect-build-graph and then repair-build-graph for QA
7) finish with KPIs: component completion %, blocks placed/budget %, ETA, repair backlog
```

**Expected:**
- spec is selected from local bank without web dependency
- graph is compiled with dependencies and per-task owners
- zone allocation is atomic and conflict-free
- workers execute differentiated component tasks in parallel
- final QA/repair pass runs and KPIs are reported

---

## Validation Commands

Check SAM logs:

```bash
grep -i "claim-build-zone\|report-progress\|Zone claim conflict\|not fully reserved\|error" sam.log | tail -80
```

Check Minecraft server logs:

```bash
docker compose logs --no-color --tail=80 mc
```

# Customer Example Prompts

This guide provides example prompts that customers can use to interact with the SAM + Minecraft demo. All examples are designed for the **OrchestratorAgent** which coordinates the worker agents.

## 🏗️ Basic Building Examples

### Simple Village
```
Build a small village with 3 houses near x=100 z=100. 
Use different styles (oak, spruce, birch) and add a garden in the center.
Coordinate all workers to build in parallel.
```

### Planned Village Grid
```
Create a 2x3 village grid centered at x=50 z=50 with oak and spruce houses.
Use allocate-village-zones to reserve all zones upfront, then dispatch workers in parallel.
```

### Village with Plaza
```
Build a village with 4 houses arranged in a square around a central plaza.
First flatten the plaza area, then build houses, then add decorative gardens.
Center at x=0 z=100.
```

## 🏛️ Landmark Autonomy Examples

### Basic Landmark Build (One-Shot)
```
Run a 30-minute landmark autonomy mission:
"Build a medium Eiffel Tower near x=200 z=200 with a stone style."

Use this workflow:
1. select-landmark-spec to pick the template
2. compile-landmark-build-graph to generate tasks
3. allocate-build-graph-zones to reserve all zones atomically
4. Repeatedly dispatch-next-task per worker and update-task-status
5. Finish with inspect-build-graph and repair-build-graph for QA
```

### Cultural Landmarks
```
Build a Japanese pagoda near spawn using landmark autonomy.
Target a 25-minute build with medium scale.
Select the template, compile the graph, allocate zones, then coordinate workers.
```

```
Create a Great Pyramid near x=300 z=300 using the Egypt landmark template.
Use large scale and a sandstone style palette.
Run full autonomy workflow with QA repair at the end.
```

### European Landmarks
```
Build an Arc de Triomphe at x=150 z=150 using the France template.
Use medium scale with stone materials.
Execute the full landmark autonomy pipeline.
```

```
Construct a medieval castle using the European castle template.
Place it at x=400 z=400 with large scale.
Run autonomy mode with parallel workers.
```

## 🎨 Parametric Template Generation

### Generate Custom Tower
```
Generate a new landmark spec from the tower template.
Name: "Crystal Spire"
Culture: "Fantasy"
Parameters: {"height": 50, "tiers": 4, "hasBeacon": true}
Scale: large
Style: "quartz"

Then compile and build it at x=500 z=500.
```

### Generate Custom Temple
```
Create a temple landmark from the temple_template.
Name: "Ancient Shrine"
Culture: "Greece"
Parameters: {"columnCount": 6, "courtyardSize": "medium"}
Scale: medium

Build it at x=250 z=250 with the default style.
```

### Generate Custom Bridge
```
Generate a bridge landmark spec:
Name: "Grand Crossing"
Culture: "Modern"
Template: bridge
Parameters: {"span": 40, "archCount": 3, "hasPillars": true}

Place it at x=100 z=300 connecting two areas.
```

## 🔧 Advanced Coordination Examples

### Relay Build Pattern
```
Build a house using relay handoffs between agents:
1. DesignDora validates the site and claims the zone
2. BuildBea builds the foundation and walls
3. SupplySid adds the roof and decorations
4. ForestFinn adds landscaping

Use check-phase-gate and relay-handoff to coordinate transitions.
Center at x=-50 z=-50.
```

### Parallel Multi-Landmark
```
Run two landmark builds in parallel:
1. Eiffel Tower at x=100 z=100 (MinecraftAgent + BuildBea)
2. Japanese Pagoda at x=300 z=300 (SupplySid + ForestFinn)

Allocate both graphs separately, then interleave dispatch-next-task calls.
Monitor progress with inspect-build-graph for both.
```

### Storm Recovery Demo
```
Build a village with 3 houses at x=200 z=200.
After completion, use simulate-storm-damage on one house.
Then repair it using inspect-house and repair-house.
Report progress at each phase.
```

## 📊 Inspection and Monitoring

### Progress Board Inspection
```
Check the current progress board:
Show all active zone claims and recent progress updates.
Filter by taskId if multiple missions are running.
```

### Build Graph Health Check
```
Inspect the current landmark build graph.
Show completion ratio, worker assignments, blocked tasks, and repair backlog.
Provide component-level and worker-level KPIs.
```

### House Quality Inspection
```
Inspect all houses in the village at x=100 z=100.
For each house, report the quality score and defect count.
If score < 80, schedule repairs.
```

## 🎯 Specific Tool Combinations

### Site Planning Workflow
```
Find the best build site near x=150 z=150:
1. Use validate-build-site to check several candidate footprints
2. Use find-build-site with 7x7 footprint to auto-locate best spot
3. Claim the zone with claim-build-zone
4. Build a house at the validated location
5. Release the zone when complete
```

### Landscaping Project
```
Create a landscaping area at x=0 z=200:
1. Flatten a 20x20 area with gentle grading
2. Plant 3 gardens (small, medium, large) in different spots
3. Add decorative paths between them
4. Use ForestFinn for primary execution
```

### Quality Assurance Loop
```
After building a village:
1. Inspect all structures with inspect-house
2. Identify defects and calculate average score
3. Use repair-house on any structure with score < 90
4. Re-inspect to verify repairs
5. Report final quality metrics
```

## 🎬 Cinematic Building Prompts

### Time-Lapse Village
```
Build a village slowly for cinematic effect:
Use block-by-block placement (default mode) for all structures.
Build 4 houses sequentially with different styles.
Add gardens between houses.
Location: x=0 z=0
```

### Multi-Worker Synchronized Build
```
Build 6 houses simultaneously with all workers:
1. Allocate village zones atomically for all houses
2. Each worker gets exactly one house
3. All start building at the same time
4. Watch the parallel construction
Location: x=-100 z=-100
Grid: 2x3
```

## 🌍 Culture-Specific Builds

### French Quarter
```
Create a French-themed area:
1. Build an Arc de Triomphe as the centerpiece (x=300 z=300)
2. Surround with oak houses in a radial pattern
3. Add gardens and paths
4. Use stone and oak materials throughout
```

### Japanese Garden District
```
Build a Japanese-themed district:
1. Japanese Pagoda as centerpiece (x=400 z=400)
2. Birch houses with subtle gardens
3. Flatten and landscape surrounding area
4. Use natural materials (birch, stone, greenery)
```

### Egyptian Complex
```
Create an Egyptian monument area:
1. Great Pyramid at x=500 z=500 (large scale)
2. Smaller pyramid structures nearby
3. Sandstone paths
4. Desert-themed landscaping
```

## 🔄 Progressive Enhancement

### Start Simple, Grow Complex
```
Phase 1: Build a single oak house at x=50 z=50
Phase 2: Add a garden next to it
Phase 3: Flatten an area for more houses
Phase 4: Build 2 more houses nearby
Phase 5: Upgrade to a full village grid
Phase 6: Add a landmark (small tower) in the center
```

## 💡 Tips for Best Results

1. **Always specify coordinates** - Helps avoid conflicts and controls placement
2. **Use allocate-village-zones or allocate-build-graph-zones** - Prevents claim races
3. **Mention parallel execution** - Triggers multi-worker coordination
4. **Include QA/repair steps** - Ensures quality results
5. **Reference specific tools** - Gives clearer guidance to the orchestrator
6. **Specify styles/scales** - Gets the aesthetic you want
7. **Use progress-board** - Monitor long-running builds
8. **Chain operations logically** - Site prep → Build → Landscape → QA

## 🚀 Quick Reference

| Goal | Recommended Approach |
|------|---------------------|
| Single house | Direct build-decorated-house call |
| Small village (2-4 houses) | Manual coordination with progress tracking |
| Large village (5+ houses) | allocate-village-zones for atomic reservation |
| Landmark (template exists) | Full autonomy pipeline: select → compile → allocate → dispatch → QA |
| Custom landmark | Generate from template → then autonomy pipeline |
| Quality assurance | inspect-house → repair-house loop |
| Terrain prep | validate-build-site → find-build-site → flatten-area |
| Parallel builds | Allocate all zones upfront, then dispatch to workers |

## 📝 Example Session Flow

```
User: "Build a village with landmark"

OrchestratorAgent response:
1. "I'll create a village with 4 houses and an Arc de Triomphe"
2. Calls allocate-village-zones for houses
3. Calls select-landmark-spec for Arc de Triomphe
4. Calls compile-landmark-build-graph
5. Calls allocate-build-graph-zones
6. Dispatches house building to workers
7. Dispatches landmark building in parallel
8. Reports progress periodically
9. Runs QA pass at end
10. "Village complete: 4 houses + landmark, quality score: 92/100"
```

---

**Ready to build?** Pick an example above, customize it for your needs, and send it to the OrchestratorAgent in the WebUI!
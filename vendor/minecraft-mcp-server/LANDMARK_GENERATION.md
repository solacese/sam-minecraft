# Landmark Generation System

The Minecraft MCP Server now includes a powerful landmark generation system that enables AI agents to build complex structures through three mechanisms:

## 1. Pre-Built Landmark Specs (20+ Templates)

The system includes 20+ pre-built landmark specifications for world-famous structures:

### Available Landmarks
- **Towers**: Eiffel Tower (FR), Big Ben (UK), CN Tower (CA), Space Needle (US), Burj Khalifa (AE)
- **Monuments**: Statue of Liberty (US), Christ the Redeemer (BR), Stonehenge (UK)
- **Religious**: Taj Mahal (IN), Japanese Pagoda (JP), Angkor Wat (KH), Parthenon (GR)
- **Historical**: Great Pyramid (EG), Colosseum (IT), Machu Picchu (PE), Petra Treasury (JO), Medieval Castle (EU), Neuschwanstein Castle (DE)
- **Modern**: Sydney Opera House (AU), Golden Gate Bridge (US)

### Usage with `select-landmark-spec`
```javascript
// Example: Select a landmark based on user prompt
{
  tool: "select-landmark-spec",
  params: {
    prompt: "Build me a tall tower with French architecture",
    cultureHint: "france",
    sizeHint: "large"
  }
}
// Returns: Eiffel Tower spec with high match score
```

## 2. Parametric Template Generation

Generate new custom landmarks from 7 parametric templates using the `generate-spec-from-template` tool.

### Available Templates

#### Tower Template
- **Use for**: Spires, bell towers, observation towers, minarets
- **Parameters**: height tiers, observation deck, spire style
- **Scale variants**: small (15m), medium (30m), large (45m)

#### Temple Template  
- **Use for**: Religious buildings, shrines, sanctuaries
- **Parameters**: courtyard, inner sanctum, prayer hall
- **Scale variants**: small (12m), medium (20m), large (30m)

#### Bridge Template
- **Use for**: Arched bridges, suspension bridges, aqueducts
- **Parameters**: span length, arch count, support towers
- **Scale variants**: small (20m), medium (40m), large (60m)

#### Castle Template
- **Use for**: Fortresses, keeps, defensive structures
- **Parameters**: towers, walls, gatehouse, courtyard
- **Scale variants**: small (25m), medium (35m), large (50m)

#### Pyramid Template
- **Use for**: Step pyramids, burial monuments, ziggurats
- **Parameters**: tier count, entrance chamber, peak structure
- **Scale variants**: small (18m), medium (30m), large (45m)

#### Statue Template
- **Use for**: Monuments, sculptures, memorial figures
- **Parameters**: pedestal height, figure pose, torch/object
- **Scale variants**: small (12m), medium (20m), large (35m)

#### Arena Template
- **Use for**: Amphitheaters, stadiums, coliseums
- **Parameters**: seating tiers, arena floor, entrance gates
- **Scale variants**: small (30m), medium (50m), large (75m)

### Culture-Specific Material Palettes

The generator automatically applies culturally-appropriate materials:

- **France**: Stone bricks, iron, quartz details, gray terracotta roofs
- **Egypt**: Sandstone, gold accents, chiseled sandstone
- **Japan**: Dark oak planks, red terracotta, paper details
- **Default**: Stone, cobblestone, iron, white wool

### Usage Example

```javascript
// Generate a custom tower
{
  tool: "generate-spec-from-template",
  params: {
    templateType: "tower",
    name: "Observatory Tower",
    culture: "france",
    scale: "large",
    parameters: {}
  }
}
// Creates: observatory_tower_france_generated.json
// Ready for use with compile-landmark-build-graph
```

## 3. Complete Build Workflow

### Step 1: Select or Generate a Landmark Spec

**Option A: Use existing landmark**
```javascript
{
  tool: "select-landmark-spec",
  params: {
    prompt: "build taj mahal",
    sizeHint: "medium"
  }
}
```

**Option B: Generate from template**
```javascript
{
  tool: "generate-spec-from-template",
  params: {
    templateType: "castle",
    name: "Fortress Keep",
    culture: "default",
    scale: "medium"
  }
}
```

### Step 2: Compile Build Graph
```javascript
{
  tool: "compile-landmark-build-graph",
  params: {
    specId: "taj_mahal_in",  // or generated spec ID
    originX: 100,
    originZ: 200,
    scale: "medium",
    targetDurationMinutes: 30
  }
}
// Returns: graph with task dependencies, zones, block budgets
```

### Step 3: Allocate Zones
```javascript
{
  tool: "allocate-build-graph-zones",
  params: {
    graphId: "landmark_xyz",
    clearExistingForOwners: true,
    ttlSeconds: 1800
  }
}
// Pre-allocates all zones atomically
```

### Step 4: Dispatch Tasks to Workers
```javascript
{
  tool: "dispatch-next-task",
  params: {
    graphId: "landmark_xyz",
    workerId: "BuildBeaAgent"
  }
}
// Returns next ready task with tool + params
```

### Step 5: Update Task Status
```javascript
{
  tool: "update-task-status",
  params: {
    graphId: "landmark_xyz",
    taskId: "foundation",
    status: "done",
    blocksPlaced: 450
  }
}
```

### Step 6: Inspect Progress
```javascript
{
  tool: "inspect-build-graph",
  params: {
    graphId: "landmark_xyz"
  }
}
// Returns: completion %, ETA, role/worker summaries
```

### Step 7: Repair if Needed
```javascript
{
  tool: "repair-build-graph",
  params: {
    graphId: "landmark_xyz",
    budgetBlocks: 600
  }
}
// Schedules repair tasks for failed/blocked nodes
```

## Component Roles & Tools

Each landmark spec consists of components with specific roles:

- **site**: Uses `flatten-area` to prepare ground
- **foundation**: Uses `fill-region` for structural base
- **walls**: Uses `fill-region` for vertical structures  
- **arches**: Uses `fill-region` with specialized patterns
- **roof**: Uses `fill-region` for covering elements
- **ornament**: Uses `place-block` for decorative details
- **landscaping**: Uses `plant-garden` for surroundings
- **utilities**: Uses `fill-region` for functional elements

## Advanced Features

### Parametric Scaling
Prompts with keywords trigger automatic adjustments:
- "grand", "monumental" → 18-28% larger
- "compact", "small" → 18-20% smaller  
- "ornate", "detailed" → 18% more block budget
- "tall", "towering" → 15% taller
- "wide", "spacious" → 12% wider

### Dependency Management
Components declare dependencies ensuring correct build order:
```json
{
  "id": "walls",
  "dependencies": ["foundation"],
  ...
}
```

### Worker Assignment
Components can specify preferred workers or use role-based rotation:
- **site/landscaping**: DesignDoraAgent, ForestFinnAgent
- **foundation/walls**: MinecraftAgent, BuildBeaAgent
- **ornament/utilities**: SupplySidAgent
- **generic**: Rotating pool

### Quality Rules
Specs can include validation rules (extensibility point for future QA):
```json
{
  "qualityRules": [
    "verify_symmetry",
    "check_material_consistency"
  ]
}
```

## Testing

Run the test script to verify the system:

```bash
cd vendor/minecraft-mcp-server
node test-template-generation.js
```

This validates:
- Template loading
- Spec generation
- Cultural material palettes
- Component structure

## File Structure

```
vendor/minecraft-mcp-server/
├── landmark_specs/           # Pre-built landmark specs (20+)
│   ├── eiffel_tower_fr.json
│   ├── taj_mahal_in.json
│   └── ...
├── meta_templates/           # Parametric templates (7)
│   ├── tower_template.json
│   ├── temple_template.json
│   ├── castle_template.json
│   └── ...
├── src/
│   ├── landmark-autonomy.ts  # Build graph orchestration
│   └── template-generator.ts # Template→Spec generation
└── test-template-generation.js
```

## Integration with Main Orchestrator

The main orchestrator can now handle structure requests in three ways:

1. **Direct match**: "build eiffel tower" → use pre-built spec
2. **Template generation**: "build a tall tower" → generate from tower template
3. **AI generation** (future): Use LLM to create fully custom specs

This creates a graceful degradation path from specific to general requests.
#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

SAM_URL="${SAM_URL:-http://127.0.0.1:8000}"
TASK_TIMEOUT="${TASK_TIMEOUT:-300}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-/tmp/sam-house-run-$STAMP}"
mkdir -p "$OUT_DIR"

log() {
  printf '[run-house-team] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

run_step() {
  agent="$1"
  prompt="$2"
  out_file="$3"

  log "Running ${agent}..."
  ./.venv/bin/sam task send \
    --url "$SAM_URL" \
    --agent "$agent" \
    --timeout "$TASK_TIMEOUT" \
    --quiet \
    "$prompt" | tee "$out_file"
  printf '\n' >> "$out_file"
}

require_cmd curl

if ! curl -fsS "$SAM_URL/" >/dev/null 2>&1; then
  echo "SAM WebUI is not reachable at $SAM_URL" >&2
  exit 1
fi

DESIGN_PROMPT='Step 1/5. Validate this tiny-house build spec and return concise coordinates: center anchor is x=0 y=71 z=0, exterior footprint is 3x3, wall height is 3, doorway opening at x=0 z=-1 for y=72 and y=73. Use minimal tool calls and do not ask clarifying questions.'

SUPPLY_PROMPT='Step 2/5. Prepare the tiny-house site at x=0 y=71 z=0 in creative mode. Place marker torches at (-2,71,-2), (2,71,-2), (-2,71,2), and (2,71,2). Confirm at least one marker with get-block-info, then send-chat "Supply ready at 0 71 0". No clarification questions.'

MINECRAFT_PROMPT='Step 3/5. Build foundation and first wall ring for a tiny house centered at x=0 y=71 z=0 using oak_planks:
- Foundation at y=71 for x=-1..1 and z=-1..1 (9 blocks).
- First wall ring at y=72 around perimeter where abs(x)=1 or abs(z)=1, but leave doorway opening at (0,72,-1).
Verify at least three placed coordinates with get-block-info and report exact coordinates completed. Do not ask clarifying questions.'

BUILDBEA_PROMPT='Step 4/5. Complete upper structure for the same tiny house:
- Wall ring at y=73 around perimeter (abs(x)=1 or abs(z)=1), leaving doorway opening at (0,73,-1).
- Wall ring at y=74 around full perimeter.
- Flat roof at y=75 across x=-1..1 and z=-1..1.
Use oak_planks. Verify at least two roof blocks with get-block-info and report exact coordinates.'

FOREST_PROMPT='Step 5/5 finishing pass at the same house:
- Place glass blocks at (-1,73,0) and (1,73,0).
- Place torches inside at (-1,72,0) and (1,72,0).
- If possible, place oak_door at (0,72,-1) and (0,73,-1); if door placement fails, report the exact failure and continue.
Verify all successful placements with get-block-info and send-chat "Team house complete at 0 71 0".'

run_step "DesignDoraAgent" "$DESIGN_PROMPT" "$OUT_DIR/01-design_dora.txt"
run_step "SupplySidAgent" "$SUPPLY_PROMPT" "$OUT_DIR/02-supply_sid.txt"
run_step "MinecraftAgent" "$MINECRAFT_PROMPT" "$OUT_DIR/03-minecraft_agent.txt"
run_step "BuildBeaAgent" "$BUILDBEA_PROMPT" "$OUT_DIR/04-build_bea.txt"
run_step "ForestFinnAgent" "$FOREST_PROMPT" "$OUT_DIR/05-forest_finn.txt"

log "All five worker agents completed. Outputs saved in: $OUT_DIR"

#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

SAM_URL="${SAM_URL:-http://127.0.0.1:8000}"
TASK_TIMEOUT="${TASK_TIMEOUT:-360}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-/tmp/sam-house-parallel-$STAMP}"
mkdir -p "$OUT_DIR"

log() {
  printf '[run-house-team-parallel] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

rcon_best_effort() {
  cmd="$1"
  if ! docker compose exec -T mc rcon-cli "$cmd" >/dev/null 2>&1; then
    log "Warning: failed RCON command: $cmd"
  fi
}

run_async() {
  agent="$1"
  prompt="$2"
  out_file="$3"
  status_file="$4"

  if ./.venv/bin/sam task send \
    --url "$SAM_URL" \
    --agent "$agent" \
    --timeout "$TASK_TIMEOUT" \
    --quiet \
    "$prompt" >"$out_file" 2>&1; then
    echo "ok" >"$status_file"
  else
    echo "failed" >"$status_file"
  fi &
}

require_cmd curl
require_cmd docker

if ! curl -fsS "$SAM_URL/" >/dev/null 2>&1; then
  echo "SAM WebUI is not reachable at $SAM_URL" >&2
  exit 1
fi

log "Preparing a flat shared build arena at x=0 z=0..."
rcon_best_effort "fill -8 70 -8 8 70 8 minecraft:grass_block"
rcon_best_effort "fill -8 71 -8 8 90 8 minecraft:air"
rcon_best_effort "time set day"
rcon_best_effort "weather clear 1000000"
rcon_best_effort "tp HandyHank_l33 0 71 5"
rcon_best_effort "tp DesignDora_l4s 2 71 5"
rcon_best_effort "tp SupplySid_l31 -2 71 5"
rcon_best_effort "tp BuildBea_l33 4 71 5"
rcon_best_effort "tp ForestFinn_q32 -4 71 5"

DESIGN_PROMPT='You are running in PARALLEL BUILD mode. Immediately publish a concise blueprint for a 5x5 house centered at x=0 y=71 z=0 via send-chat, then inspect these checkpoints with get-block-info:
- foundation center (0,71,0)
- west wall midpoint (-2,73,0)
- east wall midpoint (2,73,0)
- roof center (0,75,0)
Return a short status summary with pass/fail per checkpoint.'

SUPPLY_PROMPT='You are running in PARALLEL BUILD mode. Work only on north side and utilities for the shared house centered at x=0 y=71 z=0.
Tasks:
- Build north wall segment at z=-2 for y=72..74 and x=-1..1, leaving doorway openings at (0,72,-2) and (0,73,-2).
- Place marker torches at (-3,71,-3) and (3,71,-3).
- Verify one north-wall block and one torch with get-block-info.
No clarifying questions. Execute now.'

MINECRAFT_PROMPT='You are running in PARALLEL BUILD mode. Work only on foundation + west wall for the shared house centered at x=0 y=71 z=0 using oak_planks.
Tasks:
- Build full 5x5 foundation at y=71 for x=-2..2 and z=-2..2.
- Build west wall at x=-2 for y=72..74 and z=-2..2.
- Verify at least three placed blocks with get-block-info.
No clarifying questions. Execute now.'

BUILDBEA_PROMPT='You are running in PARALLEL BUILD mode. Work only on east wall + roof for the shared house centered at x=0 y=71 z=0 using oak_planks.
Tasks:
- Build east wall at x=2 for y=72..74 and z=-2..2.
- Build flat roof at y=75 for x=-2..2 and z=-2..2.
- Verify two roof blocks and one east-wall block with get-block-info.
No clarifying questions. Execute now.'

FOREST_PROMPT='You are running in PARALLEL BUILD mode. Work only on south wall + finishing for the shared house centered at x=0 y=71 z=0.
Tasks:
- Build south wall at z=2 for y=72..74 and x=-2..2 using oak_planks.
- Place glass blocks at (-1,73,2) and (1,73,2).
- Place torches inside at (-1,72,0) and (1,72,0).
- If possible, place oak_door at doorway coordinates (0,72,-2) and (0,73,-2). If door placement fails, continue and report failure.
- Send-chat: Team parallel house complete at 0 71 0.
Verify at least three finishing coordinates with get-block-info.'

log "Launching all 5 worker agents in parallel..."

run_async "DesignDoraAgent" "$DESIGN_PROMPT" "$OUT_DIR/01-design_dora.txt" "$OUT_DIR/01-design_dora.status"
pid_design=$!
run_async "SupplySidAgent" "$SUPPLY_PROMPT" "$OUT_DIR/02-supply_sid.txt" "$OUT_DIR/02-supply_sid.status"
pid_supply=$!
run_async "MinecraftAgent" "$MINECRAFT_PROMPT" "$OUT_DIR/03-minecraft_agent.txt" "$OUT_DIR/03-minecraft_agent.status"
pid_minecraft=$!
run_async "BuildBeaAgent" "$BUILDBEA_PROMPT" "$OUT_DIR/04-build_bea.txt" "$OUT_DIR/04-build_bea.status"
pid_buildbea=$!
run_async "ForestFinnAgent" "$FOREST_PROMPT" "$OUT_DIR/05-forest_finn.txt" "$OUT_DIR/05-forest_finn.status"
pid_forest=$!

wait "$pid_design"
wait "$pid_supply"
wait "$pid_minecraft"
wait "$pid_buildbea"
wait "$pid_forest"

failed=0
for f in "$OUT_DIR"/*.status; do
  if [ "$(cat "$f")" != "ok" ]; then
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  log "One or more agents failed. Inspect outputs in: $OUT_DIR"
  exit 1
fi

log "Parallel run complete for all 5 worker agents."
log "Outputs saved in: $OUT_DIR"

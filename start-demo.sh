#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"
COORDINATION_DIR="/tmp/sam-minecraft-coordination"
LOCAL_RUNTIME_DB_FILES="orchestrator.db webui_gateway.db platform.db"
LOCAL_RUNTIME_LOG_FILES="sam.log platform_service.log start-demo-runtime.log"

SAM_PID=""
CLEANED_UP=0
RUN_INTERESTING_MISSION="${RUN_INTERESTING_MISSION:-0}"
RUN_PARALLEL_WORKER_MISSION="${RUN_PARALLEL_WORKER_MISSION:-0}"
RUN_STARTUP_SMOKE="${RUN_STARTUP_SMOKE:-0}"
START_WORLD_RESET_MODE="${START_WORLD_RESET_MODE:-auto}"
AGENT_USERS="HandyHank_l33 DesignDora_l4s SupplySid_l31 BuildBea_l33 ForestFinn_q32 MonumentMarc_m9"
BASE_ADMIN_USERS="Noptus noptus raphaelcaillon HandyHank_l33 DesignDora_l4s SupplySid_l31 BuildBea_l33 ForestFinn_q32 MonumentMarc_m9"
SEEDED_USERS=""
WEBUI_PORT=""
WEBUI_URL=""

log() {
  printf '[start-demo] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

patch_sam_peer_tool_prefix() {
  patch_output="$(
    ./.venv/bin/python - <<'PY'
from pathlib import Path
import importlib.util

spec = importlib.util.find_spec("solace_agent_mesh.agent.tools.peer_agent_tool")
if spec is None or spec.origin is None:
    print("peer_tool_patch=missing")
    raise SystemExit(0)

path = Path(spec.origin)
text = path.read_text()
needle = 'PEER_TOOL_PREFIX = "peer_"'
replacement = 'PEER_TOOL_PREFIX = "peer-"'
if replacement in text:
    print(f"peer_tool_patch=ok path={path}")
    raise SystemExit(0)
if needle not in text:
    print(f"peer_tool_patch=skipped path={path}")
    raise SystemExit(0)

path.write_text(text.replace(needle, replacement, 1))
print(f"peer_tool_patch=updated path={path}")
PY
  )"
  log "$patch_output"
}

check_litellm_config() {
  if [ -z "${LITELLM_API_KEY:-}" ]; then
    cat >&2 <<'TXT'
ERROR: LITELLM_API_KEY environment variable is not set.

Please set your LiteLLM API key before running this script:

  export LITELLM_API_KEY="your-litellm-api-key"

Default configuration:
  - API Base: https://lite-llm.mymaas.net
  - Primary models: Sonnet for orchestrator/builders, Haiku for lightweight exterior workers

Then run this script again.
TXT
    exit 1
  fi
  
  model_name="orchestrator/builders=${LITELLM_MODEL_SONNET:-openai/bedrock-claude-4-5-sonnet-tools}, decorators=${LITELLM_MODEL_HAIKU:-openai/bedrock-claude-4-5-haiku-tools}"
  api_base="${LITELLM_API_BASE:-https://lite-llm.mymaas.net}"
  log "LiteLLM configuration verified (model: ${model_name}, api: ${api_base})"
}

ensure_namespace_config() {
  if [ -z "${NAMESPACE:-}" ]; then
    export NAMESPACE="sam_minecraft_demo"
    log "NAMESPACE not set; defaulting to ${NAMESPACE}"
  fi
}

ensure_sam_dev_mode() {
  if [ -z "${SOLACE_DEV_MODE:-}" ]; then
    export SOLACE_DEV_MODE="true"
    log "SOLACE_DEV_MODE not set; defaulting to ${SOLACE_DEV_MODE} for local demo."
  fi
}

ensure_session_secret_key() {
  if [ -z "${SESSION_SECRET_KEY:-}" ]; then
    export SESSION_SECRET_KEY="sam_minecraft_demo_session_secret"
    log "SESSION_SECRET_KEY not set; using a local default for demo startup."
  fi
}

reset_world_for_startup() {
  mode="$(printf '%s' "${START_WORLD_RESET_MODE}" | tr '[:upper:]' '[:lower:]')"

  case "$mode" in
    preserve|none|skip)
      log "Preserving current world volume for startup..."
      ;;
    ""|auto)
      log "Resetting world before startup with a new persisted seed..."
      bash "$ROOT_DIR/reset-world.sh" auto
      ;;
    keep|same)
      log "Resetting world before startup while keeping the current persisted seed..."
      bash "$ROOT_DIR/reset-world.sh"
      ;;
    *)
      log "Resetting world before startup with seed mode '${START_WORLD_RESET_MODE}'..."
      bash "$ROOT_DIR/reset-world.sh" "$START_WORLD_RESET_MODE"
      ;;
  esac
}

clear_coordination_state() {
  log "Clearing scheduler coordination state..."
  rm -rf "$COORDINATION_DIR"
}

clear_runtime_databases() {
  log "Clearing persisted SAM runtime databases..."
  for db_file in $LOCAL_RUNTIME_DB_FILES; do
    rm -f "$ROOT_DIR/$db_file"
  done
}

reset_runtime_logs() {
  log "Resetting runtime logs..."
  for log_file in $LOCAL_RUNTIME_LOG_FILES; do
    : > "$ROOT_DIR/$log_file"
  done
}

terminate_stale_local_processes() {
  log "Terminating stale local launcher/runtime processes..."
  cleanup_output="$(
    python3 - "$$" <<'PY'
import os
import signal
import subprocess
import sys
import time

current_pid = int(sys.argv[1])
patterns = [
    "./.venv/bin/sam run configs/",
    "vendor/minecraft-mcp-server/dist/main.js --host localhost --port 25565 --username ",
    "npm run grabcraft:place --input ",
    "tsx src/grabcraft-place.ts --input ",
]

try:
    ps_output = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
except subprocess.CalledProcessError as exc:
    print(f"stale_process_cleanup=error detail={exc}")
    raise SystemExit(0)

victims = []
for raw_line in ps_output.splitlines():
    line = raw_line.strip()
    if not line:
        continue
    parts = line.split(None, 1)
    if len(parts) != 2:
        continue
    pid = int(parts[0])
    cmd = parts[1]
    if pid == current_pid:
        continue
    if any(pattern in cmd for pattern in patterns):
        victims.append((pid, cmd))

for pid, _ in victims:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

deadline = time.time() + 5.0
survivors = victims
while survivors and time.time() < deadline:
    remaining = []
    for pid, cmd in survivors:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        remaining.append((pid, cmd))
    survivors = remaining
    if survivors:
        time.sleep(0.2)

for pid, _ in survivors:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

if victims:
    print(
        "stale_process_cleanup=ok "
        f"terminated={len(victims)} "
        f"pids={','.join(str(pid) for pid, _ in victims)}"
    )
else:
    print("stale_process_cleanup=ok terminated=0")
PY
  )"
  log "$cleanup_output"
}

wait_for_stale_launcher_exit() {
  log "Waiting for stale launcher shells to exit..."
  wait_output="$(
    python3 - "$$" <<'PY'
import subprocess
import sys
import time

current_pid = int(sys.argv[1])
patterns = [
    "sh ./start-demo.sh",
    "bash ./start-demo.sh",
    "zsh ./start-demo.sh",
]

deadline = time.time() + 8.0
remaining = []
while time.time() < deadline:
    ps_output = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
    remaining = []
    for raw_line in ps_output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        pid = int(parts[0])
        cmd = parts[1]
        if pid == current_pid:
            continue
        if any(pattern in cmd for pattern in patterns):
          remaining.append(str(pid))
    if not remaining:
        print("stale_launcher_wait=ok remaining=0")
        raise SystemExit(0)
    time.sleep(0.25)

print(f"stale_launcher_wait=timeout remaining={','.join(remaining)}")
PY
  )"
  log "$wait_output"
}

port_available() {
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
      return 1
    fi
  fi

  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

pick_webui_port() {
  preferred_port="${FASTAPI_PORT:-8000}"
  platform_port="${PLATFORM_API_PORT:-8001}"

  if [ "$preferred_port" != "$platform_port" ] && port_available "$preferred_port"; then
    WEBUI_PORT="$preferred_port"
    return 0
  fi

  port="$preferred_port"
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    port=$((port + 1))
    if [ "$port" != "$platform_port" ] && port_available "$port"; then
      WEBUI_PORT="$port"
      return 0
    fi
    attempts=$((attempts + 1))
  done

  echo "No free WebUI port found starting from ${preferred_port}." >&2
  exit 1
}

ensure_webui_port_config() {
  requested_port="${FASTAPI_PORT:-8000}"
  pick_webui_port

  export FASTAPI_PORT="$WEBUI_PORT"
  export WEBUI_ORIGIN="${WEBUI_ORIGIN:-http://127.0.0.1:${WEBUI_PORT}}"
  export WEBUI_ORIGIN_ALT="${WEBUI_ORIGIN_ALT:-http://localhost:${WEBUI_PORT}}"
  WEBUI_URL="http://127.0.0.1:${WEBUI_PORT}"

  if [ "$WEBUI_PORT" != "$requested_port" ]; then
    log "Port ${requested_port} is busy; using WebUI port ${WEBUI_PORT} instead."
  else
    log "Using WebUI port ${WEBUI_PORT}."
  fi
}

minecraft_dns_failure_detected() {
  mc_logs="$(docker compose logs --no-color --tail=200 mc 2>/dev/null || true)"
  printf '%s' "$mc_logs" | grep -Eq "Failed to resolve 'launchermeta\\.mojang\\.com'|Network is unreachable|resolve-minecraft-version' command failed"
}

show_minecraft_dns_help() {
  cat >&2 <<'TXT'
Minecraft container could not resolve Mojang metadata hostnames.
Detected DNS/network failure while resolving launchermeta.mojang.com.

Try these steps, then rerun start-demo.sh:
1) Restart Docker Desktop.
2) Ensure your host has outbound internet access.
3) If you use VPN/firewall, allow Docker DNS/UDP egress.
4) Retry: docker compose rm -sf mc && docker compose up -d mc
TXT
}

run_rcon_cmd() {
  docker compose exec -T mc rcon-cli "$1" >/dev/null
}

run_rcon_cmd_best_effort() {
  if ! run_rcon_cmd "$1"; then
    log "Warning: failed to run RCON command: $1"
  fi
}

get_log_line_count() {
  if [ -f sam.log ]; then
    wc -l < sam.log | tr -d ' '
    return 0
  fi

  echo "0"
}

log_contains_since() {
  start_line="$1"
  pattern="$2"

  [ -f sam.log ] || return 1
  awk -v s="$start_line" 'NR > s' sam.log | grep -Eq "$pattern"
}

extract_delegated_peers_from_log() {
  mission_task_id="$1"
  start_line="$2"

  [ -f sam.log ] || return 0

  awk -v s="$start_line" -v task="$mission_task_id" '
    NR <= s { next }
    index($0, "RetriggerManager:" task) {
      line = $0
      while (match(line, /peer[-_][A-Za-z0-9_]+/)) {
        print substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
      }
    }
  ' sam.log | sort -u | tr '\n' ' '
}

rcon_list_players() {
  docker compose exec -T mc rcon-cli "list" 2>/dev/null | tr -d '\r' || true
}

get_online_players() {
  list_output="$(rcon_list_players)"
  players_csv="$(printf '%s\n' "$list_output" | awk -F': ' 'NF>1 {print $2}')"

  if [ -z "$players_csv" ]; then
    return 0
  fi

  printf '%s\n' "$players_csv" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sed '/^$/d'
}

wait_for_agent_users_online() {
  log "Waiting for agent bots to join Minecraft..."
  i=0
  missing_players=""

  while [ "$i" -lt 90 ]; do
    online_names="$(get_online_players | tr '\n' ' ')"
    missing_players=""

    for player in $AGENT_USERS; do
      case " $online_names " in
        *" $player "*)
          ;;
        *)
          missing_players="$missing_players $player"
          ;;
      esac
    done

    if [ -z "$missing_players" ]; then
      log "All agent bots are online."
      return 0
    fi

    if [ -n "$SAM_PID" ] && ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
      log "SAM process exited while waiting for bot joins. See sam.log."
      return 1
    fi

    sleep 2
    i=$((i + 1))
  done

  log "Continuing with partial agent presence. Missing:$missing_players"
}

op_user() {
  run_rcon_cmd_best_effort "op $1"
}

grant_build_kit_to_user() {
  user="$1"
  run_rcon_cmd_best_effort "give $user minecraft:oak_planks 128"
  run_rcon_cmd_best_effort "give $user minecraft:stone 128"
  run_rcon_cmd_best_effort "give $user minecraft:glass 64"
  run_rcon_cmd_best_effort "give $user minecraft:oak_door 4"
  run_rcon_cmd_best_effort "give $user minecraft:torch 32"
}

spread_user_on_surface() {
  # Spread agents within 5 blocks of each other (min 1, max 5)
  run_rcon_cmd_best_effort "spreadplayers 0 0 1 5 false $1"
}

is_user_seeded() {
  case " $SEEDED_USERS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

mark_user_seeded() {
  if ! is_user_seeded "$1"; then
    SEEDED_USERS="$SEEDED_USERS $1"
  fi
}

bootstrap_user_defaults() {
  user="$1"
  [ -z "$user" ] && return 0

  op_user "$user"
  run_rcon_cmd_best_effort "gamemode creative $user"

  if ! is_user_seeded "$user"; then
    grant_build_kit_to_user "$user"
    mark_user_seeded "$user"
  fi
}

reconcile_online_users() {
  for user in $(get_online_players); do
    bootstrap_user_defaults "$user"
  done
}

wait_for_agent_cards() {
  log "Waiting for SAM agent discovery..."
  i=0
  while [ "$i" -lt 45 ]; do
    cards_json="$(curl -fsS "${WEBUI_URL}/api/v1/agentCards" 2>/dev/null || true)"
    if [ -n "$cards_json" ] &&
      printf '%s' "$cards_json" | grep -q '"name":"OrchestratorAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"MinecraftAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"DesignDoraAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"SupplySidAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"BuildBeaAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"ForestFinnAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"MonumentMarcAgent"'; then
      log "Agent discovery is ready."
      return 0
    fi

    if [ -n "$SAM_PID" ] && ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
      log "SAM process exited while waiting for agent discovery. See sam.log."
      return 1
    fi

    sleep 2
    i=$((i + 1))
  done

  log "Continuing even though full agent discovery was not confirmed."
}

apply_ideal_demo_conditions() {
  log "Applying ideal demo conditions (ops, inventory kits, and spawn spread)..."

  for user in $BASE_ADMIN_USERS; do
    bootstrap_user_defaults "$user"
  done

  run_rcon_cmd_best_effort "gamemode creative @a"

  for user in $AGENT_USERS; do
    spread_user_on_surface "$user"
    bootstrap_user_defaults "$user"
  done

  reconcile_online_users
}

worker_nudge_prompt() {
  case "$1" in
    DesignDoraAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, flatten-area inside it with material="grass_block" and use maxAdjustment=2 only if the zone is still dry land and needs it, otherwise use 1. Then place only ground markers: flowers/torches at surface level and gravel path blocks on ground layer (no roofs/walls/air). Then report-progress phase="completed" and send-chat with final footprint coordinates.
EOF
      ;;
    SupplySidAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, report-progress with taskId="manual-nudge", zoneId equal to your assigned zone id, phase="building", note="working assigned structure zone", then use build-decorated-house centered inside the assigned footprint with style="birch". Then report-progress phase="completed" and send-chat.
EOF
      ;;
    MinecraftAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, report-progress with taskId="manual-nudge", zoneId equal to your assigned zone id, phase="building", note="working assigned structure zone", then use build-decorated-house centered inside the assigned footprint with style="oak". Then report-progress phase="completed" and send-chat.
EOF
      ;;
    BuildBeaAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, report-progress with taskId="manual-nudge", zoneId equal to your assigned zone id, phase="building", note="working assigned structure zone", then use build-decorated-house centered inside the assigned footprint with style="spruce". Then report-progress phase="completed" and send-chat.
EOF
      ;;
    ForestFinnAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, report-progress with taskId="manual-nudge", zoneId equal to your assigned zone id, phase="building", note="working assigned garden zone", then use plant-garden centered inside the assigned footprint with size=3. Then report-progress phase="completed" and send-chat.
EOF
      ;;
    MonumentMarcAgent)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with taskId="manual-nudge", zoneId="unassigned", phase="blocked", note="need orchestrator assignment", then send-chat asking OrchestratorAgent for a zone and stop. If a zone is assigned, walk to that zone, report-progress with taskId="manual-nudge", zoneId equal to your assigned zone id, phase="building", note="working assigned monument shard zone", then use fill-region inside the assigned footprint with material="minecraft:stone_bricks". Then report-progress phase="completed" and send-chat.
EOF
      ;;
    *)
      cat <<'EOF'
Use get-my-build-zones first. If no zone is assigned to you, report-progress with phase="blocked" and ask OrchestratorAgent for an assignment. If a zone is assigned, work only inside that zone, then report-progress phase="completed" and send-chat.
EOF
      ;;
  esac
}

run_worker_nudge() {
  agent="$1"
  reason="${2:-Missing mission activity}"
  prompt="$(worker_nudge_prompt "$agent")"
  nudge_output_file="$(mktemp)"

  log "${reason} for ${agent}; running direct worker nudge..."
  if ! ./.venv/bin/sam task send \
    --url "${WEBUI_URL}" \
    --agent "$agent" \
    --timeout 300 \
    --quiet \
    "$prompt" >"$nudge_output_file" 2>&1; then
    cat "$nudge_output_file"
    rm -f "$nudge_output_file"
    log "Warning: direct worker nudge failed for ${agent}."
    return 0
  fi

  cat "$nudge_output_file"
  rm -f "$nudge_output_file"
}

worker_has_required_activity_since() {
  agent="$1"
  start_line="$2"

  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: report-progress" || return 1
  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (get-position|walk-to|get-surface-height)" || return 1
  if ! log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (get-my-build-zones|get-progress-board)"; then
    return 1
  fi
  if ! log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (validate-build-site|find-build-site|get-my-build-zones|get-progress-board)"; then
    return 1
  fi
  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (place-block|fill-region|flatten-area|build-decorated-house|plant-garden)" || return 1
  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: send-chat" || return 1
}

ensure_worker_activity_since() {
  start_line="$1"

  for agent in DesignDoraAgent SupplySidAgent MinecraftAgent BuildBeaAgent ForestFinnAgent MonumentMarcAgent; do
    if worker_has_required_activity_since "$agent" "$start_line"; then
      log "${agent} activity confirmed (reservation check + progress + world action + send-chat)."
      continue
    fi

    run_worker_nudge "$agent" "No complete reservation/progress/world-action/send-chat signature detected"
  done
}

zone_conflict_detected_since() {
  start_line="$1"
  log_contains_since "$start_line" "Zone claim conflict|Operation overlaps zone|not fully reserved|not fully preassigned|orchestrator-only"
}

run_reassignment_wave() {
  reason="$1"
  reassignment_output_file="$(mktemp)"
  reassignment_prompt_file="$(mktemp)"
  cat >"$reassignment_prompt_file" <<EOF
A worker reported a zone reservation conflict: ${reason}

Run exactly one reassignment wave now:
1) Re-plan only the conflicting worker(s) to new non-overlapping coordinates.
2) Only OrchestratorAgent may assign the replacement zone, using allocate-village-zones or claim-build-zone assignedTo="<worker>".
3) Reassigned workers must use get-my-build-zones before mutating tools and then report-progress with phases "reassigned" and "completed".
4) Do not restart the entire mission. Continue from current state and finish.
EOF

  reassignment_prompt="$(cat "$reassignment_prompt_file")"
  rm -f "$reassignment_prompt_file"

  log "Running single reassignment wave for reservation conflicts..."
  if ! ./.venv/bin/sam task send \
    --url "${WEBUI_URL}" \
    --agent OrchestratorAgent \
    --timeout 420 \
    --quiet \
    "$reassignment_prompt" >"$reassignment_output_file" 2>&1; then
    cat "$reassignment_output_file"
    rm -f "$reassignment_output_file"
    log "Warning: reassignment wave failed."
    return 0
  fi

  cat "$reassignment_output_file"
  rm -f "$reassignment_output_file"
}

run_orchestrated_interest_mission() {
  mission_log_start_line="$(get_log_line_count)"
  mission_prompt_file="$(mktemp)"
  cat >"$mission_prompt_file" <<'EOF'
Execute a beautiful village building mission now.

Requirements:
- FIRST call allocate-village-zones ONCE to reserve all house zones atomically before any worker starts.
- Use center near X=32, Z=32 with rows=2 cols=2 houseCount=4 houseWidth=7 houseDepth=7 bufferBlocks=2.
- Use buildersCsv="MinecraftAgent,BuildBeaAgent,SupplySidAgent,MonumentMarcAgent" and stylesCsv="oak,spruce,birch,stone".
- Set clearExistingForOwners=true so stale claims do not block this run.
- Then assign support zones yourself with orchestrator-only claims:
  - claim-build-zone zoneId="design_plaza" assignedTo="DesignDoraAgent"
  - claim-build-zone zoneId="finn_garden" assignedTo="ForestFinnAgent"
- Then call ALL 6 peer agents IN PARALLEL in your first delegation response: peer-DesignDoraAgent, peer-SupplySidAgent, peer-MinecraftAgent, peer-BuildBeaAgent, peer-ForestFinnAgent, peer-MonumentMarcAgent.
- Mission: Build a beautiful village with decorated houses and gardens.
- All workers MUST report progress phases using report-progress.

Agent assignments:
- MinecraftAgent / BuildBea / SupplySid / MonumentMarc: each receives one allocated house or support structure zone from allocate-village-zones.
  - walk-to assigned center
  - use get-my-build-zones to confirm assigned zone + bbox
  - report-progress phase="building"
  - build-decorated-house using assigned style at assigned center
  - report-progress phase="completed"
  - send-chat summary
- DesignDora: use a separate nearby zone for plaza prep and grounded markers only.
  - use get-my-build-zones, walk to the assigned support zone, flatten-area on dry land (prefer maxAdjustment=1, use 2 only when terrain delta requires it)
  - place flowers/torches on surface and path blocks on ground layer
  - report-progress completed and send-chat
- ForestFinn: use a nearby non-overlapping garden zone.
  - use get-my-build-zones, walk to the assigned support zone
  - plant-garden size=3, report-progress completed, send-chat

Every worker must:
1. First use walk-to
2. Confirm assigned zone on get-my-build-zones
3. Then report-progress taskId="<mission task id or village-mission>" phase="building"
4. Then perform building tool(s) strictly inside assigned zone
   - never place blocks in mid-air; decorations must be grounded
5. If flatten-area is used, prefer maxAdjustment=1; use maxAdjustment=2 only for dry land footprints that need gentle grading
6. Then report-progress phase="completed"
7. Finally send-chat summary

If allocation fails, retry allocate-village-zones once with bufferBlocks=3. If any worker still hits a reservation conflict, reassign only that worker once with an orchestrator-owned zone update and continue.
Execute delegations NOW. Return final summary with zone IDs and coordinates.
EOF
  mission_prompt="$(cat "$mission_prompt_file")"
  rm -f "$mission_prompt_file"

  log "Running orchestrated team mission..."
  mission_output_file="$(mktemp)"
  if ! ./.venv/bin/sam task send \
    --url "${WEBUI_URL}" \
    --agent OrchestratorAgent \
    --timeout 600 \
    --quiet \
    "$mission_prompt" >"$mission_output_file" 2>&1; then
    cat "$mission_output_file"
    rm -f "$mission_output_file"
    log "Warning: orchestrated mission failed; continuing runtime."
    return 0
  fi

  cat "$mission_output_file"
  mission_task_id="$(sed -n 's/^Task ID: //p' "$mission_output_file" | head -n 1 | tr -d '\r')"
  mission_output_dir="$(sed -n 's/^Output directory: //p' "$mission_output_file" | head -n 1 | tr -d '\r')"
  rm -f "$mission_output_file"

  delegated_peers=""
  if [ -n "$mission_task_id" ]; then
    delegated_peers="$(extract_delegated_peers_from_log "$mission_task_id" "$mission_log_start_line")"
  fi

  if [ -n "$mission_task_id" ]; then
    if command -v rg >/dev/null 2>&1; then
      delegated=0
      if rg -q "RetriggerManager:${mission_task_id}" sam.log; then
        delegated=1
      fi
    else
      delegated=0
      if grep -q "RetriggerManager:${mission_task_id}" sam.log; then
        delegated=1
      fi
    fi

    if [ "$delegated" -ne 1 ]; then
      log "Warning: orchestrator task completed without confirmed peer delegation."
    fi
  fi

  if [ -n "$delegated_peers" ]; then
    log "Orchestrator delegated peers:$delegated_peers"
  fi

  for agent in DesignDoraAgent SupplySidAgent MinecraftAgent BuildBeaAgent ForestFinnAgent MonumentMarcAgent; do
    peer_name="peer-${agent}"
    case " $delegated_peers " in
      *" $peer_name "*)
        ;;
      *)
        run_worker_nudge "$agent" "No orchestrator delegation observed"
        ;;
    esac
  done

  ensure_worker_activity_since "$mission_log_start_line"

  if zone_conflict_detected_since "$mission_log_start_line"; then
    run_reassignment_wave "Reservation conflict detected in mission logs"
    ensure_worker_activity_since "$mission_log_start_line"
  fi

  if [ -n "$mission_output_dir" ] && [ -f "$mission_output_dir/sse_events.yaml" ]; then
    log "Mission events saved at: $mission_output_dir"
  fi
}

run_parallel_worker_mission() {
  log "Running explicit parallel worker mission..."
  if ! sh "$ROOT_DIR/run-house-team-parallel.sh"; then
    log "Warning: parallel worker mission reported a failure; continuing runtime."
  fi
}

apply_world_stability_profile() {
  log "Applying stable world profile (creative + peaceful + static day)..."

  rcon_ready=0
  i=0
  while [ "$i" -lt 30 ]; do
    if run_rcon_cmd "list" >/dev/null 2>&1; then
      rcon_ready=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done

  if [ "$rcon_ready" -ne 1 ]; then
    echo "RCON did not become ready; cannot enforce world stability settings." >&2
    exit 1
  fi

  for cmd in \
    "difficulty peaceful" \
    "defaultgamemode creative" \
    "gamemode creative @a" \
    "time set day" \
    "gamerule doDaylightCycle false" \
    "gamerule doWeatherCycle false" \
    "weather clear 1000000"
  do
    if ! run_rcon_cmd "$cmd"; then
      echo "Failed to apply world setting via RCON: $cmd" >&2
      exit 1
    fi
  done
}

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1

  log "Shutting down services..."

  if [ -n "$SAM_PID" ] && kill -0 "$SAM_PID" >/dev/null 2>&1; then
    kill "$SAM_PID" >/dev/null 2>&1 || true

    i=0
    while [ "$i" -lt 25 ]; do
      if ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
      i=$((i + 1))
    done

    if kill -0 "$SAM_PID" >/dev/null 2>&1; then
      kill -9 "$SAM_PID" >/dev/null 2>&1 || true
    fi

    wait "$SAM_PID" >/dev/null 2>&1 || true
  fi

  docker compose stop --timeout 20 mc >/dev/null 2>&1 || true
  log "Shutdown complete."
}

trap cleanup EXIT
trap 'exit 130' INT TERM

log "Checking prerequisites..."
require_cmd docker
require_cmd node
require_cmd npm
require_cmd python3
require_cmd curl

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required but not available." >&2
  exit 1
fi

node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if(maj<20||(maj===20&&min<10)){process.exit(1)}' || {
  echo "Node.js >= 20.10.0 is required." >&2
  exit 1
}

# Check LiteLLM configuration
check_litellm_config
ensure_namespace_config
ensure_sam_dev_mode
ensure_session_secret_key
ensure_webui_port_config
terminate_stale_local_processes
wait_for_stale_launcher_exit
reset_world_for_startup
clear_coordination_state
clear_runtime_databases
reset_runtime_logs

if [ ! -d .venv ]; then
  log "Creating Python virtual environment in .venv..."
  python3 -m venv .venv
fi

log "Installing Python dependencies..."
./.venv/bin/pip install -r requirements.txt >/dev/null
patch_sam_peer_tool_prefix

log "Installing and building local Minecraft MCP server..."
(
  cd vendor/minecraft-mcp-server
  npm ci >/dev/null 2>&1 || true
  npm run build >/dev/null 2>&1 || true
)

log "Starting Minecraft server container..."
if ! docker compose ps --status running mc 2>/dev/null | grep -q "mc"; then
  if ! port_available 25565; then
    echo "Port 25565 is already in use. Stop the conflicting service and retry." >&2
    exit 1
  fi
fi
docker compose up -d mc >/dev/null

log "Waiting for Minecraft server readiness..."
READY=0
i=0
while [ "$i" -lt 90 ]; do
  mc_logs="$(docker compose logs --no-color --tail=200 mc 2>/dev/null || true)"
  if printf '%s' "$mc_logs" | grep -q "Done ("; then
    READY=1
    break
  fi
  if minecraft_dns_failure_detected; then
    show_minecraft_dns_help
    exit 1
  fi
  if ! docker compose ps --status running mc 2>/dev/null | grep -q "mc"; then
    echo "Minecraft container is not running. Check: docker compose logs --no-color mc" >&2
    exit 1
  fi
  sleep 2
  i=$((i + 1))
done

if [ "$READY" -ne 1 ]; then
  echo "Minecraft server did not become ready in time." >&2
  exit 1
fi

apply_world_stability_profile

log "Starting SAM runtime..."
if ! port_available "$WEBUI_PORT"; then
  echo "Port ${WEBUI_PORT} is already in use. Stop the conflicting service and retry." >&2
  exit 1
fi
./.venv/bin/sam run configs/ >> sam.log 2>&1 &
SAM_PID=$!

log "Waiting for SAM WebUI on ${WEBUI_URL} ..."
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "${WEBUI_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
    echo "SAM process exited early. See sam.log." >&2
    exit 1
  fi
  i=$((i + 1))
done

if ! curl -fsS "${WEBUI_URL}/" >/dev/null 2>&1; then
  echo "SAM WebUI did not become reachable in time." >&2
  exit 1
fi

wait_for_agent_users_online
apply_ideal_demo_conditions
wait_for_agent_cards

if [ "$RUN_STARTUP_SMOKE" = "1" ]; then
  log "Running smoke instruction against MinecraftAgent..."
  ./.venv/bin/sam task send \
    --url "${WEBUI_URL}" \
    --agent MinecraftAgent \
    --timeout 300 \
    --quiet \
    "Run startup checks: use get-position to find your location, use get-surface-height to find ground level, then use send-chat to say 'HandyHank_l33 startup smoke test successful'."

  log "Smoke test complete."
else
  log "Skipping startup smoke task (RUN_STARTUP_SMOKE=0)."
fi

if [ "$RUN_INTERESTING_MISSION" = "1" ]; then
  run_orchestrated_interest_mission
else
  log "Skipping auto mission start (RUN_INTERESTING_MISSION=0)."
fi

if [ "$RUN_PARALLEL_WORKER_MISSION" = "1" ]; then
  run_parallel_worker_mission
else
  log "Skipping parallel worker mission (RUN_PARALLEL_WORKER_MISSION=0)."
fi

log "Manual test instructions: $ROOT_DIR/docs/test-instructions.md"
log "Web UI: ${WEBUI_URL}"
log "Minecraft: localhost:25565"
log "Press Ctrl+C to stop SAM and the Minecraft container."

reconcile_ticks=0
while true; do
  if ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
    echo "SAM process exited. See sam.log." >&2
    exit 1
  fi

  if [ "$reconcile_ticks" -ge 15 ]; then
    reconcile_online_users
    reconcile_ticks=0
  fi

  sleep 1
  reconcile_ticks=$((reconcile_ticks + 1))
done

ti #!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

SAM_PID=""
CLEANED_UP=0
RUN_INTERESTING_MISSION="${RUN_INTERESTING_MISSION:-1}"
RUN_PARALLEL_WORKER_MISSION="${RUN_PARALLEL_WORKER_MISSION:-0}"
AGENT_USERS="HandyHank_l33 DesignDora_l4s SupplySid_l31 BuildBea_l33 ForestFinn_q32"
BASE_ADMIN_USERS="Noptus noptus raphaelcaillon HandyHank_l33 DesignDora_l4s SupplySid_l31 BuildBea_l33 ForestFinn_q32"
SEEDED_USERS=""

log() {
  printf '[start-demo] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

check_litellm_config() {
  if [ -z "${LITELLM_API_KEY:-}" ]; then
    cat >&2 <<'TXT'
ERROR: LITELLM_API_KEY environment variable is not set.

Please set your LiteLLM API key before running this script:

  export LITELLM_API_KEY="your-litellm-api-key"

Default configuration:
  - API Base: https://lite-llm.mymaas.net
  - Model: bedrock-claude-4-5-sonnet

Then run this script again.
TXT
    exit 1
  fi
  
  model_name="${LITELLM_MODEL:-openai/bedrock-claude-4-5-sonnet}"
  api_base="${LITELLM_API_BASE:-https://lite-llm.mymaas.net}"
  log "LiteLLM configuration verified (model: ${model_name}, api: ${api_base})"
}

port_available() {
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
      while (match(line, /peer_[A-Za-z0-9_]+/)) {
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
    cards_json="$(curl -fsS http://127.0.0.1:8000/api/v1/agentCards 2>/dev/null || true)"
    if [ -n "$cards_json" ] &&
      printf '%s' "$cards_json" | grep -q '"name":"OrchestratorAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"MinecraftAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"DesignDoraAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"SupplySidAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"BuildBeaAgent"' &&
      printf '%s' "$cards_json" | grep -q '"name":"ForestFinnAgent"'; then
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
Use walk-to to go to coordinates (20, 20), then use flatten-area to prepare a 20x20 building site, then use send-chat to report completion.
EOF
      ;;
    SupplySidAgent)
      cat <<'EOF'
Use walk-to to go to coordinates (20, 35), then use build-decorated-house with style='birch' to build a house, then use send-chat to report completion.
EOF
      ;;
    MinecraftAgent)
      cat <<'EOF'
Use walk-to to go to coordinates (25, 25), then use build-decorated-house with style='oak' to build a house, then use send-chat to report completion.
EOF
      ;;
    BuildBeaAgent)
      cat <<'EOF'
Use walk-to to go to coordinates (35, 20), then use build-decorated-house with style='spruce' to build a house, then use send-chat to report completion.
EOF
      ;;
    ForestFinnAgent)
      cat <<'EOF'
Use walk-to to go to coordinates (30, 30), then use plant-garden with size=3 to create a garden, then use send-chat to report completion.
EOF
      ;;
    *)
      cat <<'EOF'
Use get-position to find your location, then use build-decorated-house or plant-garden to create something beautiful, then use send-chat to report.
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
    --url http://127.0.0.1:8000 \
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

  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (get-position|walk-to|get-surface-height)" || return 1
  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: (place-block|fill-region|flatten-area|build-decorated-house|plant-garden)" || return 1
  log_contains_since "$start_line" "AgentID: ${agent}, ToolName: send-chat" || return 1
}

ensure_worker_activity_since() {
  start_line="$1"

  for agent in DesignDoraAgent SupplySidAgent MinecraftAgent BuildBeaAgent ForestFinnAgent; do
    if worker_has_required_activity_since "$agent" "$start_line"; then
      log "${agent} activity confirmed (read-chat + world action + send-chat)."
      continue
    fi

    run_worker_nudge "$agent" "No complete read-chat/world-action/send-chat signature detected"
  done
}

run_orchestrated_interest_mission() {
  mission_log_start_line="$(get_log_line_count)"
  mission_prompt_file="$(mktemp)"
  cat >"$mission_prompt_file" <<'EOF'
Execute a beautiful village building mission now.

Requirements:
- Call ALL 5 peer agents IN PARALLEL in your first response: peer_DesignDoraAgent, peer_SupplySidAgent, peer_MinecraftAgent, peer_BuildBeaAgent, peer_ForestFinnAgent.
- Pick a central location (e.g., X=20, Z=20) for the village.
- Mission: Build a beautiful village with decorated houses and gardens.

Agent assignments:
- DesignDora: Use walk-to to go to (20, 20), then use flatten-area to prepare a 30x30 building site
- MinecraftAgent: Use walk-to to go to (25, 25), then use build-decorated-house with style='oak' to build the main house
- BuildBea: Use walk-to to go to (35, 20), then use build-decorated-house with style='spruce' to build a second house
- SupplySid: Use walk-to to go to (20, 35), then use build-decorated-house with style='birch' to build a third house
- ForestFinn: Use walk-to to go to (30, 30), then use plant-garden with size=3 to create a central garden

Every worker must:
1. First use walk-to to move to their assigned location
2. Then use get-surface-height to find ground level
3. Then perform their building task
4. Finally use send-chat to report completion

Execute delegations NOW. Return final summary with coordinates.
EOF
  mission_prompt="$(cat "$mission_prompt_file")"
  rm -f "$mission_prompt_file"

  log "Running orchestrated team mission..."
  mission_output_file="$(mktemp)"
  if ! ./.venv/bin/sam task send \
    --url http://127.0.0.1:8000 \
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

  for agent in DesignDoraAgent SupplySidAgent MinecraftAgent BuildBeaAgent ForestFinnAgent; do
    peer_name="peer_${agent}"
    case " $delegated_peers " in
      *" $peer_name "*)
        ;;
      *)
        run_worker_nudge "$agent" "No orchestrator delegation observed"
        ;;
    esac
  done

  ensure_worker_activity_since "$mission_log_start_line"

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

if [ ! -d .venv ]; then
  log "Creating Python virtual environment in .venv..."
  python3 -m venv .venv
fi

log "Installing Python dependencies..."
./.venv/bin/pip install -r requirements.txt >/dev/null

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
if ! port_available 8000; then
  echo "Port 8000 is already in use. Stop the conflicting service and retry." >&2
  exit 1
fi
./.venv/bin/sam run configs/ >> sam.log 2>&1 &
SAM_PID=$!

log "Waiting for SAM WebUI on http://127.0.0.1:8000 ..."
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS http://127.0.0.1:8000/ >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if ! kill -0 "$SAM_PID" >/dev/null 2>&1; then
    echo "SAM process exited early. See sam.log." >&2
    exit 1
  fi
  i=$((i + 1))
done

if ! curl -fsS http://127.0.0.1:8000/ >/dev/null 2>&1; then
  echo "SAM WebUI did not become reachable in time." >&2
  exit 1
fi

wait_for_agent_users_online
apply_ideal_demo_conditions
wait_for_agent_cards

log "Running smoke instruction against MinecraftAgent..."
./.venv/bin/sam task send \
  --url http://127.0.0.1:8000 \
  --agent MinecraftAgent \
  --timeout 300 \
  --quiet \
  "Run startup checks: use get-position to find your location, use get-surface-height to find ground level, then use send-chat to say 'HandyHank_l33 startup smoke test successful'."

log "Smoke test complete."

if [ "$RUN_INTERESTING_MISSION" = "1" ]; then
  run_orchestrated_interest_mission
fi

if [ "$RUN_PARALLEL_WORKER_MISSION" = "1" ]; then
  run_parallel_worker_mission
fi

log "Manual test instructions: $ROOT_DIR/docs/test-instructions.md"
log "Web UI: http://127.0.0.1:8000"
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
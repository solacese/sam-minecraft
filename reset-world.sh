#!/bin/bash
# reset-world.sh - Reset the Minecraft world (delete world data and optionally change seed)
#
# Usage:
#   ./reset-world.sh              # Reset with same seed
#   ./reset-world.sh 12345        # Reset with specific numeric seed
#   ./reset-world.sh auto         # Generate and persist a new 64-bit seed

set -e

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"
SEED_INPUT="${1:-}"
COMPOSE_FILE="docker-compose.yml"
COORDINATION_DIR="/tmp/sam-minecraft-coordination"
LOCAL_RUNTIME_DB_FILES="orchestrator.db webui_gateway.db platform.db"
LOCAL_RUNTIME_LOG_FILES="sam.log platform_service.log start-demo-runtime.log"

echo "🔄 Resetting Minecraft world..."

# Stop the server if running
echo "⏹️  Stopping Minecraft server..."
docker compose down 2>/dev/null || true

# Delete the world data volume
echo "🗑️  Deleting world data..."
docker volume rm sam-minecraft_mc-data 2>/dev/null || true

# Clear reservation/progress state so a fresh world also has a fresh scheduler state.
echo "🧹 Clearing coordination state..."
rm -rf "$COORDINATION_DIR"

echo "🧹 Clearing persisted SAM state..."
for db_file in $LOCAL_RUNTIME_DB_FILES; do
    rm -f "$ROOT_DIR/$db_file"
done
for log_file in $LOCAL_RUNTIME_LOG_FILES; do
    : > "$ROOT_DIR/$log_file"
done

# Handle seed change
if [ -n "$SEED_INPUT" ]; then
    if [ "$SEED_INPUT" = "auto" ]; then
        # Generate a new unsigned 64-bit seed and persist it.
        NEW_SEED="$(python3 - <<'PY'
import random
print(random.randint(0, 2**63 - 1))
PY
)"
        echo "🎲 Generated new seed: $NEW_SEED"
    else
        if ! printf '%s' "$SEED_INPUT" | grep -Eq '^[0-9]+$'; then
            echo "❌ Invalid seed: '$SEED_INPUT'"
            echo "Use either:"
            echo "  ./reset-world.sh"
            echo "  ./reset-world.sh auto"
            echo "  ./reset-world.sh <numeric-seed>"
            exit 1
        fi
        NEW_SEED="$SEED_INPUT"
        echo "🌱 Using seed: $NEW_SEED"
    fi

    # Update docker-compose.yml with new seed
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/SEED: \"[^\"]*\"/SEED: \"$NEW_SEED\"/" "$COMPOSE_FILE"
    else
        # Linux
        sed -i "s/SEED: \"[^\"]*\"/SEED: \"$NEW_SEED\"/" "$COMPOSE_FILE"
    fi
    echo "✅ Updated seed in docker-compose.yml: $NEW_SEED"
else
    echo "🌱 Keeping existing seed"
fi

echo ""
echo "✅ World reset complete!"
echo ""
echo "To start fresh, run:"
echo "  ./start-demo.sh"

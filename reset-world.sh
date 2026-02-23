#!/bin/bash
# reset-world.sh - Reset the Minecraft world (delete world data and optionally change seed)
#
# Usage:
#   ./reset-world.sh              # Reset with same seed
#   ./reset-world.sh 12345        # Reset with new seed
#   ./reset-world.sh random       # Reset with random seed

set -e

SEED="${1:-}"
COMPOSE_FILE="docker-compose.yml"

echo "🔄 Resetting Minecraft world..."

# Stop the server if running
echo "⏹️  Stopping Minecraft server..."
docker compose down 2>/dev/null || true

# Delete the world data volume
echo "🗑️  Deleting world data..."
docker volume rm sam-minecraft_mc-data 2>/dev/null || true

# Handle seed change
if [ -n "$SEED" ]; then
    if [ "$SEED" = "random" ]; then
        # Generate random seed
        NEW_SEED=$((RANDOM * RANDOM))
        echo "🎲 Using random seed: $NEW_SEED"
    else
        NEW_SEED="$SEED"
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
    echo "✅ Updated seed in docker-compose.yml"
else
    echo "🌱 Keeping existing seed"
fi

echo ""
echo "✅ World reset complete!"
echo ""
echo "To start fresh, run:"
echo "  ./start-demo.sh"
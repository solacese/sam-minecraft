# Solace Agent Mesh + Minecraft Demo

**Seven AI agents collaborate in real-time to build landmarks and villages in Minecraft.**

Built on [Solace Agent Mesh (SAM)](https://github.com/SolaceLabs/solace-agent-mesh), this demo showcases multi-agent orchestration, parallel task execution, and autonomous build planning, all through natural language.

> _"Build the Eiffel Tower at x=100 z=100, medium scale"_ and watch seven agents coordinate to make it happen.

---

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| **Docker** | Latest | [docker.com/get-started](https://www.docker.com/get-started/) |
| **Node.js** | >= 20.10 | [nodejs.org](https://nodejs.org/) |
| **Python** | >= 3.10 | [python.org](https://www.python.org/) |
| **LiteLLM API Key** | — | Access to Claude models via your LiteLLM proxy |

---

## Get Started

```bash
# 1. Clone and enter the repo
git clone <this-repo-url> && cd sam-minecraft

# 2. Set your API key
export LITELLM_API_KEY="sk-..."

# 3. Launch everything
./start-demo.sh

# 4. Open the WebUI (URL printed in terminal, usually http://127.0.0.1:8000)
# 5. Pick a prompt below and send it to OrchestratorAgent
```

That's it. The script handles Minecraft server, Python venv, Node dependencies, MCP build, and agent startup.

> **Note:** The demo includes its own Minecraft server via Docker — you do NOT need to own Minecraft.
> A Minecraft Java Edition client is optional for visual spectating only. All agent interaction happens through the WebUI at port 8000.

---

## Try These Prompts

Copy-paste any of these into the WebUI chat with **OrchestratorAgent**:

### Quick Win (~2 min)

```
Build a small village with 4 houses near x=50 z=50.
Use oak, spruce, birch, and stone styles. Add a garden in the center.
```

### Landmark Build (~5 min)

```
Build the Eiffel Tower at x=100 z=100, medium scale, iron classic style.
```

```
Build the Taj Mahal at x=200 z=200, medium scale.
```

```
Build the Great Wall of China at x=100 z=300, large scale with watchtowers.
```

### World Tour (~15 min)

```
Build three landmarks side by side:
1. Great Pyramid of Giza at x=0 z=0, small scale
2. Colosseum at x=80 z=0, small scale
3. Japanese Pagoda at x=160 z=0, small scale
```

### Cinematic Village + Landmark

```
Build a French quarter: an Arc de Triomphe at x=300 z=300 as the centerpiece,
surrounded by 4 oak houses in a grid with gardens and paths.
```

### Storm Recovery Demo

```
Build a village with 3 houses at x=200 z=200.
After completion, simulate storm damage on one house, then repair it.
Report quality scores before and after.
```

---

## 32 Prebuilt Landmarks — 20+ Countries

Every landmark below is a ready-to-go template. Just name it in a prompt.

### Europe
| Landmark | Country | Prompt Example |
|----------|---------|---------------|
| Eiffel Tower | France | _"Build the Eiffel Tower at x=100 z=100"_ |
| Arc de Triomphe | France | _"Build an Arc de Triomphe near spawn"_ |
| Colosseum | Italy | _"Build the Colosseum at x=200 z=200, large scale"_ |
| Leaning Tower of Pisa | Italy | _"Build the Tower of Pisa at x=50 z=50"_ |
| Big Ben | UK | _"Build Big Ben at x=300 z=300"_ |
| Stonehenge | UK | _"Build Stonehenge near x=0 z=200"_ |
| La Sagrada Familia | Spain | _"Build La Sagrada Familia at x=400 z=400"_ |
| Saint Basil's Cathedral | Russia | _"Build Saint Basil's Cathedral at x=100 z=200"_ |
| Neuschwanstein Castle | Germany | _"Build Neuschwanstein Castle at x=300 z=0"_ |
| Parthenon | Greece | _"Build the Parthenon at x=200 z=100"_ |
| Amsterdam Canal House | Netherlands | _"Build a Dutch canal house near spawn"_ |
| Dutch Windmill | Netherlands | _"Build a windmill at x=50 z=150"_ |
| Medieval Castle | Europe | _"Build a medieval castle at x=400 z=400, large scale"_ |

### Asia
| Landmark | Country | Prompt Example |
|----------|---------|---------------|
| Great Wall of China | China | _"Build the Great Wall at x=0 z=300, large scale"_ |
| Taj Mahal | India | _"Build the Taj Mahal at x=200 z=200"_ |
| Japanese Pagoda | Japan | _"Build a Japanese pagoda near spawn"_ |
| Angkor Wat | Cambodia | _"Build Angkor Wat at x=300 z=300"_ |
| Hagia Sophia | Turkey | _"Build the Hagia Sophia at x=100 z=400"_ |
| Gyeongbokgung Palace | South Korea | _"Build Gyeongbokgung Palace at x=200 z=0"_ |
| Wat Arun | Thailand | _"Build Wat Arun at x=400 z=200"_ |
| Burj Khalifa | UAE | _"Build the Burj Khalifa at x=0 z=0, large scale"_ |

### Americas
| Landmark | Country | Prompt Example |
|----------|---------|---------------|
| Statue of Liberty | USA | _"Build the Statue of Liberty at x=100 z=100"_ |
| Chrysler Building | USA | _"Build the Chrysler Building at x=200 z=0"_ |
| Space Needle | USA | _"Build the Space Needle at x=300 z=100"_ |
| Golden Gate Bridge | USA | _"Build the Golden Gate Bridge at x=0 z=200"_ |
| CN Tower | Canada | _"Build the CN Tower at x=100 z=300"_ |
| Chichen Itza | Mexico | _"Build Chichen Itza at x=200 z=200"_ |
| Christ the Redeemer | Brazil | _"Build Christ the Redeemer at x=0 z=100"_ |
| Machu Picchu | Peru | _"Build Machu Picchu at x=300 z=300"_ |

### Africa, Middle East & Oceania
| Landmark | Country | Prompt Example |
|----------|---------|---------------|
| Great Pyramid of Giza | Egypt | _"Build the Great Pyramid at x=0 z=0, large scale"_ |
| Petra Treasury | Jordan | _"Build the Petra Treasury at x=200 z=400"_ |
| Sydney Opera House | Australia | _"Build the Sydney Opera House at x=100 z=0"_ |

---

## The Agent Team

| Agent | Model | Role |
|-------|-------|------|
| **OrchestratorAgent** | Sonnet | Coordinates all workers, manages zones and task graphs |
| **MinecraftAgent** (Handy Hank) | Sonnet | Primary structure builder |
| **BuildBeaAgent** (Build Bea) | Sonnet | Framing, walls, and roofing |
| **SupplySidAgent** (Supply Sid) | Sonnet | Finishing details, arches, windows |
| **MonumentMarcAgent** (Monument Marc) | Sonnet | Monument masonry and GrabCraft shards |
| **DesignDoraAgent** (Design Dora) | Haiku | Site planning and terrain prep |
| **ForestFinnAgent** (Forest Finn) | Haiku | Landscaping, gardens, and cleanup |

The orchestrator plans the work, claims build zones, and dispatches tasks in parallel. Workers execute their assigned packets and report back. No worker can build outside its assigned zone — collisions are impossible by design.

---

## How Landmark Builds Work

```
User prompt
    |
    v
plan-landmark-mission          — match prompt to a landmark template
    |
    v
allocate-build-graph-zones     — reserve all zones atomically
    |
    v
dispatch-next-task (x6)        — assign ready tasks to available workers
    |
    v
update-task-status             — workers report completion
    |                            (dependent tasks unlock automatically)
    v
inspect + repair-build-graph   — QA pass and fix any defects
```

Each landmark template defines 8-14 components with dependency chains, material palettes, and scale variants (small / medium / large). The orchestrator compiles these into a task graph and dispatches work across all six agents in parallel.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_API_KEY` | _(required)_ | Your LiteLLM API key |
| `LITELLM_API_BASE` | `https://lite-llm.mymaas.net` | LiteLLM proxy URL |
| `LITELLM_MODEL` | `openai/bedrock-claude-4-5-haiku-tools` | Model identifier |
| `START_WORLD_RESET_MODE` | `auto` | `auto` = new seed, `keep` = preserve world, `same` = same seed, or a number |

---

## Stopping and Resetting

```bash
# Stop everything
Ctrl+C

# Reset with a fresh world
./reset-world.sh auto

# Reset with a specific seed
./reset-world.sh 12345
```

---

## Project Structure

```
sam-minecraft/
├── start-demo.sh                     # One-command launcher
├── reset-world.sh                    # World reset utility
├── docker-compose.yml                # Minecraft server (vanilla 1.21.4, creative)
├── configs/
│   ├── shared_config.yaml            # Broker, models, services
│   ├── services/platform.yaml        # SAM platform config
│   └── agents/                       # 7 agent YAML configs
├── vendor/minecraft-mcp-server/      # MCP server (TypeScript)
│   ├── src/                          # 33 tools, GrabCraft integration, autonomy engine
│   ├── landmark_specs/               # 32 landmark templates (20+ countries)
│   └── tests/                        # Test suite
├── tools/                            # Supplementary Python utilities
└── CUSTOMER_EXAMPLES.md              # Extended prompt cookbook
```

---

## Troubleshooting

**"LITELLM_API_KEY environment variable is not set"** — `export LITELLM_API_KEY="sk-..."`

**Docker permission denied (Linux)**
```bash
sudo usermod -aG docker $USER
# Log out and back in (or run: newgrp docker)
```

**"Port 25565 doesn't work in my browser"**
- Port 25565 is Minecraft's game protocol, not HTTP — it won't open in Chrome.
- The **WebUI** is at `http://127.0.0.1:8000` — that's where you send prompts and watch progress.
- To spectate visually in-game, open **Minecraft Java Edition** (v1.21.4) → Multiplayer → `localhost:25565`.
- A Minecraft client is entirely optional — the demo works fully through the WebUI.

**Slow first startup** — First run downloads the Minecraft server image (~800MB). Subsequent starts are fast.

**Docker DNS issues** — Restart Docker Desktop. Check VPN/firewall.

**Port conflicts** — `lsof -i :25565` or `lsof -i :8000` to find conflicts.

**MCP build fails** — `cd vendor/minecraft-mcp-server && npm ci && npm run build`

---

## License

MIT

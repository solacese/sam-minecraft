# SAM Minecraft Museum One-Pager

## Quick Links

| Resource | Address |
|---|---|
| Museum website | `https://raphael-solace.github.io/sam-minecraft-museum/` |
| Agent chat | In-game on the Minecraft server |
| Minecraft Java server | `ec2-16-54-209-252.ca-central-1.compute.amazonaws.com:25565` |
| Request a new model | Use the request form on the museum website |

The current AWS Elastic IP is `16.54.209.252`.

## What This Is

SAM Minecraft Museum is a live demonstration of multiple AI agents coordinating to build complex structures in Minecraft. Visitors can watch recordings, join the persistent Minecraft world, chat with museum guide agents, watch landmarks continuously dissolve and rebuild block by block, and request future landmarks.

The important idea is not just that blocks appear in Minecraft. The demo shows an agent team coordinating specialized roles: an orchestrator, site planner, structural builder, landmark specialist, materials specialist, and landscaper. The activity stream makes the teamwork visible while trusted build tools keep the world controlled. The hosted museum runs in a normal non-flat world, with landmark exhibits grounded into the terrain and animated by a rate-limited builder loop.

## Current Featured Builds

- Munich Famous Building
- Eiffel Tower
- Sydney Opera House
- Arc de Triomphe
- Saint Basil's Cathedral
- NY Chrysler Building

## 90-Second Talk Track

“This is the SAM Minecraft Museum, a persistent world where AI agents collaborate to create complex landmarks. A visitor can ask for a structure, like a famous building in Munich, and the orchestrator breaks the work into visible agent activity. In the live museum, the existing landmark row is kinetic: the same six OTS models repeatedly dissolve from the top down and rebuild from the ground up, block by block.

Each agent has a role. One agent reviews the site and visitor flow, another watches structure and staging, another checks landmark fidelity, another handles materials and finishing, and another thinks about landscaping. For public safety, normal visitors talk to read-only guide agents. Actual world mutation is handled by a trusted build runner so the museum stays durable, rate-limited, and recoverable.

The museum has two ways to experience the demo. First, anyone can open the website and watch short recordings of interesting builds. Second, people with Minecraft Java Edition can join the live server and tour the museum world directly. The request form lets visitors propose new landmarks, which go into a queue for review or approved build runs.

This gives us a repeatable way to show multi-agent coordination: planning, delegation, progress updates, controlled execution, and a finished artifact people can walk around in.”

## How To Join

1. Open Minecraft Java Edition 1.21.4.
2. Go to Multiplayer.
3. Add server: `ec2-16-54-209-252.ca-central-1.compute.amazonaws.com:25565`.
4. Join the world and start at the museum spawn.
5. Watch the landmark row cycle through dissolve and rebuild phases, then use the museum website for recordings and requests.

## Safety Model

Public visitors can chat, tour, request, and currently join in creative mode for filming and hands-on exploration. Reviewed build requests are still queued and rate-limited for coordinated agent demos. The live museum loop only edits known OTS landmark block coordinates; paths, terrain, markers, spawn, and agents are outside the animation scope. The live museum world should have snapshots so it can be restored if a build fails.

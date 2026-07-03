#!/usr/bin/env python3
"""Seed the public SAM Minecraft Museum world with deterministic landmark exhibits."""

from __future__ import annotations

import argparse
import json
import pathlib
import struct
import subprocess
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
FALLBACK_BASE_Y = 68
MIN_WORLD_Y = -64
MAX_PROBE_Y = 319
MAX_BUILD_BASE_Y = 88
FOUNDATION_DEPTH = 24
MAX_FILL_VOLUME = 32768

GRAVITY_REPLACEMENTS = {
    "minecraft:white_concrete_powder": "minecraft:white_concrete",
    "minecraft:orange_concrete_powder": "minecraft:orange_concrete",
    "minecraft:magenta_concrete_powder": "minecraft:magenta_concrete",
    "minecraft:light_blue_concrete_powder": "minecraft:light_blue_concrete",
    "minecraft:yellow_concrete_powder": "minecraft:yellow_concrete",
    "minecraft:lime_concrete_powder": "minecraft:lime_concrete",
    "minecraft:pink_concrete_powder": "minecraft:pink_concrete",
    "minecraft:gray_concrete_powder": "minecraft:gray_concrete",
    "minecraft:light_gray_concrete_powder": "minecraft:light_gray_concrete",
    "minecraft:cyan_concrete_powder": "minecraft:cyan_concrete",
    "minecraft:purple_concrete_powder": "minecraft:purple_concrete",
    "minecraft:blue_concrete_powder": "minecraft:blue_concrete",
    "minecraft:brown_concrete_powder": "minecraft:brown_concrete",
    "minecraft:green_concrete_powder": "minecraft:green_concrete",
    "minecraft:red_concrete_powder": "minecraft:red_concrete",
    "minecraft:black_concrete_powder": "minecraft:black_concrete",
    "minecraft:sand": "minecraft:sandstone",
    "minecraft:red_sand": "minecraft:red_sandstone",
    "minecraft:gravel": "minecraft:stone",
}


@dataclass(frozen=True)
class Block:
    x: int
    y: int
    z: int
    state: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed the public SAM Minecraft Museum world.")
    parser.add_argument("--compose-file", default="docker-compose.museum.yml")
    parser.add_argument("--batch-size", type=int, default=180)
    parser.add_argument("--skip-ots", action="store_true")
    parser.add_argument("--skip-specs", action="store_true")
    return parser.parse_args()


def run_rcon(commands: Iterable[str], compose_file: str, batch_size: int = 180) -> None:
    batch: list[str] = []
    for command in commands:
      batch.append(command)
      if len(batch) >= batch_size:
          send_batch(batch, compose_file)
          batch = []
    if batch:
        send_batch(batch, compose_file)


def send_batch(commands: list[str], compose_file: str) -> None:
    rcon_capture(commands, compose_file)


def rcon_capture(commands: list[str], compose_file: str) -> str:
    completed = subprocess.run(
        ["docker", "compose", "-f", compose_file, "exec", "-T", "mc", "rcon-cli"],
        cwd=REPO_ROOT,
        input="\n".join(commands) + "\n",
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "rcon-cli failed")
    return completed.stdout


def rcon_lines(stdout: str) -> list[str]:
    lines: list[str] = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if line.startswith(">"):
            line = line[1:].strip()
        if line:
            lines.append(line)
    return lines


def wait_for_server(compose_file: str) -> None:
    for _ in range(90):
        completed = subprocess.run(
            ["docker", "compose", "-f", compose_file, "exec", "-T", "mc", "rcon-cli", "list"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
        )
        if completed.returncode == 0 and "players online" in completed.stdout:
            return
        time.sleep(2)
    raise TimeoutError("Minecraft server did not become ready for RCON.")


def fill_commands(x1: int, y1: int, z1: int, x2: int, y2: int, z2: int, block: str) -> list[str]:
    min_x, max_x = sorted((x1, x2))
    min_y, max_y = sorted((y1, y2))
    min_z, max_z = sorted((z1, z2))
    commands: list[str] = []
    for y in range(min_y, max_y + 1):
        volume = (max_x - min_x + 1) * (max_z - min_z + 1)
        if volume <= MAX_FILL_VOLUME:
            commands.append(f"fill {min_x} {y} {min_z} {max_x} {y} {max_z} {block}")
            continue
        for z in range(min_z, max_z + 1):
            commands.append(f"fill {min_x} {y} {z} {max_x} {y} {z} {block}")
    return commands


def ground_probe_command(x: int, y: int, z: int) -> str:
    return f"execute if block {x} {y} {z} minecraft:air"


def find_ground_y(x: int, z: int, compose_file: str) -> int:
    probe_ys = list(range(MAX_PROBE_Y, MIN_WORLD_Y - 1, -1))
    stdout = rcon_capture([ground_probe_command(x, y, z) for y in probe_ys], compose_file)
    for y, line in zip(probe_ys, rcon_lines(stdout)):
        if "Test failed" in line:
            return y
    print(f"WARNING: could not find terrain at {x},{z}; falling back to Y {FALLBACK_BASE_Y - 1}", flush=True)
    return FALLBACK_BASE_Y - 1


def find_site_base_y(center_x: int, center_z: int, radius: int, compose_file: str) -> int:
    x1, x2 = center_x - radius, center_x + radius
    z1, z2 = center_z - radius, center_z + radius
    rcon_capture([f"forceload add {x1} {z1} {x2} {z2}"], compose_file)
    time.sleep(1)
    offset = max(12, min(32, radius // 3))
    samples = [
        (center_x, center_z),
        (center_x - offset, center_z),
        (center_x + offset, center_z),
        (center_x, center_z - offset),
        (center_x, center_z + offset),
    ]
    ground_ys = sorted(find_ground_y(x, z, compose_file) for x, z in samples)
    terrain_y = ground_ys[len(ground_ys) // 2]
    raw_base_y = terrain_y + 1
    base_y = min(raw_base_y, MAX_BUILD_BASE_Y)
    terrace_note = "" if base_y == raw_base_y else f"; terraced down from Y {raw_base_y}"
    print(f"Site {center_x},{center_z}: terrain samples {ground_ys}; building base Y {base_y}{terrace_note}", flush=True)
    return base_y


def prepare_plot(center_x: int, center_z: int, radius: int, base_y: int, top_y: int | None = None) -> list[str]:
    x1, x2 = center_x - radius, center_x + radius
    z1, z2 = center_z - radius, center_z + radius
    surface_y = base_y - 1
    clear_top_y = top_y if top_y is not None else min(319, base_y + 180)
    foundation_bottom_y = max(MIN_WORLD_Y, base_y - FOUNDATION_DEPTH)
    commands = [f"forceload add {x1} {z1} {x2} {z2}"]
    for y in range(base_y, clear_top_y + 1):
        commands.extend(fill_commands(x1, y, z1, x2, y, z2, "air"))
    commands.extend(fill_commands(x1, foundation_bottom_y, z1, x2, base_y - 4, z2, "stone"))
    commands.extend(fill_commands(x1, base_y - 3, z1, x2, base_y - 2, z2, "dirt"))
    commands.extend(fill_commands(x1, surface_y, z1, x2, surface_y, z2, "grass_block"))
    commands.append(f"forceload remove {x1} {z1} {x2} {z2}")
    return commands


def load_ots_blocks(path: pathlib.Path) -> list[Block]:
    raw = path.read_bytes()
    if len(raw) < 15 or raw[:10] != b"OTS_BLOCKS":
        raise ValueError(f"{path.name} is not a valid .ots_blocks file")
    if raw[10] != 2:
        raise ValueError(f"{path.name} has unsupported OTS version {raw[10]}")
    offset = 11
    palette_count = struct.unpack_from("<I", raw, offset)[0]
    offset += 4
    palette: dict[int, str] = {}
    for _ in range(palette_count):
        block_id = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        state_len = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        state = raw[offset:offset + state_len].decode("utf-8")
        offset += state_len
        palette[block_id] = GRAVITY_REPLACEMENTS.get(state, state)
    count = struct.unpack_from("<I", raw, offset)[0]
    offset += 4
    blocks: list[Block] = []
    for x, y, z, block_id in struct.iter_unpack("<iiii", raw[offset:offset + count * 16]):
        blocks.append(Block(x, y, z, palette[block_id]))
    return blocks


def place_ots(path: pathlib.Path, center_x: int, center_z: int, title: str, base_y: int) -> list[str]:
    blocks = load_ots_blocks(path)
    min_x, max_x = min(b.x for b in blocks), max(b.x for b in blocks)
    min_y = min(b.y for b in blocks)
    min_z, max_z = min(b.z for b in blocks), max(b.z for b in blocks)
    width = max_x - min_x + 1
    depth = max_z - min_z + 1
    origin_x = center_x - width // 2
    origin_z = center_z - depth // 2
    world_blocks = [
        Block(origin_x + b.x - min_x, base_y + b.y - min_y, origin_z + b.z - min_z, b.state)
        for b in blocks
        if b.state != "minecraft:air"
    ]
    commands = [f"say Seeding {title} with {len(world_blocks)} blocks"]
    commands.extend(commands_for_runs(world_blocks))
    return commands


def commands_for_runs(blocks: list[Block]) -> list[str]:
    commands: list[str] = []
    grouped: dict[tuple[int, int, str], list[int]] = defaultdict(list)
    for block in blocks:
        grouped[(block.y, block.z, block.state)].append(block.x)
    for (y, z, state), xs in sorted(grouped.items()):
        xs = sorted(set(xs))
        start = end = xs[0]
        for x in xs[1:]:
            if x == end + 1:
                end = x
                continue
            commands.append(run_command(start, end, y, z, state))
            start = end = x
        commands.append(run_command(start, end, y, z, state))
    return commands


def run_command(x1: int, x2: int, y: int, z: int, state: str) -> str:
    if x1 == x2:
        return f"setblock {x1} {y} {z} {state}"
    return f"fill {x1} {y} {z} {x2} {y} {z} {state}"


def load_spec(spec_id: str) -> dict:
    return json.loads((REPO_ROOT / "vendor/minecraft-mcp-server/landmark_specs" / f"{spec_id}.json").read_text())


def material(spec: dict, key: str | None) -> str:
    style = spec["styles"][spec["defaultStyle"]]
    return style.get(key or "primary", style["primary"])


def seed_spec(spec_id: str, center_x: int, center_z: int, base_y: int, scale: str = "medium") -> list[str]:
    spec = load_spec(spec_id)
    scale_config = spec.get("scaleVariants", {}).get(scale, {"footprintScale": 1.0, "heightScale": 1.0})
    footprint_scale = float(scale_config.get("footprintScale", 1.0))
    height_scale = float(scale_config.get("heightScale", 1.0))
    surface_y = base_y - 1
    commands = [f"say Seeding {spec['name']}"]
    for component in spec["components"]:
        width = max(1, round(component["width"] * footprint_scale))
        depth = max(1, round(component["depth"] * footprint_scale))
        height = max(1, round(component["height"] * height_scale))
        cx = center_x + round(component["offsetX"] * footprint_scale)
        cz = center_z + round(component["offsetZ"] * footprint_scale)
        y = base_y + round(component["offsetY"] * height_scale)
        x1 = cx - width // 2
        z1 = cz - depth // 2
        x2 = x1 + width - 1
        z2 = z1 + depth - 1
        block = material(spec, component.get("materialKey"))
        tool = component["primaryTool"]
        if tool == "flatten-area":
            commands.extend(fill_commands(x1, surface_y, z1, x2, surface_y, z2, material(spec, "path")))
        elif tool == "plant-garden":
            commands.extend(garden_commands(cx, cz, int(component.get("gardenSize", 2)), base_y))
        elif tool == "place-block":
            commands.append(f"setblock {cx} {y} {cz} {block}")
        elif tool == "build-decorated-house":
            commands.extend(fill_commands(x1, y, z1, x2, y + max(2, height - 1), z2, block))
        else:
            start_y = y - 1 if component.get("materialKey") == "path" or component.get("role") == "foundation" else y
            commands.extend(fill_commands(x1, start_y, z1, x2, start_y + height - 1, z2, block))
    return commands


def garden_commands(cx: int, cz: int, size: int, base_y: int) -> list[str]:
    radius = max(3, size * 3)
    surface_y = base_y - 1
    commands = fill_commands(cx - radius, surface_y, cz - radius, cx + radius, surface_y, cz + radius, "grass_block")
    for x in range(cx - radius + 1, cx + radius, 2):
        commands.append(f"setblock {x} {base_y} {cz - radius + 1} poppy")
        commands.append(f"setblock {x} {base_y} {cz + radius - 1} dandelion")
    return commands


def paths_and_spawn(spawn_base_y: int) -> list[str]:
    surface_y = spawn_base_y - 1
    commands: list[str] = []
    commands.extend(fill_commands(-18, spawn_base_y - 8, -126, 18, spawn_base_y - 4, -92, "stone"))
    commands.extend(fill_commands(-18, spawn_base_y - 3, -126, 18, spawn_base_y - 2, -92, "dirt"))
    commands.extend(fill_commands(-18, surface_y, -126, 18, surface_y, -92, "polished_andesite"))
    commands.extend([
        "gamerule doMobSpawning false",
        "gamerule doDaylightCycle false",
        "gamerule doWeatherCycle false",
        "difficulty peaceful",
        "time set day",
        "weather clear 1000000",
        "defaultgamemode adventure",
        "gamemode adventure @a",
        f"setworldspawn 0 {spawn_base_y} -108",
        f"spawnpoint @a 0 {spawn_base_y} -108",
        f"tp @a 0 {spawn_base_y + 1} -112 0 10",
    ])
    return commands


def main() -> int:
    args = parse_args()
    wait_for_server(args.compose_file)
    all_commands: list[str] = []
    exhibits = [
        ("munich", 0, 0, 95),
        ("eiffel", 220, 0, 80),
        ("sydney", 0, 220, 85),
        ("architecture", -220, 0, 80),
        ("colosseum", 220, 220, 90),
        ("neuschwanstein", -220, 220, 90),
    ]
    base_y_by_exhibit = {
        exhibit_id: find_site_base_y(center_x, center_z, radius, args.compose_file)
        for exhibit_id, center_x, center_z, radius in exhibits
    }
    spawn_base_y = find_site_base_y(0, -108, 18, args.compose_file)
    for exhibit_id, center_x, center_z, radius in exhibits:
        all_commands.extend(prepare_plot(center_x, center_z, radius, base_y_by_exhibit[exhibit_id]))
    if not args.skip_ots:
        all_commands.extend(place_ots(REPO_ROOT / "vendor/minecraft-mcp-server/local_structures/munich_famous_building.ots_blocks", 0, 0, "Munich Famous Building", base_y_by_exhibit["munich"]))
        all_commands.extend(place_ots(REPO_ROOT / "vendor/minecraft-mcp-server/local_structures/sydney_opera_house_cadnav.ots_blocks", 0, 220, "Sydney Opera House", base_y_by_exhibit["sydney"]))
    if not args.skip_specs:
        all_commands.extend(seed_spec("eiffel_tower_fr", 220, 0, base_y_by_exhibit["eiffel"]))
        all_commands.extend(seed_spec("colosseum_it", 220, 220, base_y_by_exhibit["colosseum"], "small"))
        all_commands.extend(seed_spec("neuschwanstein_castle_de", -220, 220, base_y_by_exhibit["neuschwanstein"], "small"))
        all_commands.extend(seed_spec("tower_of_pisa_it", -220, 0, base_y_by_exhibit["architecture"], "small"))
    all_commands.extend(paths_and_spawn(spawn_base_y))
    all_commands.append("save-all flush")
    run_rcon(all_commands, args.compose_file, args.batch_size)
    print(f"Seeded museum world with {len(all_commands)} RCON commands.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

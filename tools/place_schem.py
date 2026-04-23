#!/usr/bin/env python3

import argparse
import gzip
import math
import pathlib
import subprocess
from typing import Dict, Iterable, Iterator, List, Tuple

import nbtlib


AIR = "minecraft:air"


def decode_varints(raw: bytes) -> List[int]:
    values: List[int] = []
    index = 0
    while index < len(raw):
        shift = 0
        value = 0
        while True:
            byte = raw[index]
            index += 1
            value |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                break
            shift += 7
        values.append(value)
    return values


def normalize_block_state(state: str) -> str:
    if state == "minecraft:grass":
        return "minecraft:short_grass"
    if state.startswith("minecraft:cauldron[level="):
        return state.replace("minecraft:cauldron", "minecraft:water_cauldron", 1)
    return state


def load_schematic(path: pathlib.Path) -> Tuple[int, int, int, Dict[int, str], List[int]]:
    with gzip.open(path, "rb") as handle:
        root = nbtlib.File.parse(handle)

    width = int(root["Width"])
    height = int(root["Height"])
    length = int(root["Length"])
    palette = {int(value): str(key) for key, value in root["Palette"].items()}
    block_ids = decode_varints(bytes(root["BlockData"]))
    return width, height, length, palette, block_ids


def iter_commands(
    width: int,
    height: int,
    length: int,
    palette: Dict[int, str],
    block_ids: List[int],
    origin_x: int,
    origin_y: int,
    origin_z: int,
    min_x: int,
    max_x: int,
    min_y: int,
    max_y: int,
    min_z: int,
    max_z: int,
) -> Iterator[str]:
    plane = width * length
    for y in range(min_y, max_y + 1):
        for z in range(min_z, max_z + 1):
            run_start = None
            run_state = None
            for x in range(min_x, max_x + 1):
                state = normalize_block_state(palette.get(block_ids[y * plane + z * width + x], AIR))
                if state == AIR:
                    if run_state is not None:
                        yield build_command(origin_x, origin_y, origin_z, y, z, run_start, x - 1, run_state)
                    run_start = None
                    run_state = None
                    continue

                if run_state is None:
                    run_start = x
                    run_state = state
                    continue

                if state != run_state:
                    yield build_command(origin_x, origin_y, origin_z, y, z, run_start, x - 1, run_state)
                    run_start = x
                    run_state = state

            if run_state is not None:
                yield build_command(origin_x, origin_y, origin_z, y, z, run_start, max_x, run_state)


def build_command(
    origin_x: int,
    origin_y: int,
    origin_z: int,
    y: int,
    z: int,
    x1: int,
    x2: int,
    state: str,
) -> str:
    world_y = origin_y + y
    world_z = origin_z + z
    world_x1 = origin_x + x1
    world_x2 = origin_x + x2
    if world_x1 == world_x2:
        return f"setblock {world_x1} {world_y} {world_z} {state}"
    return f"fill {world_x1} {world_y} {world_z} {world_x2} {world_y} {world_z} {state}"


def chunked(items: Iterable[str], size: int) -> Iterator[List[str]]:
    batch: List[str] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def run_rcon_batch(repo_root: pathlib.Path, commands: List[str]) -> None:
    completed = subprocess.run(
        ["docker", "compose", "exec", "-T", "mc", "rcon-cli"],
        cwd=repo_root,
        input="\n".join(commands) + "\n",
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "rcon-cli failed")


def main() -> int:
    parser = argparse.ArgumentParser(description="Paste a WorldEdit .schem file into the local Minecraft server.")
    parser.add_argument("--input", required=True, help="Path to a .schem file")
    parser.add_argument("--origin-x", type=int, required=True, help="Minimum world X for the schematic")
    parser.add_argument("--origin-y", type=int, required=True, help="Minimum world Y for the schematic")
    parser.add_argument("--origin-z", type=int, required=True, help="Minimum world Z for the schematic")
    parser.add_argument("--batch-size", type=int, default=1200, help="RCON commands per batch")
    parser.add_argument("--min-x", type=int, default=0, help="Minimum local X to include")
    parser.add_argument("--max-x", type=int, help="Maximum local X to include")
    parser.add_argument("--min-y", type=int, default=0, help="Minimum local Y to include")
    parser.add_argument("--max-y", type=int, help="Maximum local Y to include")
    parser.add_argument("--min-z", type=int, default=0, help="Minimum local Z to include")
    parser.add_argument("--max-z", type=int, help="Maximum local Z to include")
    args = parser.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parents[1]
    schem_path = pathlib.Path(args.input).expanduser().resolve()
    width, height, length, palette, block_ids = load_schematic(schem_path)

    local_min_x = max(0, args.min_x)
    local_max_x = width - 1 if args.max_x is None else min(width - 1, args.max_x)
    local_min_y = max(0, args.min_y)
    local_max_y = height - 1 if args.max_y is None else min(height - 1, args.max_y)
    local_min_z = max(0, args.min_z)
    local_max_z = length - 1 if args.max_z is None else min(length - 1, args.max_z)
    if local_min_x > local_max_x or local_min_y > local_max_y or local_min_z > local_max_z:
        raise SystemExit("Invalid crop bounds")

    min_x = args.origin_x + local_min_x
    max_x = args.origin_x + local_max_x
    min_z = args.origin_z + local_min_z
    max_z = args.origin_z + local_max_z

    run_rcon_batch(repo_root, [f"forceload add {min_x} {min_z} {max_x} {max_z}"])

    total_commands = 0
    for batch_index, batch in enumerate(
        chunked(
            iter_commands(
                width,
                height,
                length,
                palette,
                block_ids,
                args.origin_x,
                args.origin_y,
                args.origin_z,
                local_min_x,
                local_max_x,
                local_min_y,
                local_max_y,
                local_min_z,
                local_max_z,
            ),
            max(1, args.batch_size),
        ),
        start=1,
    ):
        run_rcon_batch(repo_root, batch)
        total_commands += len(batch)
        print(f"batch={batch_index} commands={len(batch)} total={total_commands}", flush=True)

    print(
        f"done width={width} height={height} length={length} "
        f"bounds=({min_x},{args.origin_y},{min_z})..({max_x},{args.origin_y + height - 1},{max_z}) "
        f"commands={total_commands}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

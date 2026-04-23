#!/usr/bin/env python3

import argparse
import json
import pathlib
import subprocess
from collections import Counter
from dataclasses import dataclass
from typing import Dict, Iterable, Iterator, List, Sequence, Tuple

import numpy as np
import trimesh
from scipy.spatial import cKDTree


@dataclass(frozen=True)
class PaletteBlock:
    state: str
    rgb: Tuple[int, int, int]


@dataclass(frozen=True)
class ModelVoxel:
    x: int
    y: int
    z: int
    rgb: Tuple[int, int, int]


INDUSTRIAL_PALETTE: Sequence[PaletteBlock] = (
    PaletteBlock("minecraft:iron_block", (224, 224, 224)),
    PaletteBlock("minecraft:white_concrete", (207, 213, 214)),
    PaletteBlock("minecraft:light_gray_concrete", (142, 142, 134)),
    PaletteBlock("minecraft:gray_concrete", (54, 57, 61)),
    PaletteBlock("minecraft:black_concrete", (8, 10, 15)),
    PaletteBlock("minecraft:smooth_stone", (158, 158, 158)),
    PaletteBlock("minecraft:stone_bricks", (122, 122, 122)),
    PaletteBlock("minecraft:polished_andesite", (133, 135, 134)),
    PaletteBlock("minecraft:cobbled_deepslate", (76, 76, 76)),
    PaletteBlock("minecraft:light_blue_concrete", (121, 170, 220)),
    PaletteBlock("minecraft:blue_concrete", (45, 47, 143)),
    PaletteBlock("minecraft:brown_concrete", (96, 59, 31)),
    PaletteBlock("minecraft:red_concrete", (142, 32, 32)),
    PaletteBlock("minecraft:orange_concrete", (224, 97, 0)),
    PaletteBlock("minecraft:yellow_concrete", (240, 175, 21)),
    PaletteBlock("minecraft:cyan_concrete", (21, 119, 136)),
    PaletteBlock("minecraft:green_concrete", (73, 91, 36)),
    PaletteBlock("minecraft:lime_concrete", (94, 168, 24)),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Voxelize a GLB or place a voxel JSON model into the local Minecraft server.")
    parser.add_argument("--input", required=True, help="Path to a .glb file or voxel JSON file")
    parser.add_argument("--origin-x", type=int, required=True, help="Minimum world X for the placed model")
    parser.add_argument("--origin-y", type=int, required=True, help="Minimum world Y for the placed model")
    parser.add_argument("--origin-z", type=int, required=True, help="Minimum world Z for the placed model")
    parser.add_argument(
        "--axis-order",
        default="xzy",
        help="World axis mapping from model axes, e.g. xzy means world x<-model x, world y<-model z, world z<-model y",
    )
    parser.add_argument("--pitch", type=float, default=0.03, help="Voxel size for GLB input")
    parser.add_argument("--batch-size", type=int, default=1200, help="RCON commands per batch")
    parser.add_argument("--fill-interior", action="store_true", help="Fill enclosed voxel cavities before placing")
    parser.add_argument("--dry-run", action="store_true", help="Only print summary, do not place blocks")
    return parser.parse_args()


def nearest_palette_block(rgb: Tuple[int, int, int]) -> str:
    r, g, b = rgb
    best_state = INDUSTRIAL_PALETTE[0].state
    best_distance = float("inf")
    for candidate in INDUSTRIAL_PALETTE:
        cr, cg, cb = candidate.rgb
        distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if distance < best_distance:
            best_distance = distance
            best_state = candidate.state
    return best_state


def normalize_axis_order(axis_order: str) -> Tuple[int, int, int]:
    axis_order = axis_order.lower().strip()
    if sorted(axis_order) != ["x", "y", "z"] or len(axis_order) != 3:
        raise ValueError(f"Invalid axis order '{axis_order}'. Expected a permutation of xyz.")
    axis_map = {"x": 0, "y": 1, "z": 2}
    return axis_map[axis_order[0]], axis_map[axis_order[1]], axis_map[axis_order[2]]


def load_voxel_json(path: pathlib.Path) -> List[ModelVoxel]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, list):
        raise ValueError("Voxel JSON must be a list of {x,y,z,r,g,b} entries.")
    voxels: List[ModelVoxel] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        if not {"x", "y", "z", "r", "g", "b"}.issubset(item):
            continue
        voxels.append(
            ModelVoxel(
                x=int(item["x"]),
                y=int(item["y"]),
                z=int(item["z"]),
                rgb=(int(item["r"]), int(item["g"]), int(item["b"])),
            )
        )
    if not voxels:
        raise ValueError("Voxel JSON did not contain any usable voxel entries.")
    return voxels


def load_glb_voxels(path: pathlib.Path, pitch: float, fill_interior: bool) -> List[ModelVoxel]:
    scene = trimesh.load(path, force="scene")
    mesh = scene.to_geometry()
    voxel_grid = mesh.voxelized(pitch)
    if fill_interior:
        voxel_grid = voxel_grid.fill()

    points = voxel_grid.points
    if len(points) == 0:
        raise ValueError("GLB voxelization produced zero voxels.")

    colour_visual = mesh.visual.to_color()
    vertex_colours = np.asarray(colour_visual.vertex_colors)[:, :3].astype(np.float32)
    tree = cKDTree(np.asarray(mesh.vertices))
    _, nearest = tree.query(points)
    sampled_colours = vertex_colours[nearest].astype(np.uint8)

    mins = points.min(axis=0)
    indices = np.rint((points - mins) / pitch).astype(int)
    voxels = [
        ModelVoxel(
            x=int(index[0]),
            y=int(index[1]),
            z=int(index[2]),
            rgb=(int(colour[0]), int(colour[1]), int(colour[2])),
        )
        for index, colour in zip(indices, sampled_colours)
    ]
    return voxels


def load_model_voxels(path: pathlib.Path, pitch: float, fill_interior: bool) -> List[ModelVoxel]:
    suffixes = [suffix.lower() for suffix in path.suffixes]
    if suffixes and suffixes[-1] == ".json":
        return load_voxel_json(path)
    if suffixes and suffixes[-1] == ".glb":
        return load_glb_voxels(path, pitch, fill_interior)
    raise ValueError(f"Unsupported input format for {path.name}. Expected .glb or voxel .json.")


def map_voxels_to_world(
    voxels: Sequence[ModelVoxel],
    origin_x: int,
    origin_y: int,
    origin_z: int,
    axis_order: str,
) -> List[Tuple[int, int, int, str]]:
    axis_x, axis_y, axis_z = normalize_axis_order(axis_order)
    entries = np.array([[voxel.x, voxel.y, voxel.z] for voxel in voxels], dtype=int)
    mins = entries.min(axis=0)
    entries = entries - mins

    world_voxels: List[Tuple[int, int, int, str]] = []
    for entry, voxel in zip(entries, voxels):
        coords = [int(entry[axis_x]), int(entry[axis_y]), int(entry[axis_z])]
        world_voxels.append(
            (
                origin_x + coords[0],
                origin_y + coords[1],
                origin_z + coords[2],
                nearest_palette_block(voxel.rgb),
            )
        )

    deduped: Dict[Tuple[int, int, int], str] = {}
    for x, y, z, state in world_voxels:
        deduped[(x, y, z)] = state

    return [(x, y, z, state) for (x, y, z), state in sorted(deduped.items(), key=lambda item: (item[0][1], item[0][2], item[0][0]))]


def iter_commands(world_voxels: Sequence[Tuple[int, int, int, str]]) -> Iterator[str]:
    if not world_voxels:
        return

    run_start = None
    run_end = None
    run_state = None
    run_y = None
    run_z = None

    for x, y, z, state in world_voxels:
        if (
            run_state is not None
            and y == run_y
            and z == run_z
            and state == run_state
            and x == run_end + 1
        ):
            run_end = x
            continue

        if run_state is not None:
            yield build_command(run_start, run_end, run_y, run_z, run_state)

        run_start = x
        run_end = x
        run_y = y
        run_z = z
        run_state = state

    if run_state is not None:
        yield build_command(run_start, run_end, run_y, run_z, run_state)


def build_command(x1: int, x2: int, y: int, z: int, state: str) -> str:
    if x1 == x2:
        return f"setblock {x1} {y} {z} {state}"
    return f"fill {x1} {y} {z} {x2} {y} {z} {state}"


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
    args = parse_args()
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    input_path = pathlib.Path(args.input).expanduser().resolve()
    voxels = load_model_voxels(input_path, args.pitch, args.fill_interior)
    world_voxels = map_voxels_to_world(voxels, args.origin_x, args.origin_y, args.origin_z, args.axis_order)

    xs = [voxel[0] for voxel in world_voxels]
    ys = [voxel[1] for voxel in world_voxels]
    zs = [voxel[2] for voxel in world_voxels]
    palette_counts = Counter(state for _, _, _, state in world_voxels)

    print(
        f"voxels={len(world_voxels)} bounds=({min(xs)},{min(ys)},{min(zs)})..({max(xs)},{max(ys)},{max(zs)}) "
        f"axis_order={args.axis_order} input={input_path.name}"
    )
    print("palette=" + ", ".join(f"{state}:{count}" for state, count in palette_counts.most_common(12)))

    if args.dry_run:
        return 0

    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    run_rcon_batch(repo_root, [f"forceload add {min_x} {min_z} {max_x} {max_z}"])

    total_commands = 0
    for batch_index, batch in enumerate(chunked(iter_commands(world_voxels), max(1, args.batch_size)), start=1):
        run_rcon_batch(repo_root, batch)
        total_commands += len(batch)
        print(f"batch={batch_index} commands={len(batch)} total={total_commands}", flush=True)

    print(
        f"done voxels={len(world_voxels)} commands={total_commands} "
        f"bounds=({min_x},{min(ys)},{min_z})..({max_x},{max(ys)},{max_z})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

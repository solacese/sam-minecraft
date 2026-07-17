#!/usr/bin/env python3

import argparse
import gzip
import json
import pathlib
from typing import Dict, List

import nbtlib
from nbtlib import tag


def encode_varints(values: List[int]) -> bytes:
    output = bytearray()
    for value in values:
        current = value
        while True:
            byte = current & 0x7F
            current >>= 7
            if current:
                output.append(byte | 0x80)
            else:
                output.append(byte)
                break
    return bytes(output)


def build_schematic(plan_path: pathlib.Path, output_path: pathlib.Path) -> Dict[str, int]:
    plan = json.loads(plan_path.read_text())
    blocks = plan["translatedBlocks"]
    if not blocks:
        raise SystemExit("Placement plan has no translated blocks")

    min_x = min(block["x"] for block in blocks)
    max_x = max(block["x"] for block in blocks)
    min_y = min(block["y"] for block in blocks)
    max_y = max(block["y"] for block in blocks)
    min_z = min(block["z"] for block in blocks)
    max_z = max(block["z"] for block in blocks)

    width = max_x - min_x + 1
    height = max_y - min_y + 1
    length = max_z - min_z + 1

    palette: Dict[str, int] = {"minecraft:air": 0}
    for block in blocks:
        state = block["blockState"]
        if state not in palette:
            palette[state] = len(palette)

    total = width * height * length
    block_ids = [0] * total
    plane = width * length

    for block in blocks:
        local_x = block["x"] - min_x
        local_y = block["y"] - min_y
        local_z = block["z"] - min_z
        index = local_y * plane + local_z * width + local_x
        block_ids[index] = palette[block["blockState"]]

    palette_tag = tag.Compound({state: tag.Int(index) for state, index in palette.items()})
    encoded_block_data = encode_varints(block_ids)
    root = nbtlib.File(
        {
            "Version": tag.Int(2),
            "DataVersion": tag.Int(4189),
            "Width": tag.Short(width),
            "Height": tag.Short(height),
            "Length": tag.Short(length),
            "PaletteMax": tag.Int(len(palette)),
            "Palette": palette_tag,
            "BlockData": tag.ByteArray(list(encoded_block_data)),
            "Offset": tag.IntArray([0, 0, 0]),
            "Metadata": tag.Compound({}),
        }
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output_path, "wb") as handle:
        root.write(handle)

    return {
        "width": width,
        "height": height,
        "length": length,
        "palette": len(palette),
        "blocks": len(blocks),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert an imported model placement plan JSON into a WorldEdit .schem file.")
    parser.add_argument("--input", required=True, help="Path to the placement plan JSON")
    parser.add_argument("--output", required=True, help="Path to the output .schem file")
    args = parser.parse_args()

    stats = build_schematic(pathlib.Path(args.input).expanduser().resolve(), pathlib.Path(args.output).expanduser().resolve())
    print(
        "done "
        f"width={stats['width']} height={stats['height']} length={stats['length']} "
        f"palette={stats['palette']} blocks={stats['blocks']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

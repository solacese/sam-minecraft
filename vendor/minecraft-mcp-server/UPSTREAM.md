# Upstream Source

This directory vendors the upstream project:
- Repository: https://github.com/yuniko-software/minecraft-mcp-server
- Pinned commit: c7b7fded624a797e8053582cffafb2e96d01235c

## Local patches in this repository

This vendored copy includes local changes for SAM demo reliability:
- Coordinate coercion for all handlers that accept `x`, `y`, `z`.
- `z.coerce.number()` schema parsing for coordinate fields so numeric strings are accepted.
- Explicit validation that coerced coordinates are finite numbers before tool execution.

These patches address coordinate validation mismatches observed in integrated SAM + Minecraft flows.

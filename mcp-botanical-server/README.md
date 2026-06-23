# MCP Botanical Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (built with
**FastMCP**) that provides plant compatibility and companion-planting knowledge
for the Urban Agri-Planner agents. It runs over stdio and is launched by the
backend's ADK `McpToolset`.

## Tools

| Tool | Description |
| --- | --- |
| `get_compatible_plants(sunlightHours, exposure)` | Returns plants suited to the available sunlight and balcony exposure. North-facing exposures keep only shade-tolerant crops (sunlight need ≤ `NORTH_EXPOSURE_MAX_SUN_HOURS`). |
| `get_crop_details(plantId)` | Returns the full record for a single plant. |
| `check_companion_planting(plantIds)` | Reports companion/antagonist relationships and warnings (e.g. invasive mint) for a proposed selection. |

The pairwise companion/antagonist logic lives in a single module-level
`compute_relationships(selected)` function. `check_companion_planting` is a thin
wrapper over it, and the backend orchestrator imports the **same** function so
the MCP tool and the final assembled plan can never disagree.

## Data

Plant knowledge lives in [db.json](db.json) — a curated catalogue of 50 balcony
crops with sunlight needs, temperature ranges, sowing/harvest months, companion
and antagonist species, and growing notes. No API key or network access is
required.

## Run standalone

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install .
python server.py        # serves MCP over stdio
```

The backend normally spawns this server automatically, so running it by hand is
only needed for debugging.

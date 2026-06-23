# MCP Climate Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (built with
**FastMCP**) that provides geocoding and climate data for the Urban Agri-Planner
agents. It runs over stdio and is launched by the backend's ADK `McpToolset`.

## Tools

| Tool | Description | Data source |
| --- | --- | --- |
| `get_coordinates(address)` | Geocodes a free-text address to latitude/longitude. | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) |
| `get_climate_data(latitude, longitude)` | Returns a monthly temperature/precipitation profile and an estimated USDA hardiness zone. | [Open-Meteo](https://open-meteo.com) archive API |

No API key is required; both data sources are free.

## Run standalone

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install .
python server.py        # serves MCP over stdio
```

The backend normally spawns this server automatically, so running it by hand is
only needed for debugging.

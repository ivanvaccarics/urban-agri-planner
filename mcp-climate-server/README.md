# MCP Climate Server

A [Model Context Protocol](https://modelcontextprotocol.io) server (built with
**FastMCP**) that provides geocoding and climate data for the Urban Agri-Planner
agents. It runs over stdio and is launched by the backend's ADK `McpToolset`.

## Tools

| Tool | Description | Data source |
| --- | --- | --- |
| `get_coordinates(address)` | Geocodes a free-text address to latitude/longitude. | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) |
| `get_climate_data(latitude, longitude)` | Returns a monthly temperature/precipitation profile, an estimated USDA hardiness zone, frost-date estimates, and the climate window used. | [Open-Meteo](https://open-meteo.com) archive API |

No API key is required; both data sources are free.

### `get_climate_data` details

- **Multi-year averaging** — the monthly profile is averaged over a rolling
  10-year window (the last 10 complete calendar years) rather than a single
  year, so a one-off warm or cold year cannot skew the plan.
- **Hardiness zone** — derived from the mean annual minimum temperature using a
  proper USDA band table (zones 1–13), not a hard-coded floor.
- **Frost dates** — `frostDates` reports the estimated `lastSpringFrost`,
  `firstAutumnFrost` (formatted like `15 Apr`) and the `frostFreeDays` between
  them, computed from the averaged daily minima.
- **`climateYears`** — the `{start, end, count}` of the window the averages were
  computed over, surfaced so the UI can cite the basis of the plan.

## Run standalone

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install .
python server.py        # serves MCP over stdio
```

The backend normally spawns this server automatically, so running it by hand is
only needed for debugging.

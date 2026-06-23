"""Integration test for the Python MCP servers (replaces test-mcp-servers.js).

Spawns each FastMCP server over stdio with the real MCP Python client and
exercises ``tools/list`` plus the key tools, asserting the response shapes the
backend agents rely on.

The climate server makes live calls to Nominatim and Open-Meteo, so an internet
connection is required; the botanical server is fully offline.

Run::

    backend/.venv/bin/python test_mcp_servers.py

(or any Python that has the ``mcp`` and ``httpx`` packages installed).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent
# Prefer the backend virtualenv (it has mcp + httpx) to launch the servers.
_VENV_PY = ROOT / "backend" / ".venv" / "bin" / "python"
SERVER_PY = str(_VENV_PY) if _VENV_PY.exists() else sys.executable
CLIMATE_SERVER = ROOT / "mcp-climate-server" / "server.py"
BOTANICAL_SERVER = ROOT / "mcp-botanical-server" / "server.py"

# Fallback coordinates (Milano) used only if live geocoding is unavailable.
MILANO_LAT = 45.4641
MILANO_LON = 9.1896


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def record(results: list, name: str, fn) -> None:
    """Run a check closure, recording (name, ok, error)."""
    try:
        fn()
        results.append((name, True, None))
    except Exception as exc:  # noqa: BLE001
        results.append((name, False, str(exc)))


def _result(res) -> dict:
    """Decode a tool result into the dict our FastMCP tools return."""
    if res.structuredContent is not None:
        sc = res.structuredContent
        if isinstance(sc, dict) and set(sc.keys()) == {"result"}:
            return sc["result"]
        return sc
    if res.content:
        return json.loads(res.content[0].text)
    return {}


async def run_climate(results: list) -> None:
    params = StdioServerParameters(command=SERVER_PY, args=[str(CLIMATE_SERVER)])
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tool_names = [t.name for t in (await session.list_tools()).tools]
            record(
                results,
                "climate · tools/list",
                lambda: check(
                    {"get_coordinates", "get_climate_data"} <= set(tool_names),
                    f"unexpected tools: {tool_names}",
                ),
            )

            geo = _result(
                await session.call_tool("get_coordinates", {"address": "Milano, Italy"})
            )

            def _check_geo() -> None:
                check(isinstance(geo.get("latitude"), (int, float)), "latitude missing/not numeric")
                check(isinstance(geo.get("longitude"), (int, float)), "longitude missing/not numeric")
                check("Milano" in (geo.get("displayName") or ""), f"unexpected displayName: {geo.get('displayName')}")

            record(results, "climate · get_coordinates(Milano)", _check_geo)

            lat = geo.get("latitude", MILANO_LAT)
            lon = geo.get("longitude", MILANO_LON)
            climate = _result(
                await session.call_tool(
                    "get_climate_data", {"latitude": lat, "longitude": lon}
                )
            )

            def _check_climate() -> None:
                profile = climate.get("monthlyProfile", [])
                check(len(profile) == 12, f"monthlyProfile must have 12 months, got {len(profile)}")
                check(climate.get("estimatedHardinessZone") is not None, "estimatedHardinessZone missing")
                check(climate.get("absoluteMinTempYear") is not None, "absoluteMinTempYear missing")
                check("averageMaxTemp" in profile[0], f"monthly entry missing keys: {profile[0]}")

            record(results, "climate · get_climate_data", _check_climate)


async def run_botanical(results: list) -> None:
    params = StdioServerParameters(command=SERVER_PY, args=[str(BOTANICAL_SERVER)])
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tool_names = [t.name for t in (await session.list_tools()).tools]
            record(
                results,
                "botanical · tools/list",
                lambda: check(
                    {"get_compatible_plants", "get_crop_details", "check_companion_planting"}
                    <= set(tool_names),
                    f"unexpected tools: {tool_names}",
                ),
            )

            south = _result(
                await session.call_tool(
                    "get_compatible_plants", {"sunlightHours": 6, "exposure": "South"}
                )
            )

            def _check_south() -> None:
                plants = south.get("plants", [])
                check(south.get("count") == len(plants), "count does not match plants length")
                check(len(plants) > 0, "no compatible plants for 6h south")
                check("tomato" in {p["id"] for p in plants}, "tomato should be compatible with 6h south")

            record(results, "botanical · get_compatible_plants(6h, South)", _check_south)

            north = _result(
                await session.call_tool(
                    "get_compatible_plants", {"sunlightHours": 6, "exposure": "North"}
                )
            )

            def _check_north() -> None:
                ids = {p["id"] for p in north.get("plants", [])}
                check("tomato" not in ids, "tomato (6h) must be excluded for North exposure")
                check(all(p["sunlightHoursMin"] <= 4 for p in north.get("plants", [])), "North results must be shade-tolerant")

            record(results, "botanical · get_compatible_plants(North shade filter)", _check_north)

            details = _result(
                await session.call_tool("get_crop_details", {"plantId": "lettuce"})
            )
            record(
                results,
                "botanical · get_crop_details(lettuce)",
                lambda: check(details.get("name") == "Lettuce", f"unexpected crop details: {details}"),
            )

            companion = _result(
                await session.call_tool(
                    "check_companion_planting",
                    {"plantIds": ["tomato", "basil", "mint"]},
                )
            )

            def _check_companion() -> None:
                companions = companion.get("companions", [])
                antagonists = companion.get("antagonists", [])
                warnings = companion.get("warnings", [])
                check(
                    any({"Tomato", "Basil"} == set(c["plants"]) for c in companions),
                    "expected Tomato+Basil companion pairing",
                )
                check(
                    any({"Basil", "Mint"} == set(a["plants"]) for a in antagonists),
                    "expected Basil+Mint antagonist pairing",
                )
                check(any("Mint" in w for w in warnings), "expected invasive-mint warning")

            record(results, "botanical · check_companion_planting", _check_companion)


async def main() -> int:
    results: list = []
    for label, runner in (("climate", run_climate), ("botanical", run_botanical)):
        try:
            await runner(results)
        except Exception as exc:  # noqa: BLE001
            results.append((f"{label} · server connection", False, str(exc)))

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    for name, ok, err in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f": {err}" if err else ""))
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

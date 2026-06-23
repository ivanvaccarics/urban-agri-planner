"""Botanical MCP server (Python / FastMCP).

Exposes plant-compatibility and companion-planting tools over the Model
Context Protocol using stdio transport. The plant database lives in ``db.json``.

Tools:
  - get_compatible_plants(sunlightHours, exposure) -> {count, plants}
  - get_crop_details(plantId)                       -> plant | {error}
  - check_companion_planting(plantIds)              -> {companions, antagonists, warnings}
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

DB_PATH = Path(__file__).resolve().parent / "db.json"
PLANTS: list[dict[str, Any]] = json.loads(DB_PATH.read_text(encoding="utf-8"))

mcp = FastMCP("mcp-botanical-server")


@mcp.tool()
def get_compatible_plants(sunlightHours: float, exposure: str) -> dict[str, Any]:
    """List plants compatible with the available sunlight and orientation.

    Filters by each plant's minimum sunlight requirement. For a North-facing
    exposure only shade-tolerant plants (``sunlightHoursMin <= 4``) are kept.

    Args:
        sunlightHours: Hours of direct sunlight available per day.
        exposure: Orientation, e.g. "South", "North", "East", "South-East".

    Returns:
        Dict with ``count`` and the list of matching ``plants``.
    """
    is_north = "north" in exposure.lower()
    filtered = []
    for plant in PLANTS:
        if sunlightHours < plant["sunlightHoursMin"]:
            continue
        if is_north and plant["sunlightHoursMin"] > 4:
            continue
        filtered.append(plant)

    return {"count": len(filtered), "plants": filtered}


@mcp.tool()
def get_crop_details(plantId: str) -> dict[str, Any]:
    """Get the full record for a single plant by its ID.

    Args:
        plantId: Unique plant ID, e.g. "tomato" or "lettuce".

    Returns:
        The plant record, or ``{"error": ...}`` if the ID is unknown.
    """
    for plant in PLANTS:
        if plant["id"] == plantId:
            return plant
    return {"error": f"Plant with ID '{plantId}' not found"}


@mcp.tool()
def check_companion_planting(plantIds: list[str]) -> dict[str, Any]:
    """Analyze a set of plants for companion-planting relationships.

    Finds beneficial pairings, antagonistic pairings, and emits warnings for
    invasive species (e.g. mint).

    Args:
        plantIds: Plant IDs to analyze together.

    Returns:
        Dict with ``companions``, ``antagonists`` and ``warnings`` lists.
    """
    selected = [p for p in PLANTS if p["id"] in plantIds]

    companions: list[dict[str, Any]] = []
    antagonists: list[dict[str, Any]] = []
    warnings: list[str] = []

    for i, p1 in enumerate(selected):
        if p1["id"] == "mint":
            warnings.append(
                "Mint is highly invasive. We strongly recommend growing it "
                "in a separate pot, away from any other crop."
            )
        for j in range(i + 1, len(selected)):
            p2 = selected[j]
            if p2["name"] in p1["companions"] or p1["name"] in p2["companions"]:
                companions.append(
                    {
                        "plants": [p1["name"], p2["name"]],
                        "reason": "Great combination! Grown side by side they support each other.",
                    }
                )
            if p2["name"] in p1["antagonists"] or p1["name"] in p2["antagonists"]:
                antagonists.append(
                    {
                        "plants": [p1["name"], p2["name"]],
                        "reason": "Not recommended together. They can compete for resources or attract similar pests.",
                    }
                )

    return {"companions": companions, "antagonists": antagonists, "warnings": warnings}


if __name__ == "__main__":
    mcp.run(transport="stdio")

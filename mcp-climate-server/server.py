"""Climate MCP server (Python / FastMCP).

Exposes geocoding and historical climate tools over the Model Context Protocol
using stdio transport. The data contract is consumed by the ADK agents and the
frontend.

Tools:
  - get_coordinates(address)            -> {latitude, longitude, displayName}
  - get_climate_data(latitude, longitude) -> {monthlyProfile, estimatedHardinessZone, absoluteMinTempYear}
"""

from __future__ import annotations

from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
USER_AGENT = "UrbanAgriPlanner/1.0 (contact: support@urbanagriplanner.local)"

mcp = FastMCP("mcp-climate-server")


@mcp.tool()
async def get_coordinates(address: str) -> dict[str, Any]:
    """Get latitude/longitude for an address using OpenStreetMap Nominatim.

    Args:
        address: Free-form address, e.g. "Via Roma 10, Milano, Italy".

    Returns:
        Dict with ``latitude``, ``longitude`` and ``displayName`` on success,
        or ``{"error": ...}`` when the address cannot be resolved.
    """
    params = {"format": "json", "q": address, "limit": 1}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                NOMINATIM_URL, params=params, headers={"User-Agent": USER_AGENT}
            )
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # noqa: BLE001 - surface as structured error
        return {"error": str(exc)}

    if not data:
        return {"error": "Address not found"}

    result = data[0]
    return {
        "latitude": float(result["lat"]),
        "longitude": float(result["lon"]),
        "displayName": result["display_name"],
    }


def _estimate_hardiness_zone(year_abs_min: float | None) -> str:
    """USDA hardiness zone from the absolute yearly minimum temperature (°C)."""
    if year_abs_min is None:
        return "Unknown"
    if year_abs_min >= 4.4:
        return "11"
    if year_abs_min >= -1.1:
        return "10"
    if year_abs_min >= -6.7:
        return "9"
    if year_abs_min >= -12.2:
        return "8"
    if year_abs_min >= -17.8:
        return "7"
    if year_abs_min >= -23.3:
        return "6"
    return "5"


@mcp.tool()
async def get_climate_data(latitude: float, longitude: float) -> dict[str, Any]:
    """Get a 12-month climate profile for a coordinate using Open-Meteo.

    Aggregates daily 2025 archive data into monthly average max/min
    temperatures, total precipitation and absolute monthly minimums, and
    estimates the USDA hardiness zone from the yearly absolute minimum.

    Args:
        latitude: Latitude coordinate.
        longitude: Longitude coordinate.

    Returns:
        Dict with ``monthlyProfile`` (12 entries), ``estimatedHardinessZone``
        and ``absoluteMinTempYear``, or ``{"error": ...}`` on failure.
    """
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": "2025-01-01",
        "end_date": "2025-12-31",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(OPEN_METEO_URL, params=params)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:  # noqa: BLE001 - surface as structured error
        return {"error": str(exc)}

    daily = payload.get("daily")
    if not daily or not daily.get("time"):
        return {"error": "No climate data found for these coordinates"}

    times = daily["time"]
    temp_max = daily["temperature_2m_max"]
    temp_min = daily["temperature_2m_min"]
    precip = daily["precipitation_sum"]

    monthly = [
        {"max_sum": 0.0, "min_sum": 0.0, "precip_sum": 0.0, "count": 0, "abs_min": None}
        for _ in range(12)
    ]

    for i, date_str in enumerate(times):
        month_index = int(date_str.split("-")[1]) - 1
        t_max = temp_max[i]
        t_min = temp_min[i]
        p = precip[i]

        if t_max is not None and t_min is not None:
            bucket = monthly[month_index]
            bucket["max_sum"] += t_max
            bucket["min_sum"] += t_min
            bucket["count"] += 1
            if bucket["abs_min"] is None or t_min < bucket["abs_min"]:
                bucket["abs_min"] = t_min
        if p is not None:
            monthly[month_index]["precip_sum"] += p

    monthly_profile = []
    for index, bucket in enumerate(monthly):
        count = bucket["count"]
        avg_max = round(bucket["max_sum"] / count, 1) if count > 0 else None
        avg_min = round(bucket["min_sum"] / count, 1) if count > 0 else None
        total_precip = round(bucket["precip_sum"], 1)
        abs_min = round(bucket["abs_min"], 1) if bucket["abs_min"] is not None else None
        monthly_profile.append(
            {
                "month": MONTH_NAMES[index],
                "averageMaxTemp": avg_max,
                "averageMinTemp": avg_min,
                "totalPrecipitation": total_precip,
                "absoluteMinTemp": abs_min,
            }
        )

    all_mins = [t for t in temp_min if t is not None]
    year_abs_min = round(min(all_mins), 1) if all_mins else None

    return {
        "monthlyProfile": monthly_profile,
        "estimatedHardinessZone": _estimate_hardiness_zone(year_abs_min),
        "absoluteMinTempYear": year_abs_min,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")

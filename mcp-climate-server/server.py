"""Climate MCP server (Python / FastMCP).

Exposes geocoding and historical climate tools over the Model Context Protocol
using stdio transport. The data contract is consumed by the ADK agents and the
frontend.

Tools:
  - get_coordinates(address)            -> {latitude, longitude, displayName}
  - get_climate_data(latitude, longitude) -> {monthlyProfile, estimatedHardinessZone, absoluteMinTempYear}
"""

from __future__ import annotations

from datetime import date
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
USER_AGENT = "UrbanAgriPlanner/1.0 (contact: support@urbanagriplanner.local)"

# Number of complete past years to average for climate normals. Using a
# multi-year window (instead of a single calendar year) smooths out anomalous
# seasons so the hardiness zone and monthly averages are representative.
CLIMATE_YEARS = 10

# Daily minimum at or below this (°C) counts as a frost day.
FROST_THRESHOLD = 0.0

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


# USDA hardiness zones: (lower bound °C of the average annual minimum, label).
# Ordered warmest -> coldest; the first bound the value clears wins.
_HARDINESS_BANDS = [
    (15.6, "13"),
    (10.0, "12"),
    (4.4, "11"),
    (-1.1, "10"),
    (-6.7, "9"),
    (-12.2, "8"),
    (-17.8, "7"),
    (-23.3, "6"),
    (-28.9, "5"),
    (-34.4, "4"),
    (-40.0, "3"),
    (-45.6, "2"),
]


def _estimate_hardiness_zone(year_abs_min: float | None) -> str:
    """USDA hardiness zone from the absolute yearly minimum temperature (°C)."""
    if year_abs_min is None:
        return "Unknown"
    for lower_bound, label in _HARDINESS_BANDS:
        if year_abs_min >= lower_bound:
            return label
    return "1"


def _estimate_frost_dates(
    day_mins: dict[str, list[float]],
) -> dict[str, Any]:
    """Estimate the average last spring and first autumn frost dates.

    Args:
        day_mins: Map of ``"MM-DD"`` -> list of daily minimum temps across the
            averaged years.

    Returns:
        Dict with ``lastSpringFrost``, ``firstAutumnFrost`` (human-readable, or
        ``None`` when the location is frost-free in that half of the year) and
        the resulting ``frostFreeDays`` count.
    """
    averaged: list[tuple[int, int, float]] = []
    for key, mins in day_mins.items():
        if not mins:
            continue
        month, day = (int(part) for part in key.split("-"))
        averaged.append((month, day, sum(mins) / len(mins)))
    averaged.sort()

    last_spring: tuple[int, int] | None = None
    first_autumn: tuple[int, int] | None = None
    for month, day, avg_min in averaged:
        is_frost = avg_min <= FROST_THRESHOLD
        if month <= 6 and is_frost:
            last_spring = (month, day)  # keep advancing to the latest spring frost
        if month >= 7 and is_frost and first_autumn is None:
            first_autumn = (month, day)

    def _fmt(when: tuple[int, int] | None) -> str | None:
        if when is None:
            return None
        month, day = when
        return f"{day} {MONTH_ABBR[month - 1]}"

    frost_free_days: int | None = None
    if last_spring is not None and first_autumn is not None:
        start = date(2001, *last_spring)
        end = date(2001, *first_autumn)
        frost_free_days = max((end - start).days, 0)

    return {
        "lastSpringFrost": _fmt(last_spring),
        "firstAutumnFrost": _fmt(first_autumn),
        "frostFreeDays": frost_free_days,
    }


@mcp.tool()
async def get_climate_data(latitude: float, longitude: float) -> dict[str, Any]:
    """Get a 12-month climate profile for a coordinate using Open-Meteo.

    Aggregates daily archive data over the last ``CLIMATE_YEARS`` complete years
    into monthly average max/min temperatures, total precipitation (per-year
    average) and absolute monthly minimums. The USDA hardiness zone is estimated
    from the average annual minimum, and average frost dates are derived from
    the multi-year daily minimums.

    Args:
        latitude: Latitude coordinate.
        longitude: Longitude coordinate.

    Returns:
        Dict with ``monthlyProfile`` (12 entries), ``estimatedHardinessZone``,
        ``absoluteMinTempYear``, ``frostDates`` and ``climateYears``, or
        ``{"error": ...}`` on failure.
    """
    end_year = date.today().year - 1
    start_year = end_year - (CLIMATE_YEARS - 1)
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": f"{start_year}-01-01",
        "end_date": f"{end_year}-12-31",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient(timeout=40.0) as client:
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
    day_mins: dict[str, list[float]] = {}
    yearly_mins: dict[int, float] = {}

    for i, date_str in enumerate(times):
        year_str, month_str, day_str = date_str.split("-")
        year = int(year_str)
        month_index = int(month_str) - 1
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
        if t_min is not None:
            day_mins.setdefault(f"{month_str}-{day_str}", []).append(t_min)
            if year not in yearly_mins or t_min < yearly_mins[year]:
                yearly_mins[year] = t_min
        if p is not None:
            monthly[month_index]["precip_sum"] += p

    years_seen = max(len(yearly_mins), 1)
    monthly_profile = []
    for index, bucket in enumerate(monthly):
        count = bucket["count"]
        avg_max = round(bucket["max_sum"] / count, 1) if count > 0 else None
        avg_min = round(bucket["min_sum"] / count, 1) if count > 0 else None
        # Precipitation is summed across all years, so divide back to a typical year.
        total_precip = round(bucket["precip_sum"] / years_seen, 1)
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

    # Average annual minimum (mean of each year's coldest day) — the basis for
    # the USDA hardiness zone, far more stable than a single year's extreme.
    avg_annual_min = (
        round(sum(yearly_mins.values()) / len(yearly_mins), 1) if yearly_mins else None
    )

    return {
        "monthlyProfile": monthly_profile,
        "estimatedHardinessZone": _estimate_hardiness_zone(avg_annual_min),
        "absoluteMinTempYear": avg_annual_min,
        "frostDates": _estimate_frost_dates(day_mins),
        "climateYears": {"start": start_year, "end": end_year, "count": years_seen},
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")

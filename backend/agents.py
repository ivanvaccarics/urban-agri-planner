"""ADK multi-agent system for the Urban Agri-Planner.

This module wires together the three competition pillars:

1. **Multi-Agent Systems** — a :class:`SequentialAgent` pipeline composed of a
   ``GeoClimateAgent`` (geolocation + climate analysis) and a ``PlannerAgent``
   (crop selection + companion planting), both ``LlmAgent`` instances powered by
   Gemma (``gemma-4-26b-a4b-it``).
2. **Model Context Protocol** — each agent reaches real tools through an
   :class:`McpToolset` connected over stdio to the Python FastMCP servers in
   ``mcp-climate-server`` and ``mcp-botanical-server``.
3. **Agent Security & Control** — the ``finalize_plant_selection`` tool is a
   human-in-the-loop checkpoint (``require_confirmation=True``). The agent run
   pauses until a human approves, rejects, or adjusts the proposed selection.

The deterministic 12-month cultivation calendar is intentionally kept as a plain
Python function (:func:`generate_calendar`) so the final plan is reproducible and
not subject to model variance.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.tools import FunctionTool
from google.adk.tools.mcp_tool import StdioConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from mcp import StdioServerParameters

MODEL = "gemma-4-26b-a4b-it"

BASE_DIR = Path(__file__).resolve().parent.parent
CLIMATE_SERVER_PATH = str(BASE_DIR / "mcp-climate-server" / "server.py")
BOTANICAL_SERVER_PATH = str(BASE_DIR / "mcp-botanical-server" / "server.py")

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

# Season -> month numbers (Northern Hemisphere). Used to flag in-season months
# in the calendar and to highlight crops whose sowing window falls in the
# user's target season.
SEASON_MONTHS = {
    "Spring": [3, 4, 5],
    "Summer": [6, 7, 8],
    "Autumn": [9, 10, 11],
    "Winter": [12, 1, 2],
}

# Degrees Celsius of night-time cold protection a greenhouse provides. Relaxes
# the cold thresholds in the calendar so a greenhouse setup extends the season.
GREENHOUSE_TEMP_BUFFER = 5

# Tool names exposed by each MCP server (used for event capture in main.py).
CLIMATE_TOOLS = ["get_coordinates", "get_climate_data"]
BOTANICAL_TOOLS = ["get_compatible_plants", "check_companion_planting", "get_crop_details"]
FINALIZE_TOOL_NAME = "finalize_plant_selection"


# --------------------------------------------------------------------------- #
# MCP toolsets — one stdio connection per Python FastMCP server.
# `sys.executable` is the interpreter running the backend (the project venv),
# which already has `mcp` and `httpx` installed.
# --------------------------------------------------------------------------- #
climate_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=[CLIMATE_SERVER_PATH],
        ),
        timeout=30.0,
    ),
    tool_filter=CLIMATE_TOOLS,
)

botanical_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=[BOTANICAL_SERVER_PATH],
        ),
        timeout=30.0,
    ),
    tool_filter=BOTANICAL_TOOLS,
)


# --------------------------------------------------------------------------- #
# Human-in-the-loop checkpoint tool.
# --------------------------------------------------------------------------- #
def finalize_plant_selection(
    plant_ids: list[str],
    rationale: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Submit the proposed crop selection for human approval.

    This tool is gated by ``require_confirmation=True``. On the first call ADK
    pauses the run and emits a confirmation request instead of executing this
    body. Once a human approves, the body runs and may receive an adjusted plant
    list through ``tool_context.tool_confirmation.payload``.

    Args:
        plant_ids: The plant IDs the agent proposes to cultivate.
        rationale: A short explanation of why these plants were chosen.

    Returns:
        The approved selection, including any human edits.
    """
    confirmation = tool_context.tool_confirmation
    final_ids = list(plant_ids)
    if confirmation is not None and isinstance(confirmation.payload, dict):
        edited = confirmation.payload.get("plantIds")
        if edited:
            final_ids = list(edited)

    return {
        "approved": True,
        "proposedPlantIds": list(plant_ids),
        "finalPlantIds": final_ids,
        "rationale": rationale,
    }


finalize_tool = FunctionTool(finalize_plant_selection, require_confirmation=True)


# --------------------------------------------------------------------------- #
# Agents.
# --------------------------------------------------------------------------- #
_DETERMINISTIC_CONFIG = types.GenerateContentConfig(temperature=0.0)

GeoClimateAgent = LlmAgent(
    name="GeoClimateAgent",
    model=MODEL,
    description="Geolocates an address and analyses its historical climate.",
    instruction=(
        "You are the **Coordinator** agent of an urban-gardening planning system.\n"
        "The user's message provides: an address, the available hours of direct "
        "sunlight, and the balcony/terrace exposure.\n\n"
        "Do the following IN ORDER and never invent data:\n"
        "1. Call `get_coordinates` with the address to obtain latitude, longitude "
        "and the resolved location name.\n"
        "2. Call `get_climate_data` with that latitude and longitude to obtain the "
        "12-month climate profile, the estimated USDA hardiness zone and the "
        "yearly minimum temperature.\n\n"
        "You MUST call both tools before writing any answer.\n\n"
        "After both tool calls succeed, write a concise summary **in English** "
        "(2-4 sentences) describing the resolved location, the estimated USDA "
        "hardiness zone, the coldest temperature of the year, and what this climate "
        "implies for growing vegetables on a balcony. This summary is shown to the "
        "user as the Coordinator's comment."
    ),
    tools=[climate_toolset],
    generate_content_config=_DETERMINISTIC_CONFIG,
    output_key="geo_climate_summary",
)

PlannerAgent = LlmAgent(
    name="PlannerAgent",
    model=MODEL,
    description="Selects compatible crops and plans companion planting, with human approval.",
    instruction=(
        "You are the **Planner** agent of an urban-gardening planning system.\n"
        "The conversation already contains the resolved location and climate "
        "profile produced by the Coordinator. The original user message provides "
        "the available hours of direct sunlight and the exposure.\n\n"
        "Do the following IN ORDER:\n"
        "1. Call `get_compatible_plants` with the sunlight hours and exposure from "
        "the user's message to retrieve the plants that can grow in these light "
        "conditions.\n"
        "2. From the returned `plants`, choose up to 5 that best fit the climate and "
        "the user's space. Prefer a diverse, companion-friendly mix.\n"
        "3. Call `check_companion_planting` with the list of chosen plant `id`s to "
        "analyse beneficial and antagonistic relationships.\n"
        "4. Call `finalize_plant_selection` with `plant_ids` (your chosen plant ids) "
        "and a short `rationale`. **This step requires explicit human "
        "approval and will pause the workflow at a security checkpoint.** A human "
        "reviewer may approve your selection as-is, or adjust which plants are "
        "included.\n"
        "5. After the human approves, write a concise summary **in English** (2-4 "
        "sentences) describing the recommended pot layout and the most important "
        "companion-planting tips. This summary is shown to the user as the Planner's "
        "comment.\n\n"
        "Always call the tools in the order above. Use the exact plant `id` values "
        "returned by `get_compatible_plants`."
    ),
    tools=[botanical_toolset, finalize_tool],
    generate_content_config=_DETERMINISTIC_CONFIG,
    output_key="planner_summary",
)

root_agent = SequentialAgent(
    name="CropPlanningPipeline",
    description="Coordinator → Planner pipeline for urban crop planning.",
    sub_agents=[GeoClimateAgent, PlannerAgent],
)


def build_initial_message(
    address: str,
    sunlight_hours: float,
    exposure: str,
    season: str | None = None,
    greenhouse: bool = False,
) -> str:
    """Build the user message that seeds the agent pipeline."""
    setup = "in a greenhouse" if greenhouse else "outdoors (open air)"
    lines = [
        "Plan an urban vegetable garden with the following details:",
        f"- Address: {address}",
        f"- Hours of direct sunlight per day: {sunlight_hours}",
        f"- Exposure: {exposure}",
        f"- Growing setup: {setup}",
    ]
    if season:
        lines.append(f"- Target growing season: {season}")
        lines.append(
            f"When choosing crops, prefer those whose sowing window falls in {season}."
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Deterministic 12-month cultivation calendar (ported from the original
# orchestrator). Kept model-independent for reproducibility.
# --------------------------------------------------------------------------- #
def generate_calendar(
    selected_plants: list[dict[str, Any]],
    monthly_profile: list[dict[str, Any]],
    season: str | None = None,
    greenhouse: bool = False,
) -> list[dict[str, Any]]:
    """Generate the personalised 12-month cultivation calendar.

    For each month and each selected plant, derive concrete actions (sowing,
    protected sowing, maintenance, protection, irrigation/shading, harvest)
    from the plant's agronomic thresholds and the locally measured monthly
    temperatures.

    Args:
        selected_plants: Full plant records that the user approved.
        monthly_profile: 12 monthly climate entries from ``get_climate_data``.

    Returns:
        A list of 12 month entries, each with temperature context and actions.
    """
    monthly_calendar: list[dict[str, Any]] = []
    season_months = set(SEASON_MONTHS.get(season or "", []))
    temp_buffer = GREENHOUSE_TEMP_BUFFER if greenhouse else 0

    for month_index, month_data in enumerate(monthly_profile):
        month_num = month_index + 1
        in_season = month_num in season_months
        actions: list[dict[str, Any]] = []

        avg_max = month_data.get("averageMaxTemp")
        avg_min = month_data.get("averageMinTemp")
        total_precip = month_data.get("totalPrecipitation")

        # Without temperature data we cannot derive agronomic actions.
        if avg_max is None or avg_min is None:
            monthly_calendar.append(
                {
                    "month": MONTH_NAMES[month_index],
                    "averageMaxTemp": avg_max,
                    "averageMinTemp": avg_min,
                    "totalPrecipitation": total_precip,
                    "inSeason": in_season,
                    "actions": actions,
                }
            )
            continue

        # A greenhouse buffers night-time cold, so the plant experiences a
        # warmer effective minimum than the raw local climate.
        effective_min = avg_min + temp_buffer

        for plant in selected_plants:
            is_sowing_month = month_num in plant["sowingMonths"]
            is_harvest_month = month_num in plant["harvestMonths"]

            temp_is_ok = effective_min >= plant["tempMin"] and avg_max <= plant["tempMax"]
            temp_is_too_cold = effective_min < plant["tempMin"]
            temp_is_too_hot = avg_max > plant["tempMax"]
            # True when the greenhouse turned a too-cold month into a viable one.
            greenhouse_helped = greenhouse and avg_min < plant["tempMin"] <= effective_min

            if is_sowing_month:
                if temp_is_ok:
                    sow_text = (
                        f"Sow the {plant['name']} in a pot (min diameter "
                        f"{plant['potSizeMin']} cm). This month's local climate "
                        f"({avg_min}°C - {avg_max}°C) is ideal."
                    )
                    if greenhouse_helped:
                        sow_text += (
                            " The greenhouse keeps it warm enough to sow this early."
                        )
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Sowing",
                            "text": sow_text,
                        }
                    )
                elif temp_is_too_cold:
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Protected Sowing",
                            "text": (
                                f"Start the {plant['name']} in a sheltered seed tray "
                                f"indoors. Outdoors it is still too cold "
                                f"({avg_min}°C, minimum required: {plant['tempMin']}°C)."
                            ),
                        }
                    )

            sowing_min = min(plant["sowingMonths"])
            harvest_max = max(plant["harvestMonths"])

            is_growing_month = False
            if not is_sowing_month and not is_harvest_month:
                if sowing_min < harvest_max:
                    if sowing_min < month_num < harvest_max:
                        is_growing_month = True
                else:
                    if month_num > sowing_min or month_num < harvest_max:
                        is_growing_month = True

            if is_growing_month:
                if temp_is_too_cold:
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Protection",
                            "text": (
                                f"Protect the {plant['name']}. Minimum temperatures "
                                f"drop to {avg_min}°C (below its tolerance threshold "
                                f"of {plant['tempMin']}°C). Move the pot indoors or "
                                f"use a horticultural fleece cover."
                            ),
                        }
                    )
                elif temp_is_too_hot:
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Watering / Shading",
                            "text": (
                                f"Intense heat ({avg_max}°C). Water the "
                                f"{plant['name']} generously during the cooler hours "
                                f"(morning/evening) and consider shading it if it "
                                f"shows signs of stress."
                            ),
                        }
                    )
                else:
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Maintenance",
                            "text": (
                                f"Active growth for the {plant['name']}. Water "
                                f"regularly (needs: {plant['watering']}) and remove "
                                f"any weeds."
                            ),
                        }
                    )

            if is_harvest_month:
                if temp_is_ok or avg_min >= (plant["tempMin"] - 2):
                    actions.append(
                        {
                            "plant": plant["name"],
                            "type": "Harvest",
                            "text": (
                                f"Harvest time for the {plant['name']}! Pick the "
                                f"leaves or fruit regularly to encourage the plant "
                                f"to keep producing."
                            ),
                        }
                    )

        monthly_calendar.append(
            {
                "month": MONTH_NAMES[month_index],
                "averageMaxTemp": avg_max,
                "averageMinTemp": avg_min,
                "totalPrecipitation": total_precip,
                "inSeason": in_season,
                "actions": actions,
            }
        )

    return monthly_calendar


def empty_calendar() -> list[dict[str, Any]]:
    """Return a 12-month calendar with no actions (used when no plants apply)."""
    return [{"month": name, "actions": [], "inSeason": False} for name in MONTH_NAMES]


def _format_month_range(months: list[int]) -> str:
    """Format month numbers into compact ranges (e.g. ``[3, 4, 5] -> "Mar-May"``).

    Consecutive months collapse into a range, and a December->January wrap is
    merged so ``[12, 1, 2]`` renders as ``"Dec-Feb"``.
    """
    unique = sorted({m for m in (months or []) if 1 <= m <= 12})
    if not unique:
        return "—"

    groups: list[list[int]] = []
    for month in unique:
        if groups and month == groups[-1][-1] + 1:
            groups[-1].append(month)
        else:
            groups.append([month])

    # Merge a wrap-around (a group starting in Jan with a group ending in Dec).
    if len(groups) >= 2 and groups[0][0] == 1 and groups[-1][-1] == 12:
        groups[-1].extend(groups.pop(0))

    parts = []
    for group in groups:
        start, end = group[0], group[-1]
        parts.append(
            MONTH_ABBR[start - 1]
            if start == end
            else f"{MONTH_ABBR[start - 1]}–{MONTH_ABBR[end - 1]}"
        )
    return ", ".join(parts)


def build_planting_schedule(
    selected_plants: list[dict[str, Any]],
    season: str | None = None,
    greenhouse: bool = False,
) -> list[dict[str, Any]]:
    """Summarise, per crop, when to put it in the field and when to harvest.

    The "put in field" window is the plant's sowing window; ``inSeason`` flags the
    crops whose sowing window overlaps the user's target season.

    Args:
        selected_plants: Full plant records that the user approved.
        season: Target growing season (Spring/Summer/Autumn/Winter).
        greenhouse: Whether the crops are grown under greenhouse cover.

    Returns:
        One entry per plant with readable field-planting and harvest windows.
    """
    season_months = set(SEASON_MONTHS.get(season or "", []))
    schedule: list[dict[str, Any]] = []

    for plant in selected_plants:
        sowing = plant.get("sowingMonths", []) or []
        harvest = plant.get("harvestMonths", []) or []
        in_season = bool(season_months & set(sowing)) if season_months else False

        entry: dict[str, Any] = {
            "plant": plant["name"],
            "scientificName": plant.get("scientificName"),
            "putInField": _format_month_range(sowing),
            "harvest": _format_month_range(harvest),
            "putInFieldMonths": sorted(set(sowing)),
            "harvestMonths": sorted(set(harvest)),
            "inSeason": in_season,
            "potSizeMin": plant.get("potSizeMin"),
        }
        if greenhouse:
            entry["note"] = (
                "Greenhouse: you can usually sow a few weeks earlier and "
                "harvest later than the outdoor window shown."
            )
        schedule.append(entry)

    return schedule


def compute_companionship(selected_plants: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministically derive companion-planting relationships for a set.

    Mirrors the botanical MCP tool, but operates on the full plant records the
    orchestrator already holds. Used when assembling the final plan so the result
    stays consistent with the human-approved selection (which may differ from the
    set the agent originally analysed).

    Args:
        selected_plants: Full plant records that were approved.

    Returns:
        Dict with ``companions``, ``antagonists`` and ``warnings`` lists.
    """
    companions: list[dict[str, Any]] = []
    antagonists: list[dict[str, Any]] = []
    warnings: list[str] = []

    for i, p1 in enumerate(selected_plants):
        if p1["id"] == "mint":
            warnings.append(
                "Mint is highly invasive. We strongly recommend growing it "
                "in a separate pot, away from any other crop."
            )
        for j in range(i + 1, len(selected_plants)):
            p2 = selected_plants[j]
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

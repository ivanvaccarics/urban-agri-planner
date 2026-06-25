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

import importlib.util
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


def _load_botanical_module():
    """Import the botanical MCP server module to reuse its companion logic.

    Loading the module only constructs the ``FastMCP`` object; ``mcp.run`` is
    guarded by ``__main__`` so no server starts. This lets the orchestrator share
    the server's companion-relationship rules as a single source of truth.
    """
    spec = importlib.util.spec_from_file_location(
        "mcp_botanical_server", BOTANICAL_SERVER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_botanical = _load_botanical_module()
_compute_relationships = _botanical.compute_relationships

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
# user's target season. For Southern-Hemisphere locations the months are
# shifted by six (see :func:`resolve_season_months`).
SEASON_MONTHS = {
    "Spring": [3, 4, 5],
    "Summer": [6, 7, 8],
    "Autumn": [9, 10, 11],
    "Winter": [12, 1, 2],
}


def resolve_season_months(
    season: str | None, latitude: float | None = None
) -> list[int]:
    """Return the month numbers for a season, flipping for the hemisphere.

    The :data:`SEASON_MONTHS` table is Northern-Hemisphere. When ``latitude`` is
    negative (Southern Hemisphere) each month is shifted by six so, e.g.,
    "Spring" maps to Sep-Nov instead of Mar-May.

    Args:
        season: Target season name (Spring/Summer/Autumn/Winter), or ``None``.
        latitude: Latitude of the location; negative means Southern Hemisphere.

    Returns:
        The list of month numbers for the season in the correct hemisphere.
    """
    months = SEASON_MONTHS.get(season or "", [])
    if latitude is not None and latitude < 0 and months:
        return [((m + 5) % 12) + 1 for m in months]
    return list(months)

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


# --------------------------------------------------------------------------- #
# Follow-up advisor agent (post-plan conversational Q&A).
# A dedicated botanical toolset keeps its stdio connection independent from the
# planning pipeline's, so chat turns never contend with a plan run.
# --------------------------------------------------------------------------- #
advisor_botanical_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=[BOTANICAL_SERVER_PATH],
        ),
        timeout=30.0,
    ),
    tool_filter=BOTANICAL_TOOLS,
)

AdvisorAgent = LlmAgent(
    name="AdvisorAgent",
    model=MODEL,
    description="Answers follow-up questions about a finalised cultivation plan.",
    instruction=(
        "You are the **Garden Advisor** of an urban-gardening planning system.\n"
        "The user has already received a finalised cultivation plan. The FIRST "
        "message in this conversation contains that plan's context: the location, "
        "estimated USDA hardiness zone, target season, sunlight hours, exposure, "
        "the selected crops, and the other crops that are compatible with the "
        "user's light conditions.\n\n"
        "Answer the user's follow-up questions about their plan — substitutions, "
        "companion planting, watering, timing, pests, and general care.\n\n"
        "Rules:\n"
        "- Before making any factual claim about a specific plant, VERIFY it with "
        "the tools: use `get_crop_details` for a plant's needs, "
        "`get_compatible_plants` to confirm what suits the user's light, and "
        "`check_companion_planting` to test how plants get along.\n"
        "- If the user proposes swapping or adding a crop, check that it appears "
        "in the compatible list (light fit) and that it pairs well with the "
        "current selection, then give a clear recommendation.\n"
        "- Never invent plant data or climate figures. If something is outside the "
        "plan's data, say so plainly.\n"
        "- Reply concisely (2-5 sentences) in the SAME language the user writes in."
    ),
    tools=[advisor_botanical_toolset],
    generate_content_config=_DETERMINISTIC_CONFIG,
)

advisor_agent = AdvisorAgent


def build_advisor_context(
    plan: dict[str, Any], request_data: dict[str, Any] | None = None
) -> str:
    """Render the finalised plan into a compact context block for the advisor.

    Seeded as the first user message of a chat session so the model can answer
    follow-up questions grounded in the actual plan, without re-running the
    planning pipeline.

    Args:
        plan: The completed plan response dict (see :func:`_assemble_completed`).
        request_data: The original plan request (for sunlight/exposure).

    Returns:
        A plain-text context block.
    """
    request_data = request_data or {}
    selected = ", ".join(p["name"] for p in plan.get("selectedPlants", [])) or "none"
    compatible = ", ".join(
        p["name"] for p in plan.get("compatiblePlants", [])
    ) or "none"
    comp = plan.get("companionship", {}) or {}
    good = "; ".join(
        " + ".join(c.get("plants", [])) for c in comp.get("companions", [])
    ) or "none noted"

    lines = [
        "CONTEXT — the user's finalised cultivation plan:",
        f"- Location: {plan.get('location') or 'unknown'}",
        f"- USDA hardiness zone: {plan.get('estimatedHardinessZone') or 'unknown'}",
        f"- Target season: {plan.get('season') or 'not specified'}",
        f"- Setup: {'greenhouse' if plan.get('greenhouse') else 'outdoor'}",
        f"- Available sunlight: {request_data.get('sunlightHours', 'unknown')} h/day",
        f"- Exposure: {request_data.get('exposure', 'unknown')}",
        f"- Selected crops: {selected}",
        f"- Other crops compatible with this light: {compatible}",
        f"- Good companion pairs in the plan: {good}",
        "",
        "Use this context plus the botanical tools to answer the questions that "
        "follow. The next message is the user's first question.",
    ]
    return "\n".join(lines)


def build_chat_message(
    plan: dict[str, Any],
    request_data: dict[str, Any] | None,
    user_message: str,
    include_context: bool,
) -> str:
    """Compose a chat turn, prefixing plan context only on the first turn.

    Args:
        plan: The completed plan response dict.
        request_data: The original plan request.
        user_message: The user's question.
        include_context: Whether to prepend the plan context (first turn only).

    Returns:
        The text to send to the advisor agent for this turn.
    """
    if include_context:
        context = build_advisor_context(plan, request_data)
        return f"{context}\n\nUSER QUESTION: {user_message}"
    return user_message


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
    latitude: float | None = None,
) -> list[dict[str, Any]]:
    """Generate the personalised 12-month cultivation calendar.

    For each month and each selected plant, derive concrete actions (sowing,
    protected sowing, maintenance, protection, irrigation/shading, harvest)
    from the plant's agronomic thresholds and the locally measured monthly
    temperatures.

    Args:
        selected_plants: Full plant records that the user approved.
        monthly_profile: 12 monthly climate entries from ``get_climate_data``.
        season: Target growing season (Spring/Summer/Autumn/Winter).
        greenhouse: Whether the crops are grown under greenhouse cover.
        latitude: Location latitude; negative flips seasons to the South.

    Returns:
        A list of 12 month entries, each with temperature context and actions.
    """
    monthly_calendar: list[dict[str, Any]] = []
    season_months = set(resolve_season_months(season, latitude))
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
    latitude: float | None = None,
) -> list[dict[str, Any]]:
    """Summarise, per crop, when to put it in the field and when to harvest.

    The "put in field" window is the plant's sowing window; ``inSeason`` flags the
    crops whose sowing window overlaps the user's target season.

    Args:
        selected_plants: Full plant records that the user approved.
        season: Target growing season (Spring/Summer/Autumn/Winter).
        greenhouse: Whether the crops are grown under greenhouse cover.
        latitude: Location latitude; negative flips seasons to the South.

    Returns:
        One entry per plant with readable field-planting and harvest windows.
    """
    season_months = set(resolve_season_months(season, latitude))
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


def compute_yield_estimate(
    selected_plants: list[dict[str, Any]],
    plants_per_crop: int = 1,
) -> dict[str, Any]:
    """Estimate the seasonal harvest and grocery-cost saving of a crop set.

    Each plant record carries ``yieldKgPerPlant`` (typical full-season harvest of
    a single plant) and ``pricePerKg`` (typical retail price). This deterministic
    helper multiplies those by ``plants_per_crop`` to produce a per-crop and total
    estimate of how much produce the plan yields and what buying it would cost.

    Ornamental / companion-only plants (e.g. marigold) have a ``pricePerKg`` of 0
    and therefore contribute no monetary value, only their companion benefit.

    Args:
        selected_plants: Full plant records that the user approved.
        plants_per_crop: How many plants of each crop are assumed to be grown.

    Returns:
        Dict with per-crop ``crops`` entries plus ``totalYieldKg``,
        ``totalValueEur``, ``currency`` and an ``assumption`` note.
    """
    plants_per_crop = max(1, int(plants_per_crop or 1))
    crops: list[dict[str, Any]] = []
    total_yield = 0.0
    total_value = 0.0

    for plant in selected_plants:
        yield_per_plant = float(plant.get("yieldKgPerPlant") or 0.0)
        price_per_kg = float(plant.get("pricePerKg") or 0.0)
        crop_yield = round(yield_per_plant * plants_per_crop, 2)
        crop_value = round(crop_yield * price_per_kg, 2)
        total_yield += crop_yield
        total_value += crop_value
        crops.append(
            {
                "plant": plant["name"],
                "plantsAssumed": plants_per_crop,
                "yieldKgPerPlant": yield_per_plant,
                "yieldKg": crop_yield,
                "pricePerKg": price_per_kg,
                "valueEur": crop_value,
                "ornamental": price_per_kg == 0,
            }
        )

    return {
        "crops": crops,
        "totalYieldKg": round(total_yield, 2),
        "totalValueEur": round(total_value, 2),
        "currency": "EUR",
        "plantsPerCrop": plants_per_crop,
        "assumption": (
            f"Estimates assume {plants_per_crop} plant(s) per crop over a full "
            "growing season. Actual yields vary with care, variety, pot size and "
            "weather. Ornamental/companion plants contribute no grocery value."
        ),
    }


def compute_pest_advisory(
    selected_plants: list[dict[str, Any]],
    monthly_profile: list[dict[str, Any]] | None = None,
    season: str | None = None,
    greenhouse: bool = False,
    latitude: float | None = None,
) -> dict[str, Any]:
    """Build a deterministic pest & disease advisory for the selected crops.

    For every approved crop this surfaces its common pests/diseases (from the
    botanical DB) together with an organic remedy, and cross-references which of
    the *other* selected plants naturally help deter each pest (``deters`` field).
    It also derives a climate note: warm and/or humid in-season conditions raise
    fungal-disease and pest pressure.

    Args:
        selected_plants: Full plant records that the user approved.
        monthly_profile: Optional 12-entry climate profile (avg max temp etc.).
        season: Target growing season, used to pick the relevant months.
        greenhouse: Whether crops are grown under cover (affects humidity note).
        latitude: Location latitude; negative flips seasons to the South.

    Returns:
        Dict with ``risks`` (per-crop issues), ``protectiveAllies``,
        ``climateNote`` and general ``tips``.
    """
    # Map a deterred-pest name -> list of selected ally plant names.
    deterrents: dict[str, list[str]] = {}
    protective_allies: list[dict[str, Any]] = []
    for plant in selected_plants:
        deters = plant.get("deters") or []
        if deters:
            protective_allies.append({"plant": plant["name"], "deters": list(deters)})
            for pest_name in deters:
                deterrents.setdefault(pest_name, []).append(plant["name"])

    risks: list[dict[str, Any]] = []
    for plant in selected_plants:
        issues = []
        for issue in plant.get("pests") or []:
            allies = [a for a in deterrents.get(issue["name"], []) if a != plant["name"]]
            issues.append(
                {
                    "name": issue["name"],
                    "type": issue.get("type", "pest"),
                    "remedy": issue.get("remedy", ""),
                    "deterredBy": allies,
                }
            )
        if issues:
            risks.append({"plant": plant["name"], "issues": issues})

    # Climate note: look at the in-season months (or all months) and flag warm
    # and/or wet conditions, which raise fungal-disease and pest pressure.
    climate_note = None
    profile = monthly_profile or []
    if profile:
        season_months = set(resolve_season_months(season, latitude))
        if season_months:
            relevant = [
                m for i, m in enumerate(profile, start=1) if i in season_months
            ]
        else:
            relevant = profile
        relevant = [m for m in relevant if m.get("averageMaxTemp") is not None]
        if relevant:
            avg_max = sum(m["averageMaxTemp"] for m in relevant) / len(relevant)
            avg_precip = sum(
                (m.get("totalPrecipitation") or 0) for m in relevant
            ) / len(relevant)
            warm = avg_max >= 24
            wet = avg_precip >= 60
            if warm and wet:
                climate_note = (
                    "Warm and humid in-season conditions strongly favour fungal "
                    "diseases (blight, powdery mildew) and rapid pest build-up. "
                    "Prioritise airflow, water at the base, and inspect weekly."
                )
            elif warm:
                climate_note = (
                    "Warm in-season temperatures speed up pest reproduction "
                    "(aphids, spider mites). Inspect undersides of leaves weekly "
                    "and act early."
                )
            elif wet:
                climate_note = (
                    "Wet in-season conditions raise fungal-disease risk. Improve "
                    "airflow, avoid wetting foliage, and remove infected leaves "
                    "promptly."
                )
    if greenhouse:
        gh_note = (
            "Under greenhouse cover, ventilate daily to curb humidity-driven "
            "diseases and watch for whitefly and spider mites, which thrive in "
            "still, warm air."
        )
        climate_note = f"{climate_note} {gh_note}" if climate_note else gh_note

    tips = [
        "Inspect plants weekly and act on the first signs — early action is far easier.",
        "Encourage beneficial insects (ladybugs, lacewings) instead of broad-spectrum sprays.",
        "Water at the base and keep foliage dry to limit fungal disease.",
        "Rotate crop families each year to break pest and disease cycles.",
    ]

    return {
        "risks": risks,
        "protectiveAllies": protective_allies,
        "climateNote": climate_note,
        "tips": tips,
    }


def compute_companionship(selected_plants: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministically derive companion-planting relationships for a set.

    Delegates to :func:`compute_relationships` in the botanical MCP server so the
    backend and the MCP tool share one implementation. Used when assembling the
    final plan so the result stays consistent with the human-approved selection
    (which may differ from the set the agent originally analysed).

    Args:
        selected_plants: Full plant records that were approved.

    Returns:
        Dict with ``companions``, ``antagonists`` and ``warnings`` lists.
    """
    return _compute_relationships(selected_plants)

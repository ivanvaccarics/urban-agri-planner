"""FastAPI orchestrator for the Urban Agri-Planner.

Drives the ADK multi-agent pipeline (see :mod:`agents`) and exposes a two-step,
human-in-the-loop planning API:

* ``POST /api/plan``         — runs the pipeline until it reaches the security
  checkpoint and returns the agent's proposed crop selection for review.
* ``POST /api/plan/confirm`` — resumes the same agent session with the human's
  decision (approve / reject / adjust) and returns the final cultivation plan.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import OrderedDict
from typing import Any, Optional
from uuid import uuid4
from contextlib import asynccontextmanager

from dotenv import load_dotenv
import httpx
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# Load environment (GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI) before ADK uses it.
load_dotenv()

from google.adk.apps.app import App, ResumabilityConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

import agents
from agents import (
    build_initial_message,
    build_planting_schedule,
    compute_companionship,
    compute_pest_advisory,
    compute_yield_estimate,
    empty_calendar,
    generate_calendar,
    root_agent,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend-orchestrator")

APP_NAME = "urban-agri-planner"
USER_ID = "local-user"
CONFIRMATION_FC_NAME = "adk_request_confirmation"

# Session capture store bounds (single-process; swap for Redis to scale out).
SESSION_TTL_SECONDS = 60 * 30
SESSION_MAX_ENTRIES = 200

VALID_EXPOSURES = {
    "South", "East", "West", "North",
    "South-East", "South-West", "North-East", "North-West",
}
VALID_SEASONS = {"Spring", "Summer", "Autumn", "Winter"}


class SessionStore:
    """In-memory capture store with TTL expiry and an LRU-style size cap.

    Bounds memory growth: entries older than the TTL are purged on access and
    the least-recently-used entries are evicted once the cap is exceeded. This
    is process-local — replace with a shared store (e.g. Redis) to run multiple
    workers or scale horizontally.
    """

    def __init__(
        self,
        ttl_seconds: int = SESSION_TTL_SECONDS,
        max_entries: int = SESSION_MAX_ENTRIES,
    ) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._data: "OrderedDict[str, tuple[float, dict[str, Any]]]" = OrderedDict()

    def _purge_expired(self) -> None:
        cutoff = time.monotonic() - self._ttl
        stale = [key for key, (ts, _) in self._data.items() if ts < cutoff]
        for key in stale:
            del self._data[key]

    def set(self, key: str, value: dict[str, Any]) -> None:
        self._purge_expired()
        self._data[key] = (time.monotonic(), value)
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def get(self, key: str) -> Optional[dict[str, Any]]:
        self._purge_expired()
        item = self._data.get(key)
        if item is None:
            return None
        # Refresh recency and TTL on access.
        self._data[key] = (time.monotonic(), item[1])
        self._data.move_to_end(key)
        return item[1]


class PlanRequest(BaseModel):
    address: str = Field(min_length=3, max_length=300)
    sunlightHours: float = Field(ge=0, le=24)
    exposure: str
    season: Optional[str] = None
    greenhouse: bool = False

    @field_validator("exposure")
    @classmethod
    def _validate_exposure(cls, value: str) -> str:
        if value not in VALID_EXPOSURES:
            raise ValueError(
                f"exposure must be one of {sorted(VALID_EXPOSURES)}"
            )
        return value

    @field_validator("season")
    @classmethod
    def _validate_season(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in VALID_SEASONS:
            raise ValueError(f"season must be one of {sorted(VALID_SEASONS)}")
        return value


class ConfirmRequest(BaseModel):
    sessionId: str
    functionCallId: str
    approved: bool
    plantIds: Optional[list[str]] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session_service = InMemorySessionService()
    # Wrap the pipeline in a resumable App so the SequentialAgent can persist
    # which sub-agent paused at the human-in-the-loop checkpoint and resume it
    # on /api/plan/confirm instead of restarting from the first agent.
    adk_app = App(
        name=APP_NAME,
        root_agent=root_agent,
        resumability_config=ResumabilityConfig(is_resumable=True),
    )
    app.state.runner = Runner(
        app=adk_app,
        session_service=app.state.session_service,
    )
    # Per-session capture store: session_id -> captured data, bounded by TTL/size.
    app.state.sessions = SessionStore()
    if not os.getenv("GOOGLE_API_KEY"):
        logger.warning(
            "GOOGLE_API_KEY is not set. The agents will fail to call Gemini. "
            "Copy backend/.env.example to backend/.env and add your key."
        )
    logger.info("ADK Runner ready (agent=%s).", root_agent.name)
    yield
    logger.info("Shutting down orchestrator.")


app = FastAPI(title="Urban Agri-Planner Orchestrator", lifespan=lifespan)

# CORS: restrict to known frontend origins. Override via the ALLOWED_ORIGINS
# env var (comma-separated). A wildcard with credentials is invalid and unsafe,
# so credentials stay disabled (the API is stateless and token-free).
_DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# --------------------------------------------------------------------------- #
# Event capture helpers.
# --------------------------------------------------------------------------- #
def _safe(value: Any) -> Any:
    """Best-effort JSON-serializable copy of arbitrary tool args."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _extract_payload(response: Any) -> Any:
    """Decode the payload of a function_response from an ADK event.

    MCP tool results arrive as a serialized ``CallToolResult``
    (``{"content": [...], "structuredContent": {...}, "isError": ...}``); plain
    ``FunctionTool`` results arrive as the returned dict directly.
    """
    if not isinstance(response, dict):
        return response

    structured = response.get("structuredContent")
    if structured is not None:
        if isinstance(structured, dict) and set(structured.keys()) == {"result"}:
            return structured["result"]
        return structured

    content = response.get("content")
    if isinstance(content, list) and content:
        first = content[0]
        text = first.get("text") if isinstance(first, dict) else getattr(first, "text", None)
        if text:
            try:
                return json.loads(text)
            except (json.JSONDecodeError, ValueError):
                return {"text": text}

    return response


def _new_capture(request: PlanRequest) -> dict[str, Any]:
    return {
        "request": request.model_dump(),
        "tool_outputs": {},
        "agent_text": {},
        "steps": [],
        "confirmation": None,
    }


def _capture_event(event: Any, captured: dict[str, Any]) -> None:
    """Fold a single ADK event into the per-session capture store."""
    content = getattr(event, "content", None)
    parts = (getattr(content, "parts", None) or []) if content else []
    author = getattr(event, "author", None) or "agent"

    for part in parts:
        text = getattr(part, "text", None)
        if text and text.strip():
            captured["agent_text"].setdefault(author, []).append(text.strip())
            captured["steps"].append(
                {"agent": author, "type": "message", "message": text.strip()}
            )

        fc = getattr(part, "function_call", None)
        if fc is not None:
            if fc.name == CONFIRMATION_FC_NAME:
                original = (fc.args or {}).get("originalFunctionCall", {}) or {}
                orig_args = original.get("args", {}) or {}
                captured["confirmation"] = {
                    "functionCallId": fc.id,
                    "proposedPlantIds": list(orig_args.get("plant_ids", []) or []),
                    "rationale": orig_args.get("rationale"),
                }
                captured["steps"].append(
                    {
                        "agent": author,
                        "type": "checkpoint",
                        "message": (
                            "Security checkpoint: waiting for human approval "
                            "of the proposed plant selection."
                        ),
                    }
                )
            else:
                captured["steps"].append(
                    {
                        "agent": author,
                        "type": "tool_call",
                        "tool": fc.name,
                        "message": f"Calling MCP tool «{fc.name}».",
                        "args": _safe(fc.args),
                    }
                )

        fr = getattr(part, "function_response", None)
        if fr is not None and fr.name != CONFIRMATION_FC_NAME:
            payload = _extract_payload(fr.response)
            captured["tool_outputs"][fr.name] = payload
            captured["steps"].append(
                {
                    "agent": author,
                    "type": "tool_result",
                    "tool": fr.name,
                    "message": f"Result received from «{fr.name}».",
                }
            )


async def _agent_comment(
    session_id: str, key: str, captured: dict[str, Any], author: str
) -> Optional[str]:
    """Read an agent's summary from session state, falling back to captured text."""
    session = await app.state.session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    if session and session.state.get(key):
        return session.state[key]
    texts = captured["agent_text"].get(author)
    return "\n\n".join(texts) if texts else None


def _climate_summary(captured: dict[str, Any]) -> dict[str, Any]:
    geo = captured["tool_outputs"].get("get_coordinates", {}) or {}
    clim = captured["tool_outputs"].get("get_climate_data", {}) or {}
    return {
        "location": geo.get("displayName"),
        "coordinates": {
            "latitude": geo.get("latitude"),
            "longitude": geo.get("longitude"),
        },
        "estimatedHardinessZone": clim.get("estimatedHardinessZone"),
        "absoluteMinTempYear": clim.get("absoluteMinTempYear"),
        "monthlyProfile": clim.get("monthlyProfile", []),
        "frostDates": clim.get("frostDates"),
        "climateYears": clim.get("climateYears"),
    }


def _compatible_plants(captured: dict[str, Any]) -> list[dict[str, Any]]:
    payload = captured["tool_outputs"].get("get_compatible_plants", {}) or {}
    if isinstance(payload, dict):
        return payload.get("plants", []) or []
    if isinstance(payload, list):  # defensive
        return payload
    return []


async def _run(session_id: str, message: types.Content, captured: dict[str, Any]) -> None:
    """Drive the runner to completion (or to the HITL pause) for one turn."""
    try:
        async for event in app.state.runner.run_async(
            user_id=USER_ID, session_id=session_id, new_message=message
        ):
            _capture_event(event, captured)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Agent run failed:")
        detail = str(exc)
        if "API key" in detail or "GOOGLE_API_KEY" in detail or "PERMISSION" in detail:
            detail = (
                "Gemini model call failed. Check that GOOGLE_API_KEY "
                f"is set in backend/.env. Details: {detail}"
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Error while running the agents: {detail}",
        )


# --------------------------------------------------------------------------- #
# Endpoints.
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "agent": root_agent.name,
        "geminiKeyConfigured": bool(os.getenv("GOOGLE_API_KEY")),
    }


# Address autocomplete is a plain REST proxy, NOT an MCP tool. Live typeahead
# must answer per keystroke with low latency; the MCP servers are stdio tools
# driven by the LLM agents, which is the wrong transport/latency profile for a
# browser autocomplete. We reuse the same Nominatim source the climate MCP
# server uses for `get_coordinates`, exposed here as a direct HTTP endpoint.
NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
GEO_USER_AGENT = "UrbanAgriPlanner/1.0 (contact: support@urbanagriplanner.local)"

# Short-term forecast (next 7 days) drives the watering advice in the final
# plan. Unlike the historical climate used for crop selection, this is a live
# REST call so the recommendation reflects upcoming rainfall.
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


async def _fetch_watering_advice(
    latitude: Optional[float], longitude: Optional[float]
) -> Optional[dict[str, Any]]:
    """Derive watering guidance from the next 7 days of forecast precipitation.

    Returns ``None`` when coordinates are missing or the forecast is
    unavailable, so the plan degrades gracefully without it.
    """
    if latitude is None or longitude is None:
        return None
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "daily": "precipitation_sum,temperature_2m_max",
        "forecast_days": 7,
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(OPEN_METEO_FORECAST_URL, params=params)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # noqa: BLE001 - advice is best-effort
        logger.warning("Watering advice fetch failed: %s", exc)
        return None

    daily = data.get("daily", {}) or {}
    precip = [p for p in (daily.get("precipitation_sum") or []) if p is not None]
    tmax = [t for t in (daily.get("temperature_2m_max") or []) if t is not None]
    if not precip:
        return None

    total_precip = round(sum(precip), 1)
    rainy_days = sum(1 for p in precip if p >= 1.0)
    avg_max = round(sum(tmax) / len(tmax), 1) if tmax else None

    if total_precip >= 15:
        advice = "Skip watering for now — significant rain is expected over the next 7 days."
        level = "low"
    elif total_precip >= 5:
        advice = (
            "Light watering only — some rain is forecast this week. "
            "Check soil moisture before watering."
        )
        level = "moderate"
    else:
        advice = "Water regularly — little to no rain is forecast over the next 7 days."
        level = "high"

    if avg_max is not None and avg_max >= 28:
        advice += (
            " High temperatures expected, so water early morning or evening "
            "to reduce evaporation."
        )

    return {
        "advice": advice,
        "level": level,
        "forecastDays": len(precip),
        "totalPrecipitationMm": total_precip,
        "rainyDays": rainy_days,
        "avgMaxTempC": avg_max,
    }


# Cache + rate-limit for the proxy. Nominatim's usage policy asks for at most
# one request per second and caching of results; we honour both so a burst of
# keystrokes cannot hammer the upstream service or get us blocked.
GEO_CACHE_TTL_SECONDS = 60 * 60
GEO_CACHE_MAX_ENTRIES = 500
NOMINATIM_MIN_INTERVAL = 1.0

_geo_cache: "OrderedDict[str, tuple[float, list[dict[str, Any]]]]" = OrderedDict()
_geo_rate_lock = asyncio.Lock()
_geo_last_call_monotonic = 0.0


def _geo_cache_get(key: str) -> Optional[list[dict[str, Any]]]:
    item = _geo_cache.get(key)
    if item is None:
        return None
    ts, value = item
    if time.monotonic() - ts > GEO_CACHE_TTL_SECONDS:
        del _geo_cache[key]
        return None
    _geo_cache.move_to_end(key)
    return value


def _geo_cache_set(key: str, value: list[dict[str, Any]]) -> None:
    _geo_cache[key] = (time.monotonic(), value)
    _geo_cache.move_to_end(key)
    while len(_geo_cache) > GEO_CACHE_MAX_ENTRIES:
        _geo_cache.popitem(last=False)


@app.get("/api/address/suggestions")
async def address_suggestions(q: str = "") -> dict[str, Any]:
    """Return up to 5 address suggestions for the given query string."""
    global _geo_last_call_monotonic
    query = (q or "").strip()
    if len(query) < 3:
        return {"suggestions": []}

    cache_key = query.lower()
    cached = _geo_cache_get(cache_key)
    if cached is not None:
        return {"suggestions": cached}

    params = {"format": "json", "q": query, "limit": 5, "addressdetails": 0}
    try:
        # Serialise upstream calls and enforce the 1 req/s usage policy.
        async with _geo_rate_lock:
            wait = NOMINATIM_MIN_INTERVAL - (
                time.monotonic() - _geo_last_call_monotonic
            )
            if wait > 0:
                await asyncio.sleep(wait)
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    NOMINATIM_SEARCH_URL,
                    params=params,
                    headers={"User-Agent": GEO_USER_AGENT},
                )
                response.raise_for_status()
                data = response.json()
            _geo_last_call_monotonic = time.monotonic()
    except Exception as exc:  # noqa: BLE001 - autocomplete must degrade gracefully
        logger.warning("Address suggestions failed: %s", exc)
        return {"suggestions": []}

    suggestions = [
        {
            "displayName": item.get("display_name"),
            "latitude": float(item["lat"]),
            "longitude": float(item["lon"]),
        }
        for item in data
        if item.get("display_name") and item.get("lat") and item.get("lon")
    ]
    _geo_cache_set(cache_key, suggestions)
    return {"suggestions": suggestions}


@app.post("/api/plan")
async def create_plan(request: PlanRequest) -> dict[str, Any]:
    """Run the pipeline up to the human-in-the-loop checkpoint."""
    session_id = uuid4().hex
    await app.state.session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    captured = _new_capture(request)
    app.state.sessions.set(session_id, captured)

    message = types.Content(
        role="user",
        parts=[
            types.Part(
                text=build_initial_message(
                    request.address,
                    request.sunlightHours,
                    request.exposure,
                    season=request.season,
                    greenhouse=request.greenhouse,
                )
            )
        ],
    )
    await _run(session_id, message, captured)

    climate = _climate_summary(captured)
    compatible = _compatible_plants(captured)
    coordinator_comment = await _agent_comment(
        session_id, "geo_climate_summary", captured, "GeoClimateAgent"
    )
    confirmation = captured.get("confirmation")

    if confirmation is None:
        # The pipeline finished without reaching the checkpoint (e.g. no plants
        # matched, or the model skipped finalization). Return a best-effort plan
        # so the UI never gets stuck.
        return await _assemble_completed(
            session_id=session_id,
            captured=captured,
            selected_ids=[p["id"] for p in compatible[:4]],
            approved=False,
            checkpoint_skipped=True,
            coordinator_comment=coordinator_comment,
            planner_comment=await _agent_comment(
                session_id, "planner_summary", captured, "PlannerAgent"
            ),
        )

    proposed_ids = confirmation["proposedPlantIds"]
    proposed_plants = [p for p in compatible if p["id"] in proposed_ids]

    return {
        "status": "confirmation_required",
        "sessionId": session_id,
        "functionCallId": confirmation["functionCallId"],
        "proposedPlantIds": proposed_ids,
        "proposedPlants": proposed_plants,
        "rationale": confirmation.get("rationale"),
        "compatiblePlants": compatible,
        "location": climate["location"],
        "coordinates": climate["coordinates"],
        "estimatedHardinessZone": climate["estimatedHardinessZone"],
        "absoluteMinTempYear": climate["absoluteMinTempYear"],
        "frostDates": climate["frostDates"],
        "climateYears": climate["climateYears"],
        "coordinatorComment": coordinator_comment,
        "season": request.season,
        "greenhouse": request.greenhouse,
        "steps": captured["steps"],
        "checkpoint": {
            "title": "Human approval required",
            "message": (
                "The Planner agent has proposed a plant selection. "
                "Approve, modify, or reject the selection before the "
                "cultivation plan is generated."
            ),
            "tool": agents.FINALIZE_TOOL_NAME,
        },
    }


@app.post("/api/plan/confirm")
async def confirm_plan(request: ConfirmRequest) -> dict[str, Any]:
    """Resume the paused agent session with the human's decision."""
    captured = app.state.sessions.get(request.sessionId)
    if captured is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or expired. Please restart the planning.",
        )

    confirmation_response: dict[str, Any] = {"confirmed": bool(request.approved)}
    if request.plantIds is not None:
        confirmation_response["payload"] = {"plantIds": request.plantIds}

    resume_message = types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    id=request.functionCallId,
                    name=CONFIRMATION_FC_NAME,
                    response=confirmation_response,
                )
            )
        ],
    )
    await _run(request.sessionId, resume_message, captured)

    planner_comment = await _agent_comment(
        request.sessionId, "planner_summary", captured, "PlannerAgent"
    )
    coordinator_comment = await _agent_comment(
        request.sessionId, "geo_climate_summary", captured, "GeoClimateAgent"
    )

    if not request.approved:
        return {
            "status": "rejected",
            "sessionId": request.sessionId,
            "message": (
                "Selection rejected at the security checkpoint. No plan was "
                "generated. Adjust the criteria or restart the planning."
            ),
            "compatiblePlants": _compatible_plants(captured),
            "coordinatorComment": coordinator_comment,
            "steps": captured["steps"],
        }

    finalize = captured["tool_outputs"].get(agents.FINALIZE_TOOL_NAME, {}) or {}
    final_ids = finalize.get("finalPlantIds")
    if not final_ids:
        final_ids = request.plantIds or (captured.get("confirmation") or {}).get(
            "proposedPlantIds", []
        )

    return await _assemble_completed(
        session_id=request.sessionId,
        captured=captured,
        selected_ids=final_ids,
        approved=True,
        checkpoint_skipped=False,
        coordinator_comment=coordinator_comment,
        planner_comment=planner_comment,
    )


async def _assemble_completed(
    *,
    session_id: str,
    captured: dict[str, Any],
    selected_ids: list[str],
    approved: bool,
    checkpoint_skipped: bool,
    coordinator_comment: Optional[str],
    planner_comment: Optional[str],
) -> dict[str, Any]:
    """Build the final cultivation-plan response (frontend contract)."""
    climate = _climate_summary(captured)
    compatible = _compatible_plants(captured)
    selected = [p for p in compatible if p["id"] in (selected_ids or [])]

    request_data = captured.get("request", {}) or {}
    season = request_data.get("season")
    greenhouse = bool(request_data.get("greenhouse"))
    latitude = (climate.get("coordinates") or {}).get("latitude")

    monthly_profile = climate["monthlyProfile"]
    if selected and monthly_profile:
        monthly_calendar = generate_calendar(
            selected,
            monthly_profile,
            season=season,
            greenhouse=greenhouse,
            latitude=latitude,
        )
    else:
        monthly_calendar = empty_calendar()

    planting_schedule = build_planting_schedule(
        selected, season=season, greenhouse=greenhouse, latitude=latitude
    )
    companionship = compute_companionship(selected)
    yield_estimate = compute_yield_estimate(selected)
    pest_advisory = compute_pest_advisory(
        selected,
        monthly_profile=monthly_profile,
        season=season,
        greenhouse=greenhouse,
        latitude=latitude,
    )
    proposed_ids = (captured.get("confirmation") or {}).get("proposedPlantIds", [])
    final_ids = [p["id"] for p in selected]
    coordinates = climate.get("coordinates") or {}
    watering_advice = await _fetch_watering_advice(
        coordinates.get("latitude"), coordinates.get("longitude")
    )

    return {
        "status": "completed",
        "sessionId": session_id,
        "location": climate["location"],
        "coordinates": climate["coordinates"],
        "estimatedHardinessZone": climate["estimatedHardinessZone"],
        "absoluteMinTempYear": climate["absoluteMinTempYear"],
        "frostDates": climate["frostDates"],
        "climateYears": climate["climateYears"],
        "wateringAdvice": watering_advice,
        "steps": captured["steps"],
        "compatiblePlants": compatible,
        "selectedPlants": selected,
        "companionship": companionship,
        "yieldEstimate": yield_estimate,
        "pestAdvisory": pest_advisory,
        "monthlyCalendar": monthly_calendar,
        "plantingSchedule": planting_schedule,
        "season": season,
        "greenhouse": greenhouse,
        "coordinatorComment": coordinator_comment,
        "plannerComment": planner_comment,
        "security": {
            "humanApproved": approved,
            "checkpointSkipped": checkpoint_skipped,
            "proposedPlantIds": proposed_ids,
            "finalPlantIds": final_ids,
            "adjusted": bool(proposed_ids) and sorted(proposed_ids) != sorted(final_ids),
            "mechanism": "ADK FunctionTool require_confirmation (human-in-the-loop)",
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=5001, reload=False)

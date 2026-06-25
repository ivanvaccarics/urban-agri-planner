"""Integration tests for the Urban Agri-Planner backend.

These tests exercise the **two-step, human-in-the-loop** planning API end to
end — including the real FastMCP servers (climate + botanical) spawned over
stdio by the ADK ``McpToolset`` — **without needing a Gemini API key**.

The Gemini model is replaced by :class:`ScriptedModel`, a deterministic
``BaseLlm`` that decides the next tool call from the request state. This keeps
the multi-agent orchestration, the MCP tool execution and the security
checkpoint (ADK ``FunctionTool`` ``require_confirmation``) fully real while
making the model's decisions reproducible.

Run directly (no pytest required)::

    PYTHONPATH=. .venv/bin/python test_backend.py

The real MCP servers make live calls to Nominatim and Open-Meteo, so an
internet connection is required.

To instead test against a live Gemini model, set ``GOOGLE_API_KEY`` in
``backend/.env``, start the server (``uvicorn main:app --port 5001``) and drive
``POST /api/plan`` then ``POST /api/plan/confirm`` from your HTTP client.
"""

from __future__ import annotations

import sys
from typing import AsyncGenerator

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

# --------------------------------------------------------------------------- #
# Test fixtures: a deterministic, scripted stand-in for the Gemini model.
# --------------------------------------------------------------------------- #
TEST_ADDRESS = "Milan, Italy"
TEST_SUNLIGHT = 6.0
TEST_EXPOSURE = "South"
MILANO_LAT = 45.4641
MILANO_LON = 9.1896
PROPOSED_IDS = ["tomato", "basil"]
ADJUSTED_IDS = ["tomato", "lettuce"]


def _fc(name: str, **args) -> types.Content:
    return types.Content(
        role="model",
        parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))],
    )


def _txt(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])


class ScriptedModel(BaseLlm):
    """Decides the next action from the tools available and the calls already made.

    Stateless with respect to sessions (it inspects each ``LlmRequest``), so a
    single instance safely drives many independent plan/confirm cycles. The
    decision logic is self-terminating per session: ``done`` grows with each
    executed tool until the agent emits its closing summary.
    """

    model: str = "scripted-test"

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        tools = set(llm_request.tools_dict.keys())
        done: set[str] = set()
        for content in llm_request.contents:
            for part in content.parts or []:
                fr = getattr(part, "function_response", None)
                if fr is not None:
                    done.add(fr.name)

        yield LlmResponse(content=self._decide(tools, done))

    @staticmethod
    def _decide(tools: set[str], done: set[str]) -> types.Content:
        # ReviewerAgent: has submit_review. Verify companions, then submit.
        if "submit_review" in tools:
            if "check_companion_planting" not in done:
                return _fc("check_companion_planting", plantIds=list(PROPOSED_IDS))
            if "submit_review" not in done:
                return _fc(
                    "submit_review",
                    score=82,
                    verdict="Solid, climate-appropriate companion selection.",
                    strengths=["Tomato and basil are strong companions", "Good climate fit"],
                    concerns=["Limited leafy-green diversity"],
                    suggestions=["Consider adding lettuce for a quicker harvest"],
                )
            return _txt("Review complete.")

        # AdvisorAgent (follow-up chat): has get_crop_details but no finalize tool.
        # Re-validate one crop via a tool, then answer in text.
        if "get_crop_details" in tools and "finalize_plant_selection" not in tools:
            if "get_crop_details" not in done:
                return _fc("get_crop_details", plantId="lettuce")
            return _txt(
                "Lettuce is a good shade-tolerant swap and pairs well with your "
                "tomatoes. Go ahead and try it."
            )

        # GeoClimateAgent: geocode, then fetch climate, then summarise.
        if "get_coordinates" in tools:
            if "get_coordinates" not in done:
                return _fc("get_coordinates", address=TEST_ADDRESS)
            if "get_climate_data" not in done:
                return _fc(
                    "get_climate_data", latitude=MILANO_LAT, longitude=MILANO_LON
                )
            return _txt("Coordinator: Milan analysed, climate data collected.")

        # PlannerAgent: match plants, check companions, finalise (HITL pause).
        if "get_compatible_plants" in tools:
            if "get_compatible_plants" not in done:
                return _fc(
                    "get_compatible_plants",
                    sunlightHours=TEST_SUNLIGHT,
                    exposure=TEST_EXPOSURE,
                )
            if "check_companion_planting" not in done:
                return _fc("check_companion_planting", plantIds=list(PROPOSED_IDS))
            if "finalize_plant_selection" not in done:
                return _fc(
                    "finalize_plant_selection",
                    plant_ids=list(PROPOSED_IDS),
                    rationale="Tomato and basil are excellent companion crops.",
                )
            return _txt("Planner: cultivation plan finalised.")

        return _txt("Planning complete.")


def _install_scripted_model() -> None:
    """Replace both agents' Gemini model with the scripted one (before app start)."""
    import agents

    model = ScriptedModel()
    agents.GeoClimateAgent.model = model
    agents.PlannerAgent.model = model
    agents.AdvisorAgent.model = model
    agents.ReviewerAgent.model = model


# --------------------------------------------------------------------------- #
# Lightweight assertion helper (no pytest dependency required).
# --------------------------------------------------------------------------- #
def _check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


# --------------------------------------------------------------------------- #
# Tests.
# --------------------------------------------------------------------------- #
def test_health(client) -> None:
    resp = client.get("/api/health")
    _check(resp.status_code == 200, f"health status {resp.status_code}")
    data = resp.json()
    _check(data.get("status") == "ok", "health status not ok")
    _check("agent" in data, "health missing agent name")


def _start_plan(client) -> dict:
    resp = client.post(
        "/api/plan",
        json={
            "address": TEST_ADDRESS,
            "sunlightHours": TEST_SUNLIGHT,
            "exposure": TEST_EXPOSURE,
        },
    )
    _check(resp.status_code == 200, f"/api/plan status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(
        data.get("status") == "confirmation_required",
        f"expected confirmation_required, got {data.get('status')}",
    )
    _check(bool(data.get("sessionId")), "missing sessionId")
    _check(bool(data.get("functionCallId")), "missing functionCallId")
    _check(
        data.get("proposedPlantIds") == PROPOSED_IDS,
        f"unexpected proposedPlantIds: {data.get('proposedPlantIds')}",
    )
    compatible_ids = {p["id"] for p in data.get("compatiblePlants", [])}
    _check(
        len(compatible_ids) > 0,
        "expected at least one compatible plant",
    )
    _check(
        set(PROPOSED_IDS).issubset(compatible_ids),
        f"proposed ids {PROPOSED_IDS} not all present in compatible plants",
    )
    _check(bool(data.get("location")), "missing location from climate agent")
    _check(
        data.get("estimatedHardinessZone") is not None,
        "missing estimatedHardinessZone",
    )
    _check(bool(data.get("checkpoint")), "missing security checkpoint block")
    review = data.get("review")
    _check(review is not None, "missing reviewer critique at checkpoint")
    _check(
        isinstance(review.get("score"), int) and 0 <= review["score"] <= 100,
        f"reviewer score should be an int 0-100, got {review.get('score')}",
    )
    _check(bool(review.get("verdict")), "reviewer verdict should not be empty")
    return data


def test_plan_then_approve(client) -> None:
    plan = _start_plan(client)
    resp = client.post(
        "/api/plan/confirm",
        json={
            "sessionId": plan["sessionId"],
            "functionCallId": plan["functionCallId"],
            "approved": True,
            "plantIds": plan["proposedPlantIds"],
        },
    )
    _check(resp.status_code == 200, f"confirm status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(data.get("status") == "completed", f"expected completed, got {data.get('status')}")
    selected = [p["id"] for p in data.get("selectedPlants", [])]
    _check(selected == PROPOSED_IDS, f"selectedPlants mismatch: {selected}")
    _check(
        len(data.get("monthlyCalendar", [])) == 12,
        f"monthlyCalendar must have 12 months, got {len(data.get('monthlyCalendar', []))}",
    )
    security = data.get("security", {})
    _check(security.get("humanApproved") is True, "security.humanApproved must be True")
    _check(security.get("checkpointSkipped") is False, "checkpoint should not be skipped")
    _check(security.get("adjusted") is False, "selection should not be marked adjusted")
    _check(bool(data.get("companionship")), "missing companionship block")


def test_plan_with_season_and_greenhouse(client) -> None:
    """Season + greenhouse flow: inputs echo back and a planting schedule is built."""
    resp = client.post(
        "/api/plan",
        json={
            "address": TEST_ADDRESS,
            "sunlightHours": TEST_SUNLIGHT,
            "exposure": TEST_EXPOSURE,
            "season": "Spring",
            "greenhouse": True,
        },
    )
    _check(resp.status_code == 200, f"/api/plan status {resp.status_code}: {resp.text}")
    plan = resp.json()
    _check(
        plan.get("status") == "confirmation_required",
        f"expected confirmation_required, got {plan.get('status')}",
    )
    _check(plan.get("season") == "Spring", f"season not echoed: {plan.get('season')}")
    _check(plan.get("greenhouse") is True, f"greenhouse not echoed: {plan.get('greenhouse')}")

    resp = client.post(
        "/api/plan/confirm",
        json={
            "sessionId": plan["sessionId"],
            "functionCallId": plan["functionCallId"],
            "approved": True,
            "plantIds": plan["proposedPlantIds"],
        },
    )
    _check(resp.status_code == 200, f"confirm status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(data.get("status") == "completed", f"expected completed, got {data.get('status')}")
    _check(data.get("season") == "Spring", "completed plan should echo season")
    _check(data.get("greenhouse") is True, "completed plan should echo greenhouse")

    schedule = data.get("plantingSchedule", [])
    _check(
        len(schedule) == len(PROPOSED_IDS),
        f"plantingSchedule should have one entry per selected crop, got {len(schedule)}",
    )
    for entry in schedule:
        for key in ("plant", "putInField", "harvest", "inSeason"):
            _check(key in entry, f"plantingSchedule entry missing '{key}': {entry}")
        _check(
            bool(entry.get("note")),
            "greenhouse schedule entries should include a note",
        )
    _check(
        any(entry.get("inSeason") for entry in schedule),
        "at least one Spring-sown crop should be flagged inSeason",
    )

    calendar = data.get("monthlyCalendar", [])
    _check(len(calendar) == 12, f"monthlyCalendar must have 12 months, got {len(calendar)}")
    _check(
        all("inSeason" in month for month in calendar),
        "every calendar month should carry an inSeason flag",
    )


def test_plan_then_adjust(client) -> None:
    plan = _start_plan(client)
    resp = client.post(
        "/api/plan/confirm",
        json={
            "sessionId": plan["sessionId"],
            "functionCallId": plan["functionCallId"],
            "approved": True,
            "plantIds": ADJUSTED_IDS,  # human edits the agent's proposal
        },
    )
    _check(resp.status_code == 200, f"confirm status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(data.get("status") == "completed", f"expected completed, got {data.get('status')}")
    selected = [p["id"] for p in data.get("selectedPlants", [])]
    _check(sorted(selected) == sorted(ADJUSTED_IDS), f"adjusted selection mismatch: {selected}")
    security = data.get("security", {})
    _check(security.get("humanApproved") is True, "security.humanApproved must be True")
    _check(security.get("adjusted") is True, "selection should be marked adjusted")
    _check(
        sorted(security.get("finalPlantIds", [])) == sorted(ADJUSTED_IDS),
        "security.finalPlantIds should reflect the human edit",
    )


def test_plan_then_reject(client) -> None:
    plan = _start_plan(client)
    resp = client.post(
        "/api/plan/confirm",
        json={
            "sessionId": plan["sessionId"],
            "functionCallId": plan["functionCallId"],
            "approved": False,
        },
    )
    _check(resp.status_code == 200, f"confirm status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(data.get("status") == "rejected", f"expected rejected, got {data.get('status')}")
    _check("selectedPlants" not in data, "rejected plan must not contain selectedPlants")


def test_plan_then_chat(client) -> None:
    """After a plan is approved, the follow-up advisor answers a question."""
    plan = _start_plan(client)
    confirm = client.post(
        "/api/plan/confirm",
        json={
            "sessionId": plan["sessionId"],
            "functionCallId": plan["functionCallId"],
            "approved": True,
            "plantIds": plan["proposedPlantIds"],
        },
    )
    _check(confirm.status_code == 200, f"confirm status {confirm.status_code}")

    resp = client.post(
        "/api/plan/chat",
        json={"sessionId": plan["sessionId"], "message": "Can I swap basil for lettuce?"},
    )
    _check(resp.status_code == 200, f"chat status {resp.status_code}: {resp.text}")
    data = resp.json()
    _check(bool(data.get("reply")), "advisor reply should not be empty")
    _check(
        any(s.get("type") == "tool_call" for s in data.get("steps", [])),
        "advisor should re-validate using a botanical tool",
    )

    # A follow-up turn keeps working (session memory).
    resp2 = client.post(
        "/api/plan/chat",
        json={"sessionId": plan["sessionId"], "message": "And what about watering?"},
    )
    _check(resp2.status_code == 200, f"chat follow-up status {resp2.status_code}")
    _check(bool(resp2.json().get("reply")), "follow-up reply should not be empty")


def test_chat_without_plan_404(client) -> None:
    """Chat before any finalised plan returns 404."""
    resp = client.post(
        "/api/plan/chat",
        json={"sessionId": "does-not-exist", "message": "hello"},
    )
    _check(resp.status_code == 404, f"expected 404, got {resp.status_code}")


# --------------------------------------------------------------------------- #
# Standalone runner.
# --------------------------------------------------------------------------- #
def main() -> int:
    _install_scripted_model()

    from fastapi.testclient import TestClient
    import main as backend_main

    tests = [
        test_health,
        test_plan_then_approve,
        test_plan_with_season_and_greenhouse,
        test_plan_then_adjust,
        test_plan_then_reject,
        test_plan_then_chat,
        test_chat_without_plan_404,
    ]
    passed = 0
    failed = 0
    with TestClient(backend_main.app) as client:
        for test in tests:
            name = test.__name__
            try:
                test(client)
                print(f"PASS  {name}")
                passed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"FAIL  {name}: {exc}")
                failed += 1

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

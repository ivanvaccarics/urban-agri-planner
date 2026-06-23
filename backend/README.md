# Urban Agri-Planner — Backend

FastAPI orchestrator that runs a **Google ADK multi-agent pipeline** over
**Model Context Protocol (MCP)** tool servers, gated by a **human-in-the-loop
security checkpoint**.

## The three pillars

| Pillar | Where it lives |
| --- | --- |
| **Multi-Agent Systems (Google ADK)** | [agents.py](agents.py) — a `SequentialAgent` (`CropPlanningPipeline`) chaining `GeoClimateAgent` → `PlannerAgent`, each an `LlmAgent` running `gemma-4-26b-a4b-it`. |
| **MCP servers** | [../mcp-climate-server/server.py](../mcp-climate-server/server.py) and [../mcp-botanical-server/server.py](../mcp-botanical-server/server.py) — FastMCP servers exposed to the agents via ADK's `McpToolset` over stdio. |
| **Agent Security & Control** | The `finalize_plant_selection` tool is an ADK `FunctionTool` with `require_confirmation=True`. The run **pauses** at this checkpoint; the human approves, edits, or rejects the proposed crop list before any plan is generated. |

## How it works

1. `POST /api/plan` seeds the pipeline. `GeoClimateAgent` geocodes the address
   and fetches climate data (climate MCP server); `PlannerAgent` finds
   compatible plants and checks companion planting (botanical MCP server), then
   calls `finalize_plant_selection`, which **pauses** the run for human review.
   The endpoint returns `status: "confirmation_required"` with the proposal.
2. `POST /api/plan/confirm` resumes the **same** agent session with the human's
   decision (`approved` + optional edited `plantIds`). On approval the backend
   deterministically builds the 12-month cultivation calendar and returns the
   final plan with a `security` block describing the checkpoint outcome.

Resumption relies on ADK's `ResumabilityConfig(is_resumable=True)` so the
`SequentialAgent` resumes the paused sub-agent instead of restarting.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install .            # installs dependencies from pyproject.toml
cp .env.example .env     # then add your GOOGLE_API_KEY
```

Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 5001
```

## Test

The integration tests replace Gemini with a deterministic scripted model, so
they run the **real** MCP servers and the **real** human-in-the-loop flow
without needing an API key (an internet connection is required for the live
Nominatim / Open-Meteo calls):

```bash
PYTHONPATH=. .venv/bin/python test_backend.py
```

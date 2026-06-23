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

## What the final plan includes

On approval the backend deterministically assembles:

- a **12-month cultivation calendar** and **planting schedule**, with seasons
  automatically flipped for the **Southern Hemisphere** (driven by the geocoded
  latitude);
- **companion-planting relationships**, computed via the botanical server's
  shared `compute_relationships` function (single source of truth);
- **frost dates** and the **climate window** surfaced from the climate server;
- **watering advice** derived from a live 7-day Open-Meteo forecast
  (`_fetch_watering_advice`), so the recommendation reflects upcoming rainfall;
- a `security` block recording the human-approval outcome (approved / adjusted /
  checkpoint-skipped).

## Security & scalability

- **Input validation** — `PlanRequest` validates `sunlightHours` (0–24) and
  constrains `exposure`/`season` to known enums (Pydantic validators).
- **CORS** — origins are read from the `ALLOWED_ORIGINS` env var (comma-separated;
  defaults to the local Vite dev origins). Credentials are disabled, avoiding the
  invalid wildcard-plus-credentials combination.
- **Address autocomplete proxy** — `/api/address/suggestions` is cached (TTL +
  size cap) and rate-limited to ≤ 1 request/second to honour Nominatim's usage
  policy.
- **Session store** — captured agent state is held in a bounded `SessionStore`
  with TTL expiry and an LRU-style size cap instead of an unbounded dict. Swap it
  for a shared store (e.g. Redis) to run multiple workers.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_API_KEY` | — | Gemini/Gemma model access (required for live runs). |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated CORS allow-list. |

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

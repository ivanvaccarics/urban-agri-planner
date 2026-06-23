# Urban Agri-Planner: Multi-Agent Crop Planner Walkthrough

**Urban Agri-Planner** is a multi-agent system that designs urban cultivation
plans by cross-referencing geocoding, historical microclimate and botanical
requirements. It targets the **"AI for Good" (Agriculture)** theme and is built
around three competition pillars:

1. **Multi-Agent Systems** — orchestration with the **Google Agent Development Kit (ADK)**.
2. **Model Context Protocol (MCP)** — two Python MCP servers (FastMCP) over `stdio` transport.
3. **Agent Security & Control** — a **human-in-the-loop (HITL)** checkpoint that pauses the
   agent before finalising the crops and requires explicit user approval.

---

## Project Structure

```
vibe_coding_milestone/
├── README.md                      # General project overview
├── test_mcp_servers.py            # MCP integration tests (Python stdio client)
├── mcp-climate-server/            # Climate & Geo MCP server (Python / FastMCP)
│   ├── server.py
│   ├── pyproject.toml
│   └── README.md
├── mcp-botanical-server/          # Botanical MCP server (Python / FastMCP)
│   ├── server.py
│   ├── db.json                    # Urban plant database (50 varieties)
│   ├── pyproject.toml
│   └── README.md
├── backend/                       # Multi-agent orchestrator (Google ADK + FastAPI)
│   ├── agents.py                  # ADK pipeline: SequentialAgent + MCP tools + HITL tool
│   ├── main.py                    # FastAPI: /api/plan, /api/plan/confirm, /api/health, /api/address/suggestions
│   ├── test_backend.py            # End-to-end HITL tests (ScriptedModel, no API key)
│   ├── pyproject.toml
│   ├── .env.example
│   └── README.md
└── frontend/                      # Web dashboard (Vite + React)
    ├── package.json
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx                # Two-step flow with the approval checkpoint
        └── index.css
```

---

## The Three Pillars in Detail

### Pillar 1 — Multi-Agent System (Google ADK)

The backend defines a `SequentialAgent` pipeline called **`CropPlanningPipeline`**
(`backend/agents.py`) made of two specialised `LlmAgent` instances (model
`gemma-4-26b-a4b-it`):

* **`GeoClimateAgent`** — uses the climate MCP toolset. It geocodes the address
  (`get_coordinates`), retrieves the historical microclimate (`get_climate_data`) and
  produces a geo-climate summary (`output_key="geo_climate_summary"`).
* **`PlannerAgent`** — uses the botanical MCP toolset. It filters compatible crops
  (`get_compatible_plants`), checks companion planting (`check_companion_planting`) and
  proposes the final selection through the `finalize_plant_selection` tool
  (`output_key="planner_summary"`).

The two agents run in sequence under the same ADK `Runner`; shared state flows through the
`output_key` values stored in the session.

### Pillar 2 — Model Context Protocol (MCP)

Both servers are written in Python with **FastMCP** and communicate over `stdio`; the ADK
agents connect to them as MCP clients via `McpToolset` + `StdioConnectionParams` (launching
`server.py` with the venv interpreter).

**Climate server (`mcp-climate-server/server.py`)**
* `get_coordinates(address)` → latitude/longitude via OpenStreetMap **Nominatim**.
* `get_climate_data(latitude, longitude)` → 2025 daily archive from **Open-Meteo**; computes
  a monthly profile (avg max/min, precipitation, absolute minimum) and estimates the
  **USDA hardiness zone**.

**Botanical server (`mcp-botanical-server/server.py`)**
* `get_compatible_plants(sunlightHours, exposure)` → crops compatible with the available
  sunlight (a *North* exposure applies an extra shade filter).
* `get_crop_details(plantId)` → full crop record.
* `check_companion_planting(plantIds)` → beneficial/antagonistic companions and warnings
  (e.g. mint is flagged as invasive).

### Pillar 3 — Agent Security & Control (Human-in-the-Loop)

The `finalize_plant_selection` tool is wrapped in a `FunctionTool(require_confirmation=True)`.
When the `PlannerAgent` invokes it, ADK **pauses** execution and emits a confirmation request
instead of completing the plan.

* The app is created with `App(..., resumability_config=ResumabilityConfig(is_resumable=True))`
  so the `SequentialAgent` can **resume from the paused sub-agent** instead of restarting.
* `POST /api/plan` runs the pipeline **up to the checkpoint** and returns
  `status: "confirmation_required"` with the proposed selection and the session identity.
* The user can **approve**, **edit the selection** or **reject** from the UI.
* `POST /api/plan/confirm` resumes the same session by injecting the confirmation
  `FunctionResponse` (`adk_request_confirmation`) and completes or cancels the plan.

Result: no plan is ever finalised without an explicit human approval, and any change to the
selection is recorded in the `security` block of the response.

---

## API Contract (two steps)

| Endpoint | Purpose | Returned status |
| --- | --- | --- |
| `GET /api/health` | Liveness check | `{ "status": "ok" }` |
| `GET /api/address/suggestions?q=` | Address autocomplete proxy (Nominatim) | `{ "suggestions": [...] }` |
| `POST /api/plan` | Runs the pipeline up to the HITL checkpoint | `confirmation_required` (or `completed` if no crop matches) |
| `POST /api/plan/confirm` | Resumes the session with the human decision | `completed` or `rejected` |

**`POST /api/plan`** — body: `{ address, sunlightHours, exposure }`.
`confirmation_required` response: `sessionId`, `functionCallId`, `proposedPlantIds`,
`proposedPlants`, `rationale`, `compatiblePlants`, `location`, `coordinates`,
`estimatedHardinessZone`, `absoluteMinTempYear`, `coordinatorComment`, `steps`, `checkpoint`.

**`POST /api/plan/confirm`** — body: `{ sessionId, functionCallId, approved, plantIds? }`.
`completed` response: the full plan (`monthlyCalendar`, `companionship`, `selectedPlants`,
`steps`) plus the `security` block (`humanApproved`, `adjusted`, `mechanism`,
`proposedPlantIds`, `finalPlantIds`).

The frontend (`frontend/src/App.jsx`) implements exactly this flow: it generates the plan,
shows the **security checkpoint** with the proposed crops (editable), and only after approval
renders the dashboard with the HITL outcome banner.

### Why address autocomplete is REST, not MCP

The address typeahead in the input field is served by a plain `GET /api/address/suggestions`
endpoint that proxies Nominatim directly over HTTP — it is **not** an MCP tool. The MCP
servers are `stdio` processes driven by the LLM agents: routing per-keystroke autocomplete
through the agent/model loop would be slow, costly and non-deterministic, and a browser
cannot speak the MCP stdio transport anyway. The REST endpoint reuses the same Nominatim
data source as the climate server's `get_coordinates` tool, but exposes it with the low
latency a UI autocomplete needs. MCP stays where it belongs: powering the agent pipeline.

---

## Running the Application

> Prerequisites: Python ≥ 3.10 and Node ≥ 18. A `GOOGLE_API_KEY` (Google AI Studio) is
> required for live execution with the Gemma model; the tests do not need one.

### 1. Backend (Python environment)

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e .          # installs ADK, FastAPI, MCP, etc. from pyproject.toml
cp .env.example .env                # then add GOOGLE_API_KEY to .env
.venv/bin/python main.py            # starts FastAPI on http://localhost:5001
```

### 2. Frontend (React dashboard)

```bash
cd frontend
npm install
npm run dev                         # http://localhost:5173
```

The MCP servers do **not** need to be started by hand: the ADK agents launch them
automatically as `stdio` subprocesses when needed.

---

## Tests and Validation

### MCP integration tests — `test_mcp_servers.py`

A Python `stdio` MCP client that validates both servers (protocol conformance + tools):

```bash
backend/.venv/bin/python test_mcp_servers.py
```

Covers: `tools/list` on both servers, geocoding of Milan, 2025 monthly climate data, crop
filtering for 6h South and North shade, crop details, and tomato+basil+mint companion
analysis. **8/8 passing.**

### Backend HITL tests — `backend/test_backend.py`

Uses a deterministic `ScriptedModel` in place of the Gemma model (no API key required), while
exercising the **real** MCP servers and the **real** ADK confirmation mechanism:

```bash
cd backend && PYTHONPATH=$PWD .venv/bin/python test_backend.py
```

Covers `health`, **approval**, **selection edit**, and **rejection** at the checkpoint.
**4/4 passing.**

---

## Summary

Urban Agri-Planner demonstrates the three pillars in an integrated, verifiable way: an
**ADK multi-agent** pipeline orchestrating two **Python MCP servers**, with a
**human-in-the-loop checkpoint** that guarantees human control before any final decision.

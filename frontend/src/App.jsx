import React, { useState, useEffect, useRef } from "react";

const API_BASE = "http://localhost:5001";

function App() {
  const [address, setAddress] = useState("Via Roma 10, Milan, Italy");
  const [sunlightHours, setSunlightHours] = useState(6);
  const [exposure, setExposure] = useState("South");
  const [season, setSeason] = useState("Spring");
  const [greenhouse, setGreenhouse] = useState(false);
  const [loading, setLoading] = useState(false);     // POST /api/plan in progress
  const [confirming, setConfirming] = useState(false); // POST /api/plan/confirm in progress
  const [error, setError] = useState(null);

  // Address autocomplete (debounced REST proxy to Nominatim)
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const skipNextFetch = useRef(false);

  // Workflow states
  const [displayedSteps, setDisplayedSteps] = useState([]);
  const [pendingConfirmation, setPendingConfirmation] = useState(null); // confirmation_required payload
  const [checkpointSelection, setCheckpointSelection] = useState([]);   // plant ids the human keeps at the gate
  const [planResult, setPlanResult] = useState(null);                   // completed plan
  const [rejection, setRejection] = useState(null);                     // rejected payload

  // Animate the real agent steps into the activity log for an agentic feel.
  const animateSteps = async (steps) => {
    setDisplayedSteps([]);
    for (let i = 0; i < steps.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      setDisplayedSteps((prev) => [...prev, steps[i]]);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  const resetWorkflow = () => {
    setPendingConfirmation(null);
    setPlanResult(null);
    setRejection(null);
    setDisplayedSteps([]);
    setError(null);
  };

  // Debounced address autocomplete. Queries the backend suggestions proxy
  // (a direct Nominatim REST call) ~350ms after the user stops typing.
  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const query = address.trim();
    if (query.length < 3) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/address/suggestions?q=${encodeURIComponent(query)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      } catch {
        /* autocomplete is best-effort; ignore network errors */
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [address]);

  const handleSelectSuggestion = (suggestion) => {
    skipNextFetch.current = true; // don't re-query for the value we just set
    setAddress(suggestion.displayName);
    setSuggestions([]);
    setShowSuggestions(false);
  };

  // Step 1 — run the pipeline up to the human-in-the-loop checkpoint.
  const handleGeneratePlan = async () => {
    setLoading(true);
    resetWorkflow();

    try {
      const response = await fetch(`${API_BASE}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          sunlightHours: Number(sunlightHours),
          exposure,
          season,
          greenhouse,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.error || "Unable to compute the cultivation plan.");
      }

      if (data.steps && data.steps.length > 0) {
        await animateSteps(data.steps);
      }

      if (data.status === "confirmation_required") {
        setPendingConfirmation(data);
        setCheckpointSelection(data.proposedPlantIds || []);
      } else if (data.status === "completed") {
        // The pipeline finished without a checkpoint (e.g. no plants matched).
        setPlanResult(data);
      } else {
        throw new Error("Unexpected response from the server.");
      }
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step 2 — resume the paused agent session with the human's decision.
  const handleConfirm = async (approved) => {
    if (!pendingConfirmation) return;
    setConfirming(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/plan/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: pendingConfirmation.sessionId,
          functionCallId: pendingConfirmation.functionCallId,
          approved,
          plantIds: approved ? checkpointSelection : null,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.error || "Error during confirmation.");
      }

      if (data.steps && data.steps.length > 0) {
        setDisplayedSteps(data.steps); // full log including post-approval steps
      }

      if (data.status === "completed") {
        setPlanResult(data);
        setPendingConfirmation(null);
      } else if (data.status === "rejected") {
        setRejection(data);
        setPendingConfirmation(null);
      } else {
        throw new Error("Unexpected response from the server.");
      }
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  // Toggle a plant in the checkpoint selection (no re-run; the human curates here).
  const toggleCheckpointPlant = (plantId) => {
    setCheckpointSelection((prev) =>
      prev.includes(plantId) ? prev.filter((id) => id !== plantId) : [...prev, plantId]
    );
  };

  const sameSelection = (a, b) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

  // Agent activity log helpers.
  const agentLabel = (agent) => {
    const map = {
      GeoClimateAgent: "Geo-Climate",
      PlannerAgent: "Planner",
      CropPlanningPipeline: "Pipeline",
      user: "User",
    };
    return map[agent] || agent || "Agent";
  };

  const badgeClass = (agent) => {
    if (agent === "GeoClimateAgent") return "geoclima";
    if (agent === "PlannerAgent") return "planner";
    return "system";
  };

  const stepIcon = (type) => {
    switch (type) {
      case "tool_call": return "build";
      case "tool_result": return "task_alt";
      case "checkpoint": return "verified_user";
      case "message": return "forum";
      default: return "bolt";
    }
  };

  const renderSteps = (steps) => (
    <div className="agent-steps-box">
      {steps.map((step, idx) => (
        <div key={idx} className={`agent-step ${step.type === "checkpoint" ? "is-checkpoint" : ""}`}>
          <span className={`agent-badge ${badgeClass(step.agent)}`}>{agentLabel(step.agent)}</span>
          <span className="material-symbols step-icon">{stepIcon(step.type)}</span>
          <span className="agent-message">
            {step.message}
            {step.tool && <span className="step-tool">{step.tool}</span>}
          </span>
        </div>
      ))}
    </div>
  );

  // Icon mapping helper
  const getActionIcon = (type) => {
    switch (type.toLowerCase()) {
      case "sowing":
        return <span className="material-symbols action-icon" style={{color: '#4a8c3d'}}>yard</span>;
      case "protected sowing":
        return <span className="material-symbols action-icon" style={{color: '#b07a1e'}}>roofing</span>;
      case "maintenance":
        return <span className="material-symbols action-icon" style={{color: '#4f8a45'}}>eco</span>;
      case "protection":
        return <span className="material-symbols action-icon" style={{color: '#c0403a'}}>umbrella</span>;
      case "harvest":
        return <span className="material-symbols action-icon" style={{color: '#b06a16'}}>nutrition</span>;
      case "watering / shading":
        return <span className="material-symbols action-icon" style={{color: '#1f93a3'}}>water_drop</span>;
      default:
        return <span className="material-symbols action-icon">info</span>;
    }
  };

  return (
    <div className="app-container">
      <header>
        <div className="header-eyebrow">Multi-Agent Planning System</div>
        <h1>Urban <span className="accent-word">Agri</span>-Planner</h1>
        <p>Location-aware cultivation plans for balconies and rooftops — built by AI agents that cross-reference climate history, hardiness zones, and the botanical needs of each crop.</p>
      </header>

      {/* Input panel */}
      <section className="glass-card mb-4">
        <div className="form-grid">
          <div className="input-group input-group-wide">
            <label htmlFor="address-input">Address or Location</label>
            <div className="autocomplete-wrapper">
              <input 
                id="address-input"
                type="text" 
                className="input-field" 
                value={address}
                onChange={(e) => { setAddress(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="e.g. Via Roma 10, Milan"
                autoComplete="off"
                disabled={loading}
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="suggestions-list">
                  {suggestions.map((s, idx) => (
                    <li
                      key={idx}
                      className="suggestion-item"
                      onMouseDown={() => handleSelectSuggestion(s)}
                    >
                      <span className="material-symbols suggestion-icon">location_on</span>
                      <span className="suggestion-text">{s.displayName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="sunlight-input">Direct Sunlight (hours/day)</label>
            <input 
              id="sunlight-input"
              type="number" 
              className="input-field" 
              min="0" 
              max="24"
              value={sunlightHours}
              onChange={(e) => setSunlightHours(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="input-group">
            <label htmlFor="exposure-select">Balcony Exposure</label>
            <select 
              id="exposure-select"
              className="input-field" 
              value={exposure}
              onChange={(e) => setExposure(e.target.value)}
              disabled={loading}
            >
              <option value="South">South (Very sunny)</option>
              <option value="East">East (Morning sun)</option>
              <option value="West">West (Afternoon sun)</option>
              <option value="North">North (Mostly shade)</option>
              <option value="South-East">South-East</option>
              <option value="South-West">South-West</option>
              <option value="North-East">North-East</option>
              <option value="North-West">North-West</option>
            </select>
          </div>

          <div className="input-group">
            <label htmlFor="season-select">Growing Season</label>
            <select
              id="season-select"
              className="input-field"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              disabled={loading}
            >
              <option value="Spring">Spring (Mar–May)</option>
              <option value="Summer">Summer (Jun–Aug)</option>
              <option value="Autumn">Autumn (Sep–Nov)</option>
              <option value="Winter">Winter (Dec–Feb)</option>
            </select>
          </div>

          <div className="input-group input-group-wide">
            <label>Growing Setup</label>
            <div className="segmented" role="group" aria-label="Growing setup">
              <button
                type="button"
                className={`seg ${!greenhouse ? "active" : ""}`}
                onClick={() => setGreenhouse(false)}
                disabled={loading}
              >
                <span className="material-symbols">wb_sunny</span> <span className="seg-label">Outdoor</span>
              </button>
              <button
                type="button"
                className={`seg ${greenhouse ? "active" : ""}`}
                onClick={() => setGreenhouse(true)}
                disabled={loading}
              >
                <span className="material-symbols">potted_plant</span> <span className="seg-label">Greenhouse</span>
              </button>
            </div>
          </div>
        </div>

        <button 
          id="generate-btn"
          className="btn" 
          onClick={handleGeneratePlan} 
          disabled={loading || confirming || !!pendingConfirmation || !address}
        >
          <span className="material-symbols">psychology</span>
          {loading ? "Processing..." : "Generate Cultivation Plan"}
        </button>
      </section>

      {/* Loading Steps & Logs */}
      {loading && (
        <section className="glass-card">
          <div className="loader-container">
            <span className="spinner"></span>
            <h3>Agent Coordination in Progress</h3>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
              The agents are querying the Climate and Botanical MCP servers...
            </p>
          </div>
          {renderSteps(displayedSteps)}
        </section>
      )}

      {/* Human-in-the-loop checkpoint */}
      {pendingConfirmation && !loading && (
        <section className="glass-card checkpoint-card">
          <div className="checkpoint-header">
            <span className="material-symbols checkpoint-icon">verified_user</span>
            <div>
              <h2>{pendingConfirmation.checkpoint?.title || "Human approval required"}</h2>
              <span className="checkpoint-tag">Human-in-the-loop · Agent Security &amp; Control</span>
            </div>
          </div>

          <p className="checkpoint-message">
            {pendingConfirmation.checkpoint?.message ||
              "The Planner agent has paused execution and is waiting for your approval before finalising the crops."}
          </p>

          <div className="checkpoint-climate">
            <span><strong>Location:</strong> {pendingConfirmation.location}</span>
            <span><strong>USDA Zone:</strong> {pendingConfirmation.estimatedHardinessZone}</span>
            <span><strong>Historical min temp:</strong> {pendingConfirmation.absoluteMinTempYear}°C</span>
          </div>

          {pendingConfirmation.rationale && (
            <p className="narrative-comment">“{pendingConfirmation.rationale}”</p>
          )}

          <h3 className="checkpoint-subtitle">Selection proposed by the agent</h3>
          <p className="checkpoint-hint">
            Confirm, add or remove crops before generating the final plan.
            Highlighted cards will be included.
          </p>

          <div className="crops-grid">
            {(pendingConfirmation.compatiblePlants || []).map((plant) => {
              const isSelected = checkpointSelection.includes(plant.id);
              const wasProposed = (pendingConfirmation.proposedPlantIds || []).includes(plant.id);
              return (
                <div
                  key={plant.id}
                  className={`crop-card ${isSelected ? "selected" : ""}`}
                  onClick={() => toggleCheckpointPlant(plant.id)}
                >
                  {wasProposed && <div className="proposed-badge">AI proposal</div>}
                  <div className="crop-name">{plant.name}</div>
                  <div className="crop-science">{plant.scientificName}</div>
                  <div className="crop-badge">Min sun: {plant.sunlightHoursMin} h</div>
                </div>
              );
            })}
          </div>

          <div className="checkpoint-actions">
            <button
              className="btn btn-danger"
              onClick={() => handleConfirm(false)}
              disabled={confirming}
            >
              <span className="material-symbols">cancel</span> Reject
            </button>
            <button
              className="btn"
              onClick={() => handleConfirm(true)}
              disabled={confirming || checkpointSelection.length === 0}
            >
              <span className="material-symbols">check_circle</span>
              {confirming
                ? "Generating..."
                : sameSelection(checkpointSelection, pendingConfirmation.proposedPlantIds || [])
                  ? "Approve & generate plan"
                  : "Approve modified selection"}
            </button>
          </div>
        </section>
      )}

      {/* Rejected checkpoint */}
      {rejection && !loading && (
        <section className="glass-card rejected-card">
          <h2 className="card-title" style={{ color: "var(--danger)", borderColor: "rgba(239,83,80,0.3)" }}>
            <span className="material-symbols">block</span> Selection rejected
          </h2>
          <p className="mt-4">
            {rejection.message ||
              "You rejected the proposed selection. No plan was generated."}
          </p>
          <button className="btn mt-4" onClick={resetWorkflow}>
            <span className="material-symbols">restart_alt</span> New plan
          </button>
        </section>
      )}

      {/* Error Message */}
      {error && !loading && (
        <div className="glass-card" style={{ borderColor: "var(--danger)", borderLeftWidth: "4px" }}>
          <h3 style={{ color: "var(--danger)", display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="material-symbols">warning</span> Processing Error
          </h3>
          <p className="mt-4">{error}</p>
        </div>
      )}

      {/* Dashboard Result View */}
      {planResult && !loading && !error && (
        <>
          {/* Human-in-the-loop outcome banner (Agent Security & Control) */}
          {planResult.security && (
            <div
              className={`security-banner ${
                planResult.security.checkpointSkipped
                  ? "skipped"
                  : planResult.security.adjusted
                    ? "adjusted"
                    : "approved"
              }`}
            >
              <span className="material-symbols">verified_user</span>
              <div className="security-text">
                <strong>
                  {planResult.security.checkpointSkipped
                    ? "Security checkpoint not triggered"
                    : planResult.security.adjusted
                      ? "Plan approved by a human · selection modified at checkpoint"
                      : "Plan approved by a human at the security checkpoint"}
                </strong>
                <span className="security-mechanism">{planResult.security.mechanism}</span>
              </div>
              <button className="btn-reset" onClick={resetWorkflow}>
                <span className="material-symbols">restart_alt</span> New plan
              </button>
            </div>
          )}

          {/* Plan context: target season + growing setup */}
          <div className="plan-context">
            <span className="context-chip">
              <span className="material-symbols">calendar_month</span>
              Season:&nbsp;<strong>{planResult.season || "—"}</strong>
            </span>
            <span className="context-chip">
              <span className="material-symbols">
                {planResult.greenhouse ? "potted_plant" : "wb_sunny"}
              </span>
              Setup:&nbsp;<strong>{planResult.greenhouse ? "Greenhouse" : "Outdoor"}</strong>
            </span>
          </div>

          {/* Multi-agent + MCP activity log */}
          {displayedSteps.length > 0 && (
            <div className="glass-card activity-card">
              <h2 className="card-title">
                <span className="material-symbols">network_node</span> Agent Activity Log
              </h2>
              {renderSteps(displayedSteps)}
            </div>
          )}

          <div className="dashboard-grid">
          
          {/* Left Column: Location details, Botanical selector & Companion suggestions */}
          <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
            
            {/* Climate & location */}
            <div className="glass-card">
              <h2 className="card-title">
                <span className="material-symbols">location_on</span> Geo-Climate Analysis
              </h2>
              <p className="narrative-comment">{planResult.coordinatorComment}</p>
              
              <div className="climate-metrics">
                <div className="metric-box">
                  <div className="metric-value">{planResult.estimatedHardinessZone}</div>
                  <div className="metric-label">USDA Hardiness Zone</div>
                </div>
                <div className="metric-box">
                  <div className="metric-value">{planResult.absoluteMinTempYear}°C</div>
                  <div className="metric-label">Recorded Min Temp</div>
                </div>
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                <strong>Detected location:</strong> {planResult.location}
              </p>
            </div>

            {/* Compatible crop selection */}
            <div className="glass-card">
              <h2 className="card-title">
                <span className="material-symbols">grid_view</span> Selected Crops
              </h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "16px" }}>
                Crops analysed by the Planner agent. Highlighted ones were approved at the human checkpoint and feed the calendar.
              </p>
              
              <div className="crops-grid">
                {planResult.compatiblePlants.map((plant) => {
                  const isSelected = (planResult.selectedPlants || []).some((p) => p.id === plant.id);
                  return (
                    <div 
                      key={plant.id} 
                      className={`crop-card readonly ${isSelected ? "selected" : ""}`}
                    >
                      <div className="crop-name">{plant.name}</div>
                      <div className="crop-science">{plant.scientificName}</div>
                      <div className="crop-badge">Min sun: {plant.sunlightHoursMin} h</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Planting schedule: when to put each crop in the field + harvest */}
            <div className="glass-card">
              <h2 className="card-title">
                <span className="material-symbols">event_available</span> Planting Schedule
              </h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "16px" }}>
                When to put each approved crop in the field and when to harvest
                {planResult.greenhouse ? " · greenhouse setup" : ""}.
              </p>
              <div className="schedule-list">
                {(planResult.plantingSchedule || []).map((row, idx) => (
                  <div key={idx} className={`schedule-row ${row.inSeason ? "in-season" : ""}`}>
                    <div className="schedule-plant">
                      <span className="schedule-name">{row.plant}</span>
                      {row.inSeason && <span className="season-chip">In season</span>}
                    </div>
                    <div className="schedule-windows">
                      <div className="schedule-window">
                        <span className="material-symbols sw-icon" style={{ color: "#4a8c3d" }}>yard</span>
                        <div>
                          <div className="sw-label">Put in field</div>
                          <div className="sw-value">{row.putInField}</div>
                        </div>
                      </div>
                      <div className="schedule-window">
                        <span className="material-symbols sw-icon" style={{ color: "#b06a16" }}>nutrition</span>
                        <div>
                          <div className="sw-label">Harvest</div>
                          <div className="sw-value">{row.harvest}</div>
                        </div>
                      </div>
                    </div>
                    {row.note && <div className="schedule-note">{row.note}</div>}
                  </div>
                ))}
                {(planResult.plantingSchedule || []).length === 0 && (
                  <p className="no-actions text-center">No crops selected for scheduling.</p>
                )}
              </div>
            </div>

            {/* Companion planting & suggestions */}
            <div className="glass-card">
              <h2 className="card-title">
                <span className="material-symbols">groups</span> Companion Planting & Alerts
              </h2>
              <p className="narrative-comment">{planResult.plannerComment}</p>
              
              <div className="companion-section">
                {/* Companions */}
                {planResult.companionship.companions.map((c, idx) => (
                  <div key={`comp-${idx}`} className="companion-item good">
                    <span className="material-symbols icon">add_circle</span>
                    <div className="companion-text">
                      <strong>{c.plants[0]} + {c.plants[1]}</strong>
                      <p>{c.reason}</p>
                    </div>
                  </div>
                ))}

                {/* Antagonists */}
                {planResult.companionship.antagonists.map((a, idx) => (
                  <div key={`ant-${idx}`} className="companion-item bad">
                    <span className="material-symbols icon">remove_circle</span>
                    <div className="companion-text">
                      <strong>{a.plants[0]} & {a.plants[1]}</strong>
                      <p>{a.reason}</p>
                    </div>
                  </div>
                ))}

                {/* Warnings */}
                {planResult.companionship.warnings.map((w, idx) => (
                  <div key={`warn-${idx}`} className="companion-item warning">
                    <span className="material-symbols icon">warning</span>
                    <div className="companion-text">
                      <strong>Botanist's Note</strong>
                      <p>{w}</p>
                    </div>
                  </div>
                ))}

                {planResult.companionship.companions.length === 0 && 
                 planResult.companionship.antagonists.length === 0 && 
                 planResult.companionship.warnings.length === 0 && (
                   <p className="no-actions text-center">No special companion relationships active for the selected plants.</p>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Monthly Calendar Timeline */}
          <div className="glass-card">
            <h2 className="card-title">
              <span className="material-symbols">calendar_month</span> Optimised Cultivation Calendar
            </h2>
            
            <div className="calendar-container">
              {planResult.monthlyCalendar.map((monthData, idx) => (
                <div key={idx} className={`month-row ${monthData.inSeason ? "in-season" : ""}`}>
                  <div className="month-info">
                    <div className="month-name">{monthData.month}</div>
                    <div className="month-temp">
                      {monthData.averageMinTemp}°C | {monthData.averageMaxTemp}°C
                    </div>
                    {monthData.inSeason && <div className="month-season-tag">In season</div>}
                  </div>
                  
                  <div className="month-actions">
                    {monthData.actions.length > 0 ? (
                      monthData.actions.map((act, actIdx) => (
                        <div key={actIdx} className="action-pill">
                          {getActionIcon(act.type)}
                          <span className={`action-type ${act.type.toLowerCase().replace(/ \/ /g, '-').replace(/ /g, '-')}`}>
                            {act.type}
                          </span>
                          <span className="action-desc">
                            <strong>{act.plant}:</strong> {act.text}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="no-actions">No activities planned for this month.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          </div>
        </>
      )}
    </div>
  );
}

export default App;

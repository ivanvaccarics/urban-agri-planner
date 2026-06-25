import React, { useState, useEffect, useRef } from "react";
import { downloadICS, downloadPDF } from "./lib/exporters";
import { LocationMap, CompanionGraph, YearRibbon } from "./components/viz";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5001";

const EXPOSURES = [
  ["South", "Full sun, all day"],
  ["South-East", "Sun until early afternoon"],
  ["South-West", "Sun from midday on"],
  ["East", "Morning sun"],
  ["West", "Afternoon sun"],
  ["North-East", "Soft morning light"],
  ["North-West", "Soft evening light"],
  ["North", "Mostly shade"],
];

const SEASONS = [
  ["Spring", "Mar–May"],
  ["Summer", "Jun–Aug"],
  ["Autumn", "Sep–Nov"],
  ["Winter", "Dec–Feb"],
];

// --------------------------------------------------------------------------
// Small presentational helpers
// --------------------------------------------------------------------------
function Icon({ name, className = "" }) {
  return <span className={`material-symbols ${className}`}>{name}</span>;
}

const AGENT_LABEL = {
  GeoClimateAgent: "Geo-Climate",
  PlannerAgent: "Planner",
  ReviewerAgent: "Reviewer",
  AdvisorAgent: "Advisor",
  CropPlanningPipeline: "Pipeline",
  user: "You",
};

function stepIcon(type) {
  switch (type) {
    case "tool_call": return "bolt";
    case "tool_result": return "task_alt";
    case "checkpoint": return "front_hand";
    case "message": return "chat";
    default: return "arrow_right";
  }
}

function AgentActivity({ steps }) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="activity">
      {steps.map((step, idx) => (
        <li key={idx} className={`activity__row${step.type === "checkpoint" ? " is-checkpoint" : ""}`}>
          <span className="activity__agent">{AGENT_LABEL[step.agent] || step.agent || "Agent"}</span>
          <Icon name={stepIcon(step.type)} className="activity__icon" />
          <span className="activity__msg">
            {step.message}
            {step.tool && <span className="activity__tool mono">{step.tool}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Stepper({ step }) {
  const steps = [
    ["Your space", "tune"],
    ["Review & approve", "front_hand"],
    ["Your plan", "calendar_month"],
  ];
  return (
    <nav className="stepper" aria-label="Progress">
      {steps.map(([label], i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <React.Fragment key={label}>
            <div className={`stepper__step is-${state}`} aria-current={n === step ? "step" : undefined}>
              <span className="stepper__dot">
                {state === "done" ? <Icon name="check" /> : <span>{n}</span>}
              </span>
              <span className="stepper__label">{label}</span>
            </div>
            {n < steps.length && <span className={`stepper__bar${n < step ? " is-filled" : ""}`} />}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function CropCard({ plant, selected, onToggle, proposed, readonly }) {
  return (
    <button
      type="button"
      className={`cropcard${selected ? " is-selected" : ""}${readonly ? " is-readonly" : ""}`}
      onClick={readonly ? undefined : onToggle}
      aria-pressed={readonly ? undefined : selected}
      disabled={readonly}
    >
      {!readonly && (
        <span className="cropcard__check">
          <Icon name={selected ? "check_circle" : "radio_button_unchecked"} />
        </span>
      )}
      {proposed && <span className="cropcard__badge">Suggested</span>}
      <span className="cropcard__name">{plant.name}</span>
      <span className="cropcard__sci">{plant.scientificName}</span>
      <span className="cropcard__meta">
        <span className="mono"><Icon name="wb_sunny" /> {plant.sunlightHoursMin}h</span>
        {plant.difficulty && <span className="mono"><Icon name="fitness_center" /> {plant.difficulty}</span>}
        {plant.watering && <span className="mono"><Icon name="water_drop" /> {plant.watering}</span>}
      </span>
    </button>
  );
}

// --------------------------------------------------------------------------
// App
// --------------------------------------------------------------------------
function App() {
  const [address, setAddress] = useState("Via Roma 10, Milan, Italy");
  const [sunlightHours, setSunlightHours] = useState(6);
  const [exposure, setExposure] = useState("South");
  const [season, setSeason] = useState("Spring");
  const [greenhouse, setGreenhouse] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const skipNextFetch = useRef(false);

  const [displayedSteps, setDisplayedSteps] = useState([]);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [checkpointSelection, setCheckpointSelection] = useState([]);
  const [planResult, setPlanResult] = useState(null);
  const [rejection, setRejection] = useState(null);
  const [companionView, setCompanionView] = useState("list");
  const [activeTab, setActiveTab] = useState("overview");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatWindowRef = useRef(null);

  const animateSteps = async (steps) => {
    setDisplayedSteps([]);
    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 380));
      setDisplayedSteps((prev) => [...prev, steps[i]]);
    }
    await new Promise((r) => setTimeout(r, 200));
  };

  const resetWorkflow = () => {
    setPendingConfirmation(null);
    setPlanResult(null);
    setRejection(null);
    setDisplayedSteps([]);
    setError(null);
    setChatMessages([]);
    setChatInput("");
    setActiveTab("overview");
  };

  const startOver = () => {
    resetWorkflow();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading]);

  const sendChatMessage = async () => {
    const question = chatInput.trim();
    if (!question || chatLoading || !planResult?.sessionId) return;
    setChatMessages((prev) => [...prev, { role: "user", text: question }]);
    setChatInput("");
    setChatLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/plan/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: planResult.sessionId, message: question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "The advisor could not answer.");
      setChatMessages((prev) => [
        ...prev,
        { role: "advisor", text: data.reply, steps: data.steps || [] },
      ]);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { role: "advisor", text: err.message, error: true },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  // Debounced address autocomplete via the backend Nominatim proxy.
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
        const res = await fetch(`${API_BASE}/api/address/suggestions?q=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      } catch {
        /* best-effort */
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [address]);

  const handleSelectSuggestion = (s) => {
    skipNextFetch.current = true;
    setAddress(s.displayName);
    setSuggestions([]);
    setShowSuggestions(false);
  };

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
      if (data.steps && data.steps.length > 0) await animateSteps(data.steps);
      if (data.status === "confirmation_required") {
        setPendingConfirmation(data);
        setCheckpointSelection(data.proposedPlantIds || []);
      } else if (data.status === "completed") {
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
      if (!response.ok) throw new Error(data.detail || data.error || "Error during confirmation.");
      if (data.steps && data.steps.length > 0) setDisplayedSteps(data.steps);
      if (data.status === "completed") {
        setPlanResult(data);
        setPendingConfirmation(null);
        setActiveTab("overview");
        window.scrollTo({ top: 0, behavior: "smooth" });
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

  const toggleCheckpointPlant = (plantId) => {
    setCheckpointSelection((prev) =>
      prev.includes(plantId) ? prev.filter((id) => id !== plantId) : [...prev, plantId]
    );
  };

  const sameSelection = (a, b) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

  const step = planResult ? 3 : pendingConfirmation || rejection ? 2 : 1;
  const contextLocation = planResult?.location || pendingConfirmation?.location || null;
  const contextZone = planResult?.estimatedHardinessZone || pendingConfirmation?.estimatedHardinessZone;

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__brand">
          <span className="appbar__mark" aria-hidden="true"><Icon name="potted_plant" /></span>
          <span className="appbar__title">Urban Agri-Planner</span>
        </div>

        {contextLocation && (
          <div className="appbar__context">
            <span className="ctx"><Icon name="location_on" />{contextLocation.split(",")[0]}</span>
            {contextZone && <span className="ctx mono">Zone {contextZone}</span>}
            {planResult?.season && <span className="ctx mono">{planResult.season}</span>}
          </div>
        )}

        <div className="appbar__actions">
          {planResult && (
            <>
              <button className="btn btn--ghost" onClick={() => downloadICS(planResult)}>
                <Icon name="event" /> <span className="btn__label">.ics</span>
              </button>
              <button className="btn btn--ghost" onClick={() => downloadPDF(planResult)}>
                <Icon name="picture_as_pdf" /> <span className="btn__label">PDF</span>
              </button>
            </>
          )}
          {(planResult || pendingConfirmation || rejection) && (
            <button className="btn btn--primary" onClick={startOver}>
              <Icon name="add" /> <span className="btn__label">New plan</span>
            </button>
          )}
        </div>
      </header>

      <main className="shell">
        <Stepper step={step} />

        {/* ---- STEP 1: input ------------------------------------------------ */}
        {step === 1 && !loading && (
          <div className="intake">
            <section className="intake__intro">
              <p className="eyebrow mono">Multi-agent growing planner</p>
              <h1 className="intake__headline">
                Tell us about your balcony.<br />We'll plan the whole growing year.
              </h1>
              <p className="intake__sub">
                AI agents cross-reference a decade of local climate, your light and exposure,
                and the needs of 78 crops — then a reviewer critiques the picks before you approve them.
              </p>
              <ul className="intake__points">
                <li><Icon name="public" /> Grounded in your address's real microclimate</li>
                <li><Icon name="rate_review" /> Independently reviewed, approved by you</li>
                <li><Icon name="savings" /> Harvest, savings and pest advice included</li>
              </ul>
            </section>

            <section className="panel intake__form">
              <div className="field">
                <label htmlFor="address-input" className="field__label">Where is your space?</label>
                <div className="autocomplete">
                  <Icon name="search" className="field__icon" />
                  <input
                    id="address-input"
                    type="text"
                    className="control control--icon"
                    value={address}
                    onChange={(e) => { setAddress(e.target.value); setShowSuggestions(true); }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    placeholder="Street, city — e.g. Via Roma 10, Milan"
                    autoComplete="off"
                  />
                  {showSuggestions && suggestions.length > 0 && (
                    <ul className="suggestions">
                      {suggestions.map((s, idx) => (
                        <li key={idx} className="suggestions__item" onMouseDown={() => handleSelectSuggestion(s)}>
                          <Icon name="location_on" />
                          <span>{s.displayName}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="field__hint">We use this to look up your climate and frost dates.</p>
              </div>

              <div className="field">
                <div className="field__label-row">
                  <label htmlFor="sun-input" className="field__label">How much direct sun?</label>
                  <span className="field__value mono">{sunlightHours} h/day</span>
                </div>
                <input
                  id="sun-input"
                  type="range"
                  className="slider"
                  min="0" max="14" step="1"
                  value={sunlightHours}
                  onChange={(e) => setSunlightHours(e.target.value)}
                />
                <div className="slider__scale mono"><span>Shade</span><span>Part sun</span><span>Full sun</span></div>
              </div>

              <div className="field">
                <label htmlFor="exposure-select" className="field__label">Which way does it face?</label>
                <select id="exposure-select" className="control" value={exposure} onChange={(e) => setExposure(e.target.value)}>
                  {EXPOSURES.map(([val, hint]) => <option key={val} value={val}>{val} — {hint}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="season-select" className="field__label">When do you want to start?</label>
                <select id="season-select" className="control" value={season} onChange={(e) => setSeason(e.target.value)}>
                  {SEASONS.map(([val, hint]) => <option key={val} value={val}>{val} ({hint})</option>)}
                </select>
              </div>

              <div className="field">
                <span className="field__label">Growing setup</span>
                <div className="segmented" role="group" aria-label="Growing setup">
                  <button type="button" className={`seg${!greenhouse ? " is-active" : ""}`} onClick={() => setGreenhouse(false)}>
                    <Icon name="wb_sunny" /> Outdoor
                  </button>
                  <button type="button" className={`seg${greenhouse ? " is-active" : ""}`} onClick={() => setGreenhouse(true)}>
                    <Icon name="potted_plant" /> Greenhouse
                  </button>
                </div>
              </div>

              <button className="btn btn--primary btn--block btn--lg" onClick={handleGeneratePlan} disabled={loading || !address}>
                <Icon name="auto_awesome" /> Generate my plan
              </button>

              {error && (
                <div className="alert alert--error">
                  <Icon name="error" />
                  <div><strong>Couldn't build the plan.</strong><p>{error}</p></div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ---- LOADING ------------------------------------------------------ */}
        {loading && (
          <section className="panel loading">
            <div className="loading__head">
              <span className="spinner" />
              <div>
                <h2>Planning your growing year</h2>
                <p className="muted">The agents are querying the climate and botanical servers…</p>
              </div>
            </div>
            <AgentActivity steps={displayedSteps} />
          </section>
        )}

        {/* ---- STEP 2: checkpoint ------------------------------------------- */}
        {step === 2 && pendingConfirmation && !loading && (
          <section className="checkpoint">
            <div className="panel checkpoint__intro">
              <div className="checkpoint__title">
                <span className="checkpoint__pill"><Icon name="front_hand" /> Your approval needed</span>
                <h2>{pendingConfirmation.checkpoint?.title || "Review the suggested crops"}</h2>
                <p className="muted">
                  {pendingConfirmation.checkpoint?.message ||
                    "The planner paused before finalising. Keep, add or drop crops, then approve."}
                </p>
              </div>
              <div className="checkpoint__climate">
                <span><Icon name="location_on" />{pendingConfirmation.location}</span>
                <span className="mono">Zone {pendingConfirmation.estimatedHardinessZone}</span>
                <span className="mono">Min {pendingConfirmation.absoluteMinTempYear}°C</span>
              </div>
              {pendingConfirmation.rationale && <p className="quote">“{pendingConfirmation.rationale}”</p>}
            </div>

            {pendingConfirmation.review && (
              <div className="panel scorecard">
                <div className="scorecard__head">
                  <div>
                    <p className="eyebrow mono">Reviewer agent · independent critique</p>
                    {pendingConfirmation.review.verdict && (
                      <p className="scorecard__verdict">“{pendingConfirmation.review.verdict}”</p>
                    )}
                  </div>
                  {typeof pendingConfirmation.review.score === "number" && (
                    <div className={`gauge ${
                      pendingConfirmation.review.score >= 75 ? "is-good"
                      : pendingConfirmation.review.score >= 50 ? "is-fair" : "is-poor"}`}>
                      <span className="gauge__num">{pendingConfirmation.review.score}</span>
                      <span className="gauge__max mono">/100</span>
                    </div>
                  )}
                </div>
                <div className="scorecard__cols">
                  {[["strengths", "Strengths", "thumb_up", "good"],
                    ["concerns", "Watch outs", "priority_high", "bad"],
                    ["suggestions", "Ideas", "lightbulb", "info"]].map(([key, label, icon, tone]) =>
                    (pendingConfirmation.review[key] || []).length > 0 ? (
                      <div key={key} className="scorecard__col">
                        <h4 className={`scorecard__col-title is-${tone}`}><Icon name={icon} /> {label}</h4>
                        <ul>{pendingConfirmation.review[key].map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </div>
                    ) : null
                  )}
                </div>
              </div>
            )}

            <div className="panel">
              <div className="section-head">
                <h3 className="panel__title"><Icon name="grass" /> Choose your crops</h3>
                <span className="counter mono">{checkpointSelection.length} selected</span>
              </div>
              <p className="muted section-head__sub">Suggested crops are pre-selected. Tap a card to add or remove it.</p>
              <div className="cropgrid">
                {(pendingConfirmation.compatiblePlants || []).map((plant) => (
                  <CropCard
                    key={plant.id}
                    plant={plant}
                    selected={checkpointSelection.includes(plant.id)}
                    proposed={(pendingConfirmation.proposedPlantIds || []).includes(plant.id)}
                    onToggle={() => toggleCheckpointPlant(plant.id)}
                  />
                ))}
              </div>

              <div className="checkpoint__actions">
                <button className="btn btn--danger-ghost" onClick={() => handleConfirm(false)} disabled={confirming}>
                  <Icon name="close" /> Reject all
                </button>
                <button
                  className="btn btn--primary btn--lg"
                  onClick={() => handleConfirm(true)}
                  disabled={confirming || checkpointSelection.length === 0}
                >
                  <Icon name="check" />
                  {confirming ? "Generating…"
                    : sameSelection(checkpointSelection, pendingConfirmation.proposedPlantIds || [])
                      ? "Approve & build plan"
                      : "Approve my selection"}
                </button>
              </div>
              {error && <div className="alert alert--error"><Icon name="error" /><div><p>{error}</p></div></div>}
            </div>
          </section>
        )}

        {/* ---- REJECTED ----------------------------------------------------- */}
        {step === 2 && rejection && !loading && (
          <section className="panel state">
            <Icon name="block" className="state__icon is-danger" />
            <h2>Selection rejected</h2>
            <p className="muted">{rejection.message || "No plan was generated."}</p>
            <button className="btn btn--primary" onClick={startOver}><Icon name="restart_alt" /> Start over</button>
          </section>
        )}

        {/* ---- STEP 3: dashboard ------------------------------------------- */}
        {step === 3 && planResult && !loading && (
          <PlanDashboard
            plan={planResult}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            companionView={companionView}
            setCompanionView={setCompanionView}
            displayedSteps={displayedSteps}
            chat={{
              messages: chatMessages,
              input: chatInput,
              setInput: setChatInput,
              loading: chatLoading,
              send: sendChatMessage,
              windowRef: chatWindowRef,
            }}
          />
        )}
      </main>
    </div>
  );
}

// --------------------------------------------------------------------------
// Plan dashboard — tabbed result view
// --------------------------------------------------------------------------
function PlanDashboard({ plan, activeTab, setActiveTab, companionView, setCompanionView, displayedSteps, chat }) {
  const hasSavings = plan.yieldEstimate && (plan.yieldEstimate.crops || []).length > 0;
  const hasPests = plan.pestAdvisory && (plan.pestAdvisory.risks || []).length > 0;

  const tabs = [
    ["overview", "Overview", "dashboard"],
    ["calendar", "Calendar", "calendar_month"],
    ["crops", "Crops", "grass"],
    ["companions", "Companions", "group_work"],
    hasPests && ["pests", "Pests", "pest_control"],
    hasSavings && ["savings", "Savings", "savings"],
    ["ask", "Ask", "forum"],
  ].filter(Boolean);

  const sec = plan.security;
  const securityTone = sec?.checkpointSkipped ? "skipped" : sec?.adjusted ? "adjusted" : "approved";
  const securityText = sec?.checkpointSkipped
    ? "No approval checkpoint was triggered"
    : sec?.adjusted
      ? "Approved by you — you adjusted the selection"
      : "Approved by you at the safety checkpoint";

  return (
    <div className="dash">
      {sec && (
        <div className={`approval approval--${securityTone}`}>
          <Icon name={securityTone === "skipped" ? "info" : "verified"} />
          <div>
            <strong>{securityText}</strong>
            <span className="approval__mech mono">{sec.mechanism}</span>
          </div>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {tabs.map(([id, label, icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={`tab${activeTab === id ? " is-active" : ""}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon name={icon} /> {label}
          </button>
        ))}
      </nav>

      <div className="dash__body">
        {activeTab === "overview" && <OverviewTab plan={plan} displayedSteps={displayedSteps} goCalendar={() => setActiveTab("calendar")} />}
        {activeTab === "calendar" && <CalendarTab plan={plan} />}
        {activeTab === "crops" && <CropsTab plan={plan} />}
        {activeTab === "companions" && <CompanionsTab plan={plan} view={companionView} setView={setCompanionView} />}
        {activeTab === "pests" && hasPests && <PestsTab plan={plan} />}
        {activeTab === "savings" && hasSavings && <SavingsTab plan={plan} />}
        {activeTab === "ask" && <AskTab chat={chat} />}
      </div>
    </div>
  );
}

function Metric({ icon, value, label, tone }) {
  return (
    <div className={`metric${tone ? ` metric--${tone}` : ""}`}>
      <Icon name={icon} className="metric__icon" />
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}

function OverviewTab({ plan, displayedSteps, goCalendar }) {
  const ye = plan.yieldEstimate;
  const ff = plan.frostDates;
  return (
    <div className="grid grid--overview">
      <section className="panel">
        <h3 className="panel__title"><Icon name="insights" /> At a glance</h3>
        <div className="metrics">
          <Metric icon="thermostat" value={plan.estimatedHardinessZone || "—"} label="USDA zone" />
          {ff?.frostFreeDays != null && <Metric icon="wb_sunny" value={ff.frostFreeDays} label="Frost-free days" />}
          {ye && <Metric icon="nutrition" value={`${ye.totalYieldKg} kg`} label="Est. harvest" tone="green" />}
          {ye && <Metric icon="savings" value={`€${ye.totalValueEur}`} label="Grocery value" tone="amber" />}
        </div>
        {plan.coordinatorComment && <p className="quote">{plan.coordinatorComment}</p>}
        <div className="chips">
          <span className="chip-pill"><Icon name="calendar_month" /> {plan.season || "—"}</span>
          <span className="chip-pill"><Icon name={plan.greenhouse ? "potted_plant" : "wb_sunny"} /> {plan.greenhouse ? "Greenhouse" : "Outdoor"}</span>
          <span className="chip-pill"><Icon name="grass" /> {(plan.selectedPlants || []).length} crops</span>
        </div>
        <button className="btn btn--ghost btn--block" onClick={goCalendar}>
          <Icon name="calendar_month" /> See the growing calendar
        </button>
      </section>

      <section className="panel">
        <h3 className="panel__title"><Icon name="location_on" /> Your location</h3>
        <p className="muted small">{plan.location}</p>
        {plan.climateYears && (
          <p className="muted xsmall">
            {plan.climateYears.count}-year climate average ({plan.climateYears.start}–{plan.climateYears.end})
          </p>
        )}
        <LocationMap coordinates={plan.coordinates} />
        {ff && (
          <div className="frost">
            <div className="frost__item"><Icon name="ac_unit" /><div><span className="frost__label">Last spring frost</span><span className="frost__val">{ff.lastSpringFrost || "—"}</span></div></div>
            <div className="frost__item"><Icon name="ac_unit" /><div><span className="frost__label">First autumn frost</span><span className="frost__val">{ff.firstAutumnFrost || "—"}</span></div></div>
          </div>
        )}
        {plan.wateringAdvice && (
          <div className={`watering watering--${plan.wateringAdvice.level}`}>
            <Icon name="water_drop" />
            <div>
              <strong>Next 7 days</strong>
              <p>{plan.wateringAdvice.advice}</p>
              <span className="watering__meta mono">
                {plan.wateringAdvice.totalPrecipitationMm} mm · {plan.wateringAdvice.rainyDays} rainy day(s)
                {plan.wateringAdvice.avgMaxTempC != null ? ` · max ${plan.wateringAdvice.avgMaxTempC}°C` : ""}
              </span>
            </div>
          </div>
        )}
      </section>

      {displayedSteps.length > 0 && (
        <section className="panel grid--full">
          <details className="disclosure">
            <summary><Icon name="network_node" /> Behind the plan — agent activity ({displayedSteps.length} steps)</summary>
            <AgentActivity steps={displayedSteps} />
          </details>
        </section>
      )}
    </div>
  );
}

function CalendarTab({ plan }) {
  return (
    <div className="grid grid--single">
      <section className="panel">
        <h3 className="panel__title"><Icon name="calendar_month" /> Your growing year</h3>
        <p className="muted section-head__sub">Tap a month to see exactly what to do.</p>
        <YearRibbon monthlyCalendar={plan.monthlyCalendar || []} />
      </section>

      <section className="panel">
        <h3 className="panel__title"><Icon name="event_available" /> Planting schedule</h3>
        <p className="muted section-head__sub">
          When to put each crop out and when to harvest{plan.greenhouse ? " · greenhouse" : ""}.
        </p>
        <div className="schedule">
          {(plan.plantingSchedule || []).map((row, idx) => (
            <div key={idx} className={`schedule__row${row.inSeason ? " is-season" : ""}`}>
              <div className="schedule__plant">
                <span className="schedule__name">{row.plant}</span>
                {row.inSeason && <span className="tag tag--season">In season</span>}
              </div>
              <div className="schedule__win">
                <Icon name="grass" className="is-green" />
                <div><span className="schedule__lbl">Put out</span><span className="schedule__val">{row.putInField}</span></div>
              </div>
              <div className="schedule__win">
                <Icon name="nutrition" className="is-amber" />
                <div><span className="schedule__lbl">Harvest</span><span className="schedule__val">{row.harvest}</span></div>
              </div>
              {row.note && <div className="schedule__note">{row.note}</div>}
            </div>
          ))}
          {(plan.plantingSchedule || []).length === 0 && <p className="empty-note">No crops scheduled.</p>}
        </div>
      </section>
    </div>
  );
}

function CropsTab({ plan }) {
  const selectedIds = new Set((plan.selectedPlants || []).map((p) => p.id));
  return (
    <div className="grid grid--single">
      <section className="panel">
        <div className="section-head">
          <h3 className="panel__title"><Icon name="grass" /> Crops in your plan</h3>
          <span className="counter mono">{(plan.selectedPlants || []).length} growing</span>
        </div>
        <p className="muted section-head__sub">
          Highlighted crops were approved and drive your calendar. The rest were analysed but left out.
        </p>
        <div className="cropgrid">
          {(plan.compatiblePlants || []).map((plant) => (
            <CropCard key={plant.id} plant={plant} selected={selectedIds.has(plant.id)} readonly />
          ))}
        </div>
      </section>
    </div>
  );
}

function CompanionsTab({ plan, view, setView }) {
  const c = plan.companionship || { companions: [], antagonists: [], warnings: [] };
  const empty = c.companions.length === 0 && c.antagonists.length === 0 && c.warnings.length === 0;
  return (
    <div className="grid grid--single">
      <section className="panel">
        <div className="section-head">
          <h3 className="panel__title"><Icon name="group_work" /> Companion planting</h3>
          <div className="segmented segmented--sm" role="group" aria-label="View">
            <button className={`seg${view === "list" ? " is-active" : ""}`} onClick={() => setView("list")}><Icon name="list" /> List</button>
            <button className={`seg${view === "graph" ? " is-active" : ""}`} onClick={() => setView("graph")}><Icon name="hub" /> Graph</button>
          </div>
        </div>
        {plan.plannerComment && <p className="quote">{plan.plannerComment}</p>}

        {view === "graph" ? (
          <CompanionGraph selectedPlants={plan.selectedPlants} companionship={c} />
        ) : empty ? (
          <p className="empty-note">No notable companion relationships for this selection.</p>
        ) : (
          <div className="rel">
            {c.companions.map((x, i) => (
              <div key={`c${i}`} className="rel__item rel__item--good">
                <Icon name="add_circle" />
                <div><strong>{x.plants[0]} + {x.plants[1]}</strong><p>{x.reason}</p></div>
              </div>
            ))}
            {c.antagonists.map((x, i) => (
              <div key={`a${i}`} className="rel__item rel__item--bad">
                <Icon name="do_not_disturb_on" />
                <div><strong>{x.plants[0]} & {x.plants[1]}</strong><p>{x.reason}</p></div>
              </div>
            ))}
            {c.warnings.map((w, i) => (
              <div key={`w${i}`} className="rel__item rel__item--warn">
                <Icon name="warning" />
                <div><strong>Botanist's note</strong><p>{w}</p></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PestsTab({ plan }) {
  const adv = plan.pestAdvisory;
  return (
    <div className="grid grid--single">
      <section className="panel">
        <h3 className="panel__title"><Icon name="pest_control" /> Pests & diseases</h3>
        <p className="muted section-head__sub">
          Common issues for your crops with organic remedies — and which plants help keep them down.
        </p>
        {adv.climateNote && <div className="note"><Icon name="thermostat" /><p>{adv.climateNote}</p></div>}
        <div className="pests">
          {adv.risks.map((risk, idx) => (
            <div key={idx} className="pests__crop">
              <div className="pests__crop-name">{risk.plant}</div>
              {risk.issues.map((issue, j) => (
                <div key={j} className="pests__issue">
                  <div className="pests__issue-head">
                    <span className={`tag tag--${issue.type}`}>{issue.type}</span>
                    <span className="pests__issue-name">{issue.name}</span>
                  </div>
                  <p className="pests__remedy">{issue.remedy}</p>
                  {issue.deterredBy.length > 0 && (
                    <div className="pests__allies">
                      <Icon name="shield" /> Helped by:
                      {issue.deterredBy.map((ally, k) => <span key={k} className="ally-chip">{ally}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        {(adv.protectiveAllies || []).length > 0 && (
          <div className="note note--green">
            <Icon name="verified_user" />
            <p><strong>Your protective allies:</strong>{" "}
              {adv.protectiveAllies.map((a) => `${a.plant} (${a.deters.join(", ")})`).join(" · ")}</p>
          </div>
        )}
        {(adv.tips || []).length > 0 && (
          <ul className="tips">{adv.tips.map((tip, idx) => <li key={idx}><Icon name="tips_and_updates" /> {tip}</li>)}</ul>
        )}
      </section>
    </div>
  );
}

function SavingsTab({ plan }) {
  const ye = plan.yieldEstimate;
  const max = Math.max(1, ...(ye.crops || []).map((c) => c.valueEur || 0));
  return (
    <div className="grid grid--single">
      <section className="panel">
        <h3 className="panel__title"><Icon name="savings" /> Harvest & savings</h3>
        <p className="muted section-head__sub">
          A full-season estimate for your selection — and what the same produce would cost at the shop.
        </p>
        <div className="metrics metrics--2">
          <Metric icon="nutrition" value={`${ye.totalYieldKg} kg`} label="Estimated harvest" tone="green" />
          <Metric icon="savings" value={`€${ye.totalValueEur}`} label="Grocery value / year" tone="amber" />
        </div>
        <div className="bars">
          {(ye.crops || []).map((row, idx) => {
            const pct = row.ornamental ? 0 : Math.round(((row.valueEur || 0) / max) * 100);
            return (
              <div key={idx} className="bars__row">
                <span className="bars__name">{row.plant}</span>
                <div className="bars__track">
                  {!row.ornamental && <div className="bars__fill" style={{ width: `${Math.max(pct, 4)}%` }} />}
                </div>
                <span className="bars__val mono">
                  {row.ornamental ? "companion" : `${row.yieldKg}kg · €${row.valueEur}`}
                </span>
              </div>
            );
          })}
        </div>
        <p className="muted xsmall">{ye.assumption}</p>
      </section>
    </div>
  );
}

function AskTab({ chat }) {
  return (
    <div className="grid grid--single">
      <section className="panel chat">
        <h3 className="panel__title"><Icon name="forum" /> Ask the garden advisor</h3>
        <p className="muted section-head__sub">
          Follow-up questions about your plan — substitutions, watering, timing. Answers are re-checked against your climate and crops.
        </p>
        <div className="chat__window" ref={chat.windowRef}>
          {chat.messages.length === 0 && (
            <div className="chat__empty">
              <Icon name="eco" />
              <p>Try “Can I swap basil for mint?” or “Which crop needs the least water?”</p>
            </div>
          )}
          {chat.messages.map((msg, idx) => (
            <div key={idx} className={`bubble bubble--${msg.role}${msg.error ? " is-error" : ""}`}>
              {msg.role === "advisor" && <Icon name="eco" className="bubble__avatar" />}
              <div className="bubble__text">
                {msg.text}
                {msg.steps && msg.steps.length > 0 && (
                  <div className="bubble__tools">
                    {msg.steps.filter((s) => s.type === "tool_call").map((s, j) => (
                      <span key={j} className="tool-chip mono"><Icon name="bolt" /> {s.tool}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {chat.loading && (
            <div className="bubble bubble--advisor">
              <Icon name="eco" className="bubble__avatar" />
              <div className="bubble__text bubble__typing"><span /><span /><span /></div>
            </div>
          )}
        </div>
        <form className="chat__form" onSubmit={(e) => { e.preventDefault(); chat.send(); }}>
          <input
            type="text"
            className="control"
            placeholder="Ask about your plan…"
            value={chat.input}
            onChange={(e) => chat.setInput(e.target.value)}
            disabled={chat.loading}
            maxLength={1000}
          />
          <button type="submit" className="btn btn--primary" disabled={chat.loading || !chat.input.trim()}>
            <Icon name="send" />
          </button>
        </form>
      </section>
    </div>
  );
}

export default App;

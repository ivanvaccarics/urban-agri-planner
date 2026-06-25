import React, { useState, useEffect, useRef } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5001";

const MONTH_TO_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Build a downloadable .ics calendar from the monthly cultivation plan.
// Each month's actions become an all-day event on the 1st of that month,
// so the user can import the full growing cycle into any calendar app.
function buildICS(planResult) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = new Date().getFullYear();
  const dtstamp =
    new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const esc = (s) =>
    String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Urban Agri-Planner//Cultivation Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];

  (planResult.monthlyCalendar || []).forEach((monthData) => {
    const key = String(monthData.month || "").slice(0, 3).toLowerCase();
    const monthNum = MONTH_TO_NUM[key];
    if (!monthNum || !monthData.actions || monthData.actions.length === 0) return;
    const start = `${year}${pad(monthNum)}01`;
    const endDate = new Date(year, monthNum, 2); // 1st of next month for DTEND
    const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(
      endDate.getDate()
    )}`;
    monthData.actions.forEach((act, i) => {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${monthNum}-${i}-${act.plant || "plant"}@urbanagriplanner`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        `SUMMARY:${esc(`${act.type}: ${act.plant}`)}`,
        `DESCRIPTION:${esc(act.text)}`,
        "END:VEVENT"
      );
    });
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadICS(planResult) {
  const ics = buildICS(planResult);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const place = (planResult.location || "plan").split(",")[0].trim().replace(/\s+/g, "-");
  link.href = url;
  link.download = `agri-calendar-${place || "plan"}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// PDF report template
// ---------------------------------------------------------------------------
// Branded A4 cultivation-plan document built with jsPDF + autoTable.
// Layout: title band → location/climate summary → frost & watering → selected
// crops → planting schedule → companion planting → monthly calendar, with a
// running footer (generator credit + page numbers). This downloads a real .pdf
// file instead of opening the browser print dialog.
const PDF_GREEN = [74, 140, 61]; // brand green
const PDF_DARK = [40, 54, 38];
const PDF_MUTED = [120, 130, 120];

function downloadPDF(planResult) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  const contentW = pageW - margin * 2;
  const place = (planResult.location || "Cultivation Plan").split(",")[0].trim();
  const generated = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // --- Title band -----------------------------------------------------------
  doc.setFillColor(...PDF_GREEN);
  doc.rect(0, 0, pageW, 70, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("Urban Agri-Planner", margin, 34);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("AI-generated cultivation plan", margin, 52);
  doc.setFontSize(9);
  doc.text(`Generated ${generated}`, pageW - margin, 34, { align: "right" });

  let y = 96;

  // --- Location & climate summary ------------------------------------------
  doc.setTextColor(...PDF_DARK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(place, margin, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...PDF_MUTED);
  if (planResult.location) {
    doc.text(doc.splitTextToSize(planResult.location, contentW), margin, y);
    y += 14;
  }
  if (planResult.coordinates) {
    const c = planResult.coordinates;
    const lat = c.latitude ?? c.lat;
    const lon = c.longitude ?? c.lon;
    if (lat != null && lon != null) {
      doc.text(`Coordinates: ${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`, margin, y);
      y += 14;
    }
  }
  y += 6;

  // Climate fact chips, rendered as a compact 2-column key/value table.
  const climateRows = [];
  if (planResult.estimatedHardinessZone)
    climateRows.push(["USDA hardiness zone", String(planResult.estimatedHardinessZone)]);
  if (planResult.absoluteMinTempYear != null)
    climateRows.push(["Coldest recorded temp", `${planResult.absoluteMinTempYear} °C`]);
  if (planResult.climateYears)
    climateRows.push([
      "Climate basis",
      `${planResult.climateYears.count}-year average (${planResult.climateYears.start}–${planResult.climateYears.end})`,
    ]);
  if (planResult.frostDates) {
    const f = planResult.frostDates;
    if (f.lastSpringFrost) climateRows.push(["Last spring frost", f.lastSpringFrost]);
    if (f.firstAutumnFrost) climateRows.push(["First autumn frost", f.firstAutumnFrost]);
    if (f.frostFreeDays != null) climateRows.push(["Frost-free days", `${f.frostFreeDays}`]);
  }
  if (climateRows.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Climate", ""]],
      body: climateRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, textColor: PDF_DARK },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 160, fontStyle: "bold" } },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // --- Watering advice ------------------------------------------------------
  if (planResult.wateringAdvice && planResult.wateringAdvice.advice) {
    const w = planResult.wateringAdvice;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...PDF_DARK);
    doc.text("7-day watering advice", margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...PDF_MUTED);
    const wlines = doc.splitTextToSize(w.advice, contentW);
    doc.text(wlines, margin, y);
    y += wlines.length * 12 + 4;
    const meta = [
      w.totalPrecipitationMm != null ? `${w.totalPrecipitationMm} mm forecast` : null,
      w.rainyDays != null ? `${w.rainyDays} rainy day(s)` : null,
      w.avgMaxTempC != null ? `avg max ${w.avgMaxTempC} °C` : null,
    ].filter(Boolean).join("  ·  ");
    if (meta) {
      doc.text(meta, margin, y);
      y += 16;
    }
  }

  // --- Selected crops -------------------------------------------------------
  const selected = planResult.selectedPlants || [];
  if (selected.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Selected crop", "Scientific name", "Min sun (h)"]],
      body: selected.map((p) => [p.name, p.scientificName || "—", String(p.sunlightHoursMin ?? "—")]),
      theme: "striped",
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, textColor: PDF_DARK },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: { 1: { fontStyle: "italic" }, 2: { halign: "center", cellWidth: 80 } },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // --- Planting schedule ----------------------------------------------------
  const schedule = planResult.plantingSchedule || [];
  if (schedule.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Crop", "Put in field", "Harvest", "Notes"]],
      body: schedule.map((r) => [
        r.plant + (r.inSeason ? "  (in season)" : ""),
        r.putInField || "—",
        r.harvest || "—",
        r.note || "",
      ]),
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, textColor: PDF_DARK, valign: "top" },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: { 3: { textColor: PDF_MUTED, fontSize: 8 } },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // --- Estimated harvest & savings -----------------------------------------
  const yieldEst = planResult.yieldEstimate || {};
  const yieldCrops = yieldEst.crops || [];
  if (yieldCrops.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Crop", "Est. harvest", "Grocery value"]],
      body: yieldCrops.map((c) => [
        c.plant,
        c.ornamental ? "companion / ornamental" : `${c.yieldKg} kg`,
        c.ornamental ? "—" : `EUR ${c.valueEur}`,
      ]),
      foot: [["Total", `${yieldEst.totalYieldKg} kg`, `EUR ${yieldEst.totalValueEur}`]],
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, textColor: PDF_DARK, valign: "top" },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [235, 240, 232], textColor: PDF_DARK, fontStyle: "bold" },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });
    y = doc.lastAutoTable.finalY + 6;
    if (yieldEst.assumption) {
      doc.setFontSize(8);
      doc.setTextColor(...PDF_MUTED);
      const lines = doc.splitTextToSize(yieldEst.assumption, pageW - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 10 + 12;
    }
  }

  // --- Companion planting ---------------------------------------------------
  const comp = planResult.companionship || {};
  const compRows = [];
  (comp.companions || []).forEach((c) =>
    compRows.push(["Good pair", `${c.plants[0]} + ${c.plants[1]}`, c.reason || ""]));
  (comp.antagonists || []).forEach((a) =>
    compRows.push(["Conflict", `${a.plants[0]} & ${a.plants[1]}`, a.reason || ""]));
  (comp.warnings || []).forEach((w) => compRows.push(["Note", "—", w]));
  if (compRows.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Type", "Plants", "Reason"]],
      body: compRows,
      theme: "striped",
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, textColor: PDF_DARK, valign: "top" },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 70, fontStyle: "bold" }, 1: { cellWidth: 120 } },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // --- Pest & disease advisory ---------------------------------------------
  const advisory = planResult.pestAdvisory || {};
  const pestRows = [];
  (advisory.risks || []).forEach((risk) => {
    (risk.issues || []).forEach((issue, i) => {
      pestRows.push([
        i === 0 ? risk.plant : "",
        `${issue.name} (${issue.type})`,
        issue.remedy || "",
        (issue.deterredBy || []).join(", ") || "—",
      ]);
    });
  });
  if (pestRows.length > 0) {
    if (advisory.climateNote) {
      doc.setFontSize(9);
      doc.setTextColor(...PDF_DARK);
      const noteLines = doc.splitTextToSize(
        `Climate note: ${advisory.climateNote}`,
        pageW - margin * 2
      );
      doc.text(noteLines, margin, y);
      y += noteLines.length * 11 + 8;
    }
    autoTable(doc, {
      startY: y,
      head: [["Crop", "Issue", "Organic remedy", "Helped by"]],
      body: pestRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 8.5, cellPadding: 4, textColor: PDF_DARK, valign: "top" },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 70, fontStyle: "bold" },
        1: { cellWidth: 95 },
        3: { cellWidth: 80, textColor: PDF_MUTED, fontSize: 8 },
      },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // --- Monthly cultivation calendar ----------------------------------------
  const months = planResult.monthlyCalendar || [];
  if (months.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Month", "Temp (min/max)", "Activities"]],
      body: months.map((m) => [
        m.month + (m.inSeason ? "  ★" : ""),
        `${m.averageMinTemp}°C / ${m.averageMaxTemp}°C`,
        (m.actions && m.actions.length > 0
          ? m.actions.map((a) => `${a.type} — ${a.plant}: ${a.text}`).join("\n")
          : "No activities planned."),
      ]),
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 8.5, cellPadding: 4, textColor: PDF_DARK, valign: "top" },
      headStyles: { fillColor: PDF_GREEN, textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 90, fontStyle: "bold" }, 1: { cellWidth: 100 } },
    });
  }

  // --- Footer on every page -------------------------------------------------
  const pageCount = doc.internal.getNumberOfPages();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...PDF_MUTED);
    doc.text("Generated by Urban Agri-Planner", margin, pageH - 20);
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 20, { align: "right" });
  }

  const slug = place.replace(/\s+/g, "-").toLowerCase() || "plan";
  doc.save(`agri-plan-${slug}.pdf`);
}

// Dependency-free interactive map: an OpenStreetMap embed centred on the
// geocoded coordinates with a marker. No API key or extra library required.
function LocationMap({ coordinates }) {
  const lat = coordinates?.latitude;
  const lon = coordinates?.longitude;
  if (lat == null || lon == null) return null;
  const d = 0.04;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;
  const link = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`;
  return (
    <div className="location-map">
      <iframe
        title="Location map"
        className="location-map-frame"
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <div className="location-map-meta">
        <span>
          <span className="material-symbols" style={{ fontSize: "16px", verticalAlign: "-3px" }}>my_location</span>
          &nbsp;{lat.toFixed(4)}, {lon.toFixed(4)}
        </span>
        <a href={link} target="_blank" rel="noreferrer">View larger map ↗</a>
      </div>
    </div>
  );
}

// Lightweight dependency-free network graph of companion / antagonist links.
// Plants are placed on a circle; green edges = good companions, red = antagonists.
function CompanionGraph({ selectedPlants, companionship }) {
  const plants = selectedPlants || [];
  const size = 360;
  const center = size / 2;
  const radius = plants.length > 1 ? size / 2 - 70 : 0;

  if (plants.length === 0) {
    return (
      <p className="no-actions text-center">No crops selected to graph.</p>
    );
  }

  const positions = {};
  plants.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / plants.length - Math.PI / 2;
    positions[p.name] = {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    };
  });

  const edge = (pair, type, idx) => {
    const a = positions[pair[0]];
    const b = positions[pair[1]];
    if (!a || !b) return null;
    return (
      <line
        key={`${type}-${idx}`}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        className={`graph-edge ${type}`}
      />
    );
  };

  return (
    <div className="companion-graph">
      <svg viewBox={`0 0 ${size} ${size}`} className="companion-graph-svg" role="img" aria-label="Companion planting graph">
        {(companionship.companions || []).map((c, i) => edge(c.plants, "good", i))}
        {(companionship.antagonists || []).map((a, i) => edge(a.plants, "bad", i))}
        {plants.map((p) => {
          const pos = positions[p.name];
          return (
            <g key={p.id} className="graph-node-group">
              <circle cx={pos.x} cy={pos.y} r={26} className="graph-node" />
              <text x={pos.x} y={pos.y + 42} className="graph-node-label" textAnchor="middle">
                {p.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="graph-legend">
        <span className="legend-item"><span className="legend-swatch good" /> Good companions</span>
        <span className="legend-item"><span className="legend-swatch bad" /> Avoid together</span>
      </div>
    </div>
  );
}

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
  const [companionView, setCompanionView] = useState("list");           // "list" | "graph"
  const [chatMessages, setChatMessages] = useState([]);                 // {role, text}
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

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
    setChatMessages([]);
    setChatInput("");
  };

  // Send a follow-up question about the finalised plan to the advisor agent.
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
      if (!response.ok) {
        throw new Error(data.detail || "The advisor could not answer.");
      }
      setChatMessages((prev) => [
        ...prev,
        { role: "advisor", text: data.reply, steps: data.steps || [] },
      ]);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { role: "advisor", text: `⚠️ ${err.message}`, error: true },
      ]);
    } finally {
      setChatLoading(false);
    }
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
              {planResult.climateYears && (
                <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "4px" }}>
                  Based on {planResult.climateYears.count}-year climate average
                  ({planResult.climateYears.start}–{planResult.climateYears.end}).
                </p>
              )}

              <LocationMap coordinates={planResult.coordinates} />

              {planResult.frostDates && (
                <div className="frost-row">
                  <div className="frost-box">
                    <span className="material-symbols frost-icon">ac_unit</span>
                    <div>
                      <div className="frost-label">Last spring frost</div>
                      <div className="frost-value">{planResult.frostDates.lastSpringFrost || "—"}</div>
                    </div>
                  </div>
                  <div className="frost-box">
                    <span className="material-symbols frost-icon">ac_unit</span>
                    <div>
                      <div className="frost-label">First autumn frost</div>
                      <div className="frost-value">{planResult.frostDates.firstAutumnFrost || "—"}</div>
                    </div>
                  </div>
                  <div className="frost-box">
                    <span className="material-symbols frost-icon" style={{ color: "#4a8c3d" }}>calendar_today</span>
                    <div>
                      <div className="frost-label">Frost-free days</div>
                      <div className="frost-value">
                        {planResult.frostDates.frostFreeDays != null ? `${planResult.frostDates.frostFreeDays}` : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {planResult.wateringAdvice && (
                <div className={`watering-advice ${planResult.wateringAdvice.level}`}>
                  <span className="material-symbols watering-icon">water_drop</span>
                  <div>
                    <strong>Watering advice (next 7 days)</strong>
                    <p>{planResult.wateringAdvice.advice}</p>
                    <span className="watering-meta">
                      {planResult.wateringAdvice.totalPrecipitationMm} mm forecast ·
                      {" "}{planResult.wateringAdvice.rainyDays} rainy day(s)
                      {planResult.wateringAdvice.avgMaxTempC != null
                        ? ` · avg max ${planResult.wateringAdvice.avgMaxTempC}°C`
                        : ""}
                    </span>
                  </div>
                </div>
              )}
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

            {/* Estimated harvest & grocery savings */}
            {planResult.yieldEstimate && (planResult.yieldEstimate.crops || []).length > 0 && (
              <div className="glass-card">
                <h2 className="card-title">
                  <span className="material-symbols">savings</span> Harvest &amp; Savings
                </h2>
                <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "16px" }}>
                  Estimated full-season harvest for your selection and what buying the
                  same produce would cost.
                </p>

                <div className="yield-totals">
                  <div className="yield-total-card">
                    <span className="material-symbols yt-icon" style={{ color: "#4a8c3d" }}>nutrition</span>
                    <div>
                      <div className="yt-value">{planResult.yieldEstimate.totalYieldKg} kg</div>
                      <div className="yt-label">Estimated harvest</div>
                    </div>
                  </div>
                  <div className="yield-total-card">
                    <span className="material-symbols yt-icon" style={{ color: "#b06a16" }}>savings</span>
                    <div>
                      <div className="yt-value">€{planResult.yieldEstimate.totalValueEur}</div>
                      <div className="yt-label">Grocery value / year</div>
                    </div>
                  </div>
                </div>

                <div className="yield-list">
                  {(planResult.yieldEstimate.crops || []).map((row, idx) => (
                    <div key={idx} className="yield-row">
                      <span className="yield-name">{row.plant}</span>
                      {row.ornamental ? (
                        <span className="yield-meta" style={{ color: "var(--text-muted)" }}>
                          companion / ornamental
                        </span>
                      ) : (
                        <span className="yield-meta">
                          {row.yieldKg} kg · €{row.valueEur}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <p className="yield-assumption">{planResult.yieldEstimate.assumption}</p>
              </div>
            )}

            {/* Companion planting & suggestions */}
            <div className="glass-card">
              <h2 className="card-title">
                <span className="material-symbols">groups</span> Companion Planting & Alerts
              </h2>
              <p className="narrative-comment">{planResult.plannerComment}</p>

              <div className="companion-toggle" role="group" aria-label="Companion view">
                <button
                  type="button"
                  className={`seg ${companionView === "list" ? "active" : ""}`}
                  onClick={() => setCompanionView("list")}
                >
                  <span className="material-symbols">list</span> <span className="seg-label">List</span>
                </button>
                <button
                  type="button"
                  className={`seg ${companionView === "graph" ? "active" : ""}`}
                  onClick={() => setCompanionView("graph")}
                >
                  <span className="material-symbols">hub</span> <span className="seg-label">Graph</span>
                </button>
              </div>

              {companionView === "graph" ? (
                <CompanionGraph
                  selectedPlants={planResult.selectedPlants}
                  companionship={planResult.companionship}
                />
              ) : (
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
              )}
            </div>

            {/* Pest & disease advisory */}
            {planResult.pestAdvisory && (planResult.pestAdvisory.risks || []).length > 0 && (
              <div className="glass-card">
                <h2 className="card-title">
                  <span className="material-symbols">pest_control</span> Pest &amp; Disease Advisor
                </h2>
                <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "16px" }}>
                  Common issues for your crops, with organic remedies — plus which of
                  your plants naturally help keep them in check.
                </p>

                {planResult.pestAdvisory.climateNote && (
                  <div className="pest-climate-note">
                    <span className="material-symbols">thermostat</span>
                    <p>{planResult.pestAdvisory.climateNote}</p>
                  </div>
                )}

                <div className="pest-list">
                  {planResult.pestAdvisory.risks.map((risk, idx) => (
                    <div key={idx} className="pest-crop">
                      <div className="pest-crop-name">{risk.plant}</div>
                      {risk.issues.map((issue, j) => (
                        <div key={j} className="pest-issue">
                          <div className="pest-issue-head">
                            <span className={`pest-tag ${issue.type}`}>{issue.type}</span>
                            <span className="pest-issue-name">{issue.name}</span>
                          </div>
                          <p className="pest-remedy">{issue.remedy}</p>
                          {issue.deterredBy.length > 0 && (
                            <div className="pest-allies">
                              <span className="material-symbols" style={{ fontSize: "16px", color: "var(--new-leaf)", verticalAlign: "-3px" }}>shield</span>
                              &nbsp;Helped by:&nbsp;
                              {issue.deterredBy.map((ally, k) => (
                                <span key={k} className="pest-ally-chip">{ally}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {(planResult.pestAdvisory.protectiveAllies || []).length > 0 && (
                  <div className="pest-allies-summary">
                    <strong>Your protective allies:</strong>{" "}
                    {planResult.pestAdvisory.protectiveAllies
                      .map((a) => `${a.plant} (${a.deters.join(", ")})`)
                      .join(" · ")}
                  </div>
                )}

                {(planResult.pestAdvisory.tips || []).length > 0 && (
                  <ul className="pest-tips">
                    {planResult.pestAdvisory.tips.map((tip, idx) => (
                      <li key={idx}>{tip}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Right Column: Monthly Calendar Timeline */}
          <div className="glass-card">
            <div className="calendar-header">
              <h2 className="card-title" style={{ marginBottom: 0, border: "none" }}>
                <span className="material-symbols">calendar_month</span> Optimised Cultivation Calendar
              </h2>
              <div className="calendar-export">
                <button
                  type="button"
                  className="btn-export"
                  onClick={() => downloadICS(planResult)}
                  title="Download as .ics calendar"
                >
                  <span className="material-symbols">download</span> .ics
                </button>
                <button
                  type="button"
                  className="btn-export"
                  onClick={() => downloadPDF(planResult)}
                  title="Download cultivation plan as PDF"
                >
                  <span className="material-symbols">picture_as_pdf</span> PDF
                </button>
              </div>
            </div>
            
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

          {/* Follow-up advisor chat */}
          <div className="glass-card chat-card">
            <h2 className="card-title">
              <span className="material-symbols">forum</span> Ask the Garden Advisor
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "16px" }}>
              Ask follow-up questions about your plan — substitutions, companions,
              watering, timing. Answers are re-validated against your climate and crops.
            </p>

            <div className="chat-window">
              {chatMessages.length === 0 && (
                <div className="chat-empty">
                  Try: <em>“Can I swap basil for mint?”</em> or
                  {" "}<em>“Which crop needs the least water?”</em>
                </div>
              )}
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`chat-bubble ${msg.role}${msg.error ? " error" : ""}`}>
                  {msg.role === "advisor" && (
                    <span className="material-symbols chat-avatar">eco</span>
                  )}
                  <div className="chat-text">
                    {msg.text}
                    {msg.steps && msg.steps.length > 0 && (
                      <div className="chat-tools">
                        {msg.steps
                          .filter((s) => s.type === "tool_call")
                          .map((s, j) => (
                            <span key={j} className="chat-tool-chip">
                              <span className="material-symbols" style={{ fontSize: "13px", verticalAlign: "-2px" }}>build</span>
                              &nbsp;{s.tool}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="chat-bubble advisor">
                  <span className="material-symbols chat-avatar">eco</span>
                  <div className="chat-text chat-typing">Thinking…</div>
                </div>
              )}
            </div>

            <form
              className="chat-input-row"
              onSubmit={(e) => {
                e.preventDefault();
                sendChatMessage();
              }}
            >
              <input
                type="text"
                className="chat-input"
                placeholder="Ask about your cultivation plan…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={chatLoading}
                maxLength={1000}
              />
              <button
                type="submit"
                className="btn-chat-send"
                disabled={chatLoading || !chatInput.trim()}
              >
                <span className="material-symbols">send</span>
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

export default App;

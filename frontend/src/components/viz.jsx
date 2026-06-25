import React, { useState } from "react";

// ---------------------------------------------------------------------------
// LocationMap — dependency-free OpenStreetMap embed centred on the geocoded
// coordinates with a marker. No API key or extra library required.
// ---------------------------------------------------------------------------
export function LocationMap({ coordinates }) {
  const lat = coordinates?.latitude ?? coordinates?.lat;
  const lon = coordinates?.longitude ?? coordinates?.lon;
  if (lat == null || lon == null) return null;
  const d = 0.04;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;
  const link = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`;
  return (
    <div className="map">
      <iframe
        title="Location map"
        className="map__frame"
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <div className="map__meta">
        <span className="mono">
          {Number(lat).toFixed(4)}, {Number(lon).toFixed(4)}
        </span>
        <a href={link} target="_blank" rel="noreferrer">
          Open in OpenStreetMap ↗
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompanionGraph — lightweight network graph of companion / antagonist links.
// Plants are placed on a circle; green edges = good companions, clay = avoid.
// ---------------------------------------------------------------------------
export function CompanionGraph({ selectedPlants, companionship }) {
  const plants = selectedPlants || [];
  const size = 360;
  const center = size / 2;
  const radius = plants.length > 1 ? size / 2 - 64 : 0;

  if (plants.length === 0) {
    return <p className="empty-note">No crops selected to graph.</p>;
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
        className={`graph__edge graph__edge--${type}`}
      />
    );
  };

  return (
    <div className="graph">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="graph__svg"
        role="img"
        aria-label="Companion planting graph"
      >
        {(companionship.companions || []).map((c, i) => edge(c.plants, "good", i))}
        {(companionship.antagonists || []).map((a, i) => edge(a.plants, "bad", i))}
        {plants.map((p) => {
          const pos = positions[p.name];
          return (
            <g key={p.id} className="graph__node-group">
              <circle cx={pos.x} cy={pos.y} r={24} className="graph__node" />
              <text x={pos.x} y={pos.y + 40} className="graph__label" textAnchor="middle">
                {p.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="graph__legend">
        <span className="legend-item">
          <span className="legend-swatch legend-swatch--good" /> Help each other
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-swatch--bad" /> Keep apart
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// YearRibbon — the signature element. A horizontal 12-month band that shows,
// at a glance, what happens each month. Each month carries coloured dots for
// the kinds of work it holds (sow / harvest / care); the current month is
// marked; clicking a month reveals its full action list below.
// ---------------------------------------------------------------------------
const MONTH_ORDER = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function actionCategory(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("sow")) return "sow";
  if (t.includes("harvest")) return "harvest";
  return "care"; // maintenance, protection, watering / shading
}

const CATEGORY_LABEL = { sow: "Sow", harvest: "Harvest", care: "Care" };

export function YearRibbon({ monthlyCalendar }) {
  const months = monthlyCalendar || [];
  const byMonth = {};
  months.forEach((m) => {
    const key = String(m.month || "").slice(0, 3);
    byMonth[key] = m;
  });

  const currentIdx = new Date().getMonth();

  // Default selection: current month if it has actions, else first month with actions.
  const firstActive = months.findIndex((m) => (m.actions || []).length > 0);
  const currentKey = MONTH_ORDER[currentIdx];
  const defaultIdx =
    (byMonth[currentKey]?.actions?.length ?? 0) > 0
      ? MONTH_ORDER.indexOf(currentKey)
      : firstActive >= 0
      ? firstActive
      : 0;

  const [selected, setSelected] = useState(defaultIdx);
  const selectedMonth = months[selected];

  return (
    <div className="ribbon">
      <div className="ribbon__track" role="tablist" aria-label="Year at a glance">
        {MONTH_ORDER.map((abbr, idx) => {
          const data = byMonth[abbr] || months[idx];
          const actions = data?.actions || [];
          const cats = new Set(actions.map((a) => actionCategory(a.type)));
          const isCurrent = idx === currentIdx;
          const isSelected = idx === selected;
          return (
            <button
              key={abbr}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={`ribbon__cell${isSelected ? " is-selected" : ""}${
                data?.inSeason ? " is-season" : ""
              }${actions.length === 0 ? " is-empty" : ""}`}
              onClick={() => setSelected(idx)}
            >
              <span className="ribbon__month">{abbr}</span>
              <span className="ribbon__dots">
                {["sow", "harvest", "care"].map((c) =>
                  cats.has(c) ? <span key={c} className={`dot dot--${c}`} /> : null
                )}
                {actions.length === 0 && <span className="dot dot--none" />}
              </span>
              {isCurrent && <span className="ribbon__now">now</span>}
            </button>
          );
        })}
      </div>

      <div className="ribbon__legend">
        <span className="legend-item"><span className="dot dot--sow" /> Sow</span>
        <span className="legend-item"><span className="dot dot--harvest" /> Harvest</span>
        <span className="legend-item"><span className="dot dot--care" /> Care</span>
      </div>

      {selectedMonth && (
        <div className="ribbon__detail">
          <div className="ribbon__detail-head">
            <h4>{selectedMonth.month}</h4>
            <span className="mono ribbon__temp">
              {selectedMonth.averageMinTemp}° / {selectedMonth.averageMaxTemp}°C
            </span>
            {selectedMonth.inSeason && <span className="tag tag--season">In season</span>}
          </div>
          {(selectedMonth.actions || []).length > 0 ? (
            <ul className="ribbon__actions">
              {selectedMonth.actions.map((a, i) => (
                <li key={i} className="ribbon__action">
                  <span className={`chip chip--${actionCategory(a.type)}`}>
                    {CATEGORY_LABEL[actionCategory(a.type)]}
                  </span>
                  <span className="ribbon__action-text">
                    <strong>{a.plant}</strong> — {a.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">Nothing to do this month — let things grow.</p>
          )}
        </div>
      )}
    </div>
  );
}

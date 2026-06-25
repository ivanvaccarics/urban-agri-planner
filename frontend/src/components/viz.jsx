import React, { useState } from "react";
import { useT } from "../lib/i18n";

// ---------------------------------------------------------------------------
// LocationMap — dependency-free OpenStreetMap embed centred on the geocoded
// coordinates with a marker. No API key or extra library required.
// ---------------------------------------------------------------------------
export function LocationMap({ coordinates }) {
  const { t } = useT();
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
          {t("map.open")}
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
  const { t } = useT();
  const plants = selectedPlants || [];
  const size = 360;
  const center = size / 2;
  const radius = plants.length > 1 ? size / 2 - 64 : 0;

  if (plants.length === 0) {
    return <p className="empty-note">{t("graph.empty")}</p>;
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
          <span className="legend-swatch legend-swatch--good" /> {t("graph.help")}
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-swatch--bad" /> {t("graph.apart")}
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
const MONTH_ABBR = {
  en: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  it: ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"],
};

function actionCategory(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("sow")) return "sow";
  if (t.includes("harvest")) return "harvest";
  return "care"; // maintenance, protection, watering / shading
}

export function YearRibbon({ monthlyCalendar }) {
  const { t, lang } = useT();
  const monthOrder = MONTH_ABBR[lang] || MONTH_ABBR.en;
  const catLabel = { sow: t("ribbon.sow"), harvest: t("ribbon.harvest"), care: t("ribbon.care") };
  const months = monthlyCalendar || [];

  const currentIdx = new Date().getMonth();

  // The calendar is always 12 ordered entries, so index by position rather than
  // by name — that stays correct regardless of the language month names use.
  const firstActive = months.findIndex((m) => (m.actions || []).length > 0);
  const defaultIdx =
    (months[currentIdx]?.actions?.length ?? 0) > 0
      ? currentIdx
      : firstActive >= 0
      ? firstActive
      : 0;

  const [selected, setSelected] = useState(defaultIdx);
  const selectedMonth = months[selected];

  return (
    <div className="ribbon">
      <div className="ribbon__track" role="tablist" aria-label="Year at a glance">
        {monthOrder.map((abbr, idx) => {
          const data = months[idx];
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
              {isCurrent && <span className="ribbon__now">{t("ribbon.now")}</span>}
            </button>
          );
        })}
      </div>

      <div className="ribbon__legend">
        <span className="legend-item"><span className="dot dot--sow" /> {t("ribbon.sow")}</span>
        <span className="legend-item"><span className="dot dot--harvest" /> {t("ribbon.harvest")}</span>
        <span className="legend-item"><span className="dot dot--care" /> {t("ribbon.care")}</span>
      </div>

      {selectedMonth && (
        <div className="ribbon__detail">
          <div className="ribbon__detail-head">
            <h4>{selectedMonth.month}</h4>
            <span className="mono ribbon__temp">
              {selectedMonth.averageMinTemp}° / {selectedMonth.averageMaxTemp}°C
            </span>
            {selectedMonth.inSeason && <span className="tag tag--season">{t("ribbon.inSeason")}</span>}
          </div>
          {(selectedMonth.actions || []).length > 0 ? (
            <ul className="ribbon__actions">
              {selectedMonth.actions.map((a, i) => (
                <li key={i} className="ribbon__action">
                  <span className={`chip chip--${actionCategory(a.type)}`}>
                    {catLabel[actionCategory(a.type)]}
                  </span>
                  <span className="ribbon__action-text">
                    <strong>{a.plant}</strong> — {a.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">{t("ribbon.nothing")}</p>
          )}
        </div>
      )}
    </div>
  );
}

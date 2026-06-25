import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

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

export { buildICS, downloadICS, downloadPDF };

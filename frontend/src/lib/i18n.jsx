import React, { createContext, useContext, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Lightweight i18n. Static UI chrome only — backend-generated content
// (plant names, agent comments, schedule dates) is returned by the API in its
// own language and rendered as-is.
// Keys support {var} interpolation.
// ---------------------------------------------------------------------------

const DICT = {
  en: {
    "appbar.newPlan": "New plan",
    "appbar.zone": "Zone {zone}",

    "stepper.space": "Your space",
    "stepper.review": "Review & approve",
    "stepper.plan": "Your plan",

    "intake.eyebrow": "Multi-agent growing planner",
    "intake.headline.l1": "Tell us about your balcony.",
    "intake.headline.l2": "We'll plan the whole growing year.",
    "intake.sub": "AI agents cross-reference a decade of local climate, your light and exposure, and the needs of 78 crops — then a reviewer critiques the picks before you approve them.",
    "intake.point.climate": "Grounded in your address's real microclimate",
    "intake.point.review": "Independently reviewed, approved by you",
    "intake.point.savings": "Harvest, savings and pest advice included",

    "form.address.label": "Where is your space?",
    "form.address.placeholder": "Street, city — e.g. Via Roma 10, Milan",
    "form.address.hint": "We use this to look up your climate and frost dates.",
    "form.sun.label": "How much direct sun?",
    "form.sun.unit": "{n} h/day",
    "form.sun.shade": "Shade",
    "form.sun.part": "Part sun",
    "form.sun.full": "Full sun",
    "form.exposure.label": "Which way does it face?",
    "form.season.label": "When do you want to start?",
    "form.setup.label": "Growing setup",
    "form.setup.outdoor": "Outdoor",
    "form.setup.greenhouse": "Greenhouse",
    "form.submit": "Generate my plan",
    "form.error.title": "Couldn't build the plan.",

    "loading.title": "Planning your growing year",
    "loading.sub": "The agents are querying the climate and botanical servers…",

    "checkpoint.pill": "Your approval needed",
    "checkpoint.defaultTitle": "Review the suggested crops",
    "checkpoint.defaultMsg": "The planner paused before finalising. Keep, add or drop crops, then approve.",
    "checkpoint.min": "Min {t}°C",
    "checkpoint.reviewer": "Reviewer agent · independent critique",
    "checkpoint.strengths": "Strengths",
    "checkpoint.concerns": "Watch outs",
    "checkpoint.ideas": "Ideas",
    "checkpoint.chooseCrops": "Choose your crops",
    "checkpoint.selected": "{n} selected",
    "checkpoint.chooseHint": "Suggested crops are pre-selected. Tap a card to add or remove it.",
    "checkpoint.rejectAll": "Reject all",
    "checkpoint.generating": "Generating…",
    "checkpoint.approveBuild": "Approve & build plan",
    "checkpoint.approveSelection": "Approve my selection",
    "checkpoint.rejectedTitle": "Selection rejected",
    "checkpoint.rejectedMsg": "No plan was generated.",
    "checkpoint.startOver": "Start over",

    "crop.suggested": "Suggested",

    "security.skipped": "No approval checkpoint was triggered",
    "security.adjusted": "Approved by you — you adjusted the selection",
    "security.approved": "Approved by you at the safety checkpoint",

    "tab.overview": "Overview",
    "tab.calendar": "Calendar",
    "tab.crops": "Crops",
    "tab.companions": "Companions",
    "tab.pests": "Pests",
    "tab.savings": "Savings",
    "tab.ask": "Ask",

    "overview.glance": "At a glance",
    "overview.zone": "USDA zone",
    "overview.frostFree": "Frost-free days",
    "overview.harvest": "Est. harvest",
    "overview.value": "Grocery value",
    "overview.crops": "{n} crops",
    "overview.seeCalendar": "See the growing calendar",
    "overview.location": "Your location",
    "overview.climateAvg": "{n}-year climate average ({start}–{end})",
    "overview.lastFrost": "Last spring frost",
    "overview.firstFrost": "First autumn frost",
    "overview.next7": "Next 7 days",
    "overview.rainy": "{mm} mm · {days} rainy day(s)",
    "overview.maxTemp": " · max {t}°C",
    "overview.activityTitle": "Behind the plan — agent activity ({n} steps)",

    "calendar.title": "Your growing year",
    "calendar.tapMonth": "Tap a month to see exactly what to do.",
    "calendar.scheduleTitle": "Planting schedule",
    "calendar.scheduleSub": "When to put each crop out and when to harvest{gh}.",
    "calendar.scheduleSub.gh": " · greenhouse",
    "calendar.putOut": "Put out",
    "calendar.harvest": "Harvest",
    "calendar.inSeason": "In season",
    "calendar.noCrops": "No crops scheduled.",

    "crops.title": "Crops in your plan",
    "crops.growing": "{n} growing",
    "crops.sub": "Highlighted crops were approved and drive your calendar. The rest were analysed but left out.",

    "companions.title": "Companion planting",
    "companions.list": "List",
    "companions.graph": "Graph",
    "companions.empty": "No notable companion relationships for this selection.",
    "companions.note": "Botanist's note",

    "pests.title": "Pests & diseases",
    "pests.sub": "Common issues for your crops with organic remedies — and which plants help keep them down.",
    "pests.helpedBy": "Helped by:",
    "pests.allies": "Your protective allies:",

    "savings.title": "Harvest & savings",
    "savings.sub": "A full-season estimate for your selection — and what the same produce would cost at the shop.",
    "savings.harvest": "Estimated harvest",
    "savings.value": "Grocery value / year",
    "savings.companion": "companion",

    "ask.title": "Ask the garden advisor",
    "ask.sub": "Follow-up questions about your plan — substitutions, watering, timing. Answers are re-checked against your climate and crops.",
    "ask.empty": "Try “Can I swap basil for mint?” or “Which crop needs the least water?”",
    "ask.placeholder": "Ask about your plan…",
    "ask.error": "The advisor could not answer.",

    "ribbon.sow": "Sow",
    "ribbon.harvest": "Harvest",
    "ribbon.care": "Care",
    "ribbon.now": "now",
    "ribbon.nothing": "Nothing to do this month — let things grow.",
    "ribbon.inSeason": "In season",

    "graph.empty": "No crops selected to graph.",
    "graph.help": "Help each other",
    "graph.apart": "Keep apart",
    "map.open": "Open in OpenStreetMap ↗",

    "exp.South": "Full sun, all day",
    "exp.South-East": "Sun until early afternoon",
    "exp.South-West": "Sun from midday on",
    "exp.East": "Morning sun",
    "exp.West": "Afternoon sun",
    "exp.North-East": "Soft morning light",
    "exp.North-West": "Soft evening light",
    "exp.North": "Mostly shade",

    "season.Spring": "Spring",
    "season.Summer": "Summer",
    "season.Autumn": "Autumn",
    "season.Winter": "Winter",
    "season.Spring.range": "Mar–May",
    "season.Summer.range": "Jun–Aug",
    "season.Autumn.range": "Sep–Nov",
    "season.Winter.range": "Dec–Feb",

    "err.unexpected": "Unexpected response from the server.",
    "err.plan": "Unable to compute the cultivation plan.",
    "err.confirm": "Error during confirmation.",
  },

  it: {
    "appbar.newPlan": "Nuovo piano",
    "appbar.zone": "Zona {zone}",

    "stepper.space": "Il tuo spazio",
    "stepper.review": "Rivedi e approva",
    "stepper.plan": "Il tuo piano",

    "intake.eyebrow": "Pianificatore colturale multi-agente",
    "intake.headline.l1": "Raccontaci del tuo balcone.",
    "intake.headline.l2": "Pianifichiamo l'intero anno di coltivazione.",
    "intake.sub": "Gli agenti AI incrociano un decennio di clima locale, la tua luce ed esposizione e le esigenze di 78 colture — poi un revisore critica le scelte prima che tu le approvi.",
    "intake.point.climate": "Basato sul microclima reale del tuo indirizzo",
    "intake.point.review": "Revisionato in modo indipendente, approvato da te",
    "intake.point.savings": "Inclusi raccolto, risparmi e consigli antiparassitari",

    "form.address.label": "Dov'è il tuo spazio?",
    "form.address.placeholder": "Via, città — es. Via Roma 10, Milano",
    "form.address.hint": "Lo usiamo per trovare il clima e le date di gelo.",
    "form.sun.label": "Quanto sole diretto?",
    "form.sun.unit": "{n} h/giorno",
    "form.sun.shade": "Ombra",
    "form.sun.part": "Mezz'ombra",
    "form.sun.full": "Pieno sole",
    "form.exposure.label": "Verso dove è esposto?",
    "form.season.label": "Quando vuoi iniziare?",
    "form.setup.label": "Tipo di coltivazione",
    "form.setup.outdoor": "All'aperto",
    "form.setup.greenhouse": "Serra",
    "form.submit": "Genera il mio piano",
    "form.error.title": "Impossibile creare il piano.",

    "loading.title": "Pianificazione del tuo anno di coltivazione",
    "loading.sub": "Gli agenti stanno interrogando i server climatico e botanico…",

    "checkpoint.pill": "Serve la tua approvazione",
    "checkpoint.defaultTitle": "Rivedi le colture suggerite",
    "checkpoint.defaultMsg": "Il pianificatore si è fermato prima di concludere. Mantieni, aggiungi o togli colture, poi approva.",
    "checkpoint.min": "Min {t}°C",
    "checkpoint.reviewer": "Agente revisore · critica indipendente",
    "checkpoint.strengths": "Punti di forza",
    "checkpoint.concerns": "Attenzioni",
    "checkpoint.ideas": "Idee",
    "checkpoint.chooseCrops": "Scegli le tue colture",
    "checkpoint.selected": "{n} selezionate",
    "checkpoint.chooseHint": "Le colture suggerite sono preselezionate. Tocca una scheda per aggiungerla o rimuoverla.",
    "checkpoint.rejectAll": "Rifiuta tutto",
    "checkpoint.generating": "Generazione…",
    "checkpoint.approveBuild": "Approva e crea il piano",
    "checkpoint.approveSelection": "Approva la mia selezione",
    "checkpoint.rejectedTitle": "Selezione rifiutata",
    "checkpoint.rejectedMsg": "Nessun piano è stato generato.",
    "checkpoint.startOver": "Ricomincia",

    "crop.suggested": "Suggerita",

    "security.skipped": "Nessun checkpoint di approvazione attivato",
    "security.adjusted": "Approvato da te — hai modificato la selezione",
    "security.approved": "Approvato da te al checkpoint di sicurezza",

    "tab.overview": "Riepilogo",
    "tab.calendar": "Calendario",
    "tab.crops": "Colture",
    "tab.companions": "Consociazioni",
    "tab.pests": "Parassiti",
    "tab.savings": "Risparmi",
    "tab.ask": "Chiedi",

    "overview.glance": "In sintesi",
    "overview.zone": "Zona USDA",
    "overview.frostFree": "Giorni senza gelo",
    "overview.harvest": "Raccolto stim.",
    "overview.value": "Valore al mercato",
    "overview.crops": "{n} colture",
    "overview.seeCalendar": "Vedi il calendario di coltivazione",
    "overview.location": "La tua posizione",
    "overview.climateAvg": "Media climatica su {n} anni ({start}–{end})",
    "overview.lastFrost": "Ultima gelata primaverile",
    "overview.firstFrost": "Prima gelata autunnale",
    "overview.next7": "Prossimi 7 giorni",
    "overview.rainy": "{mm} mm · {days} giorno/i di pioggia",
    "overview.maxTemp": " · max {t}°C",
    "overview.activityTitle": "Dietro il piano — attività degli agenti ({n} passi)",

    "calendar.title": "Il tuo anno di coltivazione",
    "calendar.tapMonth": "Tocca un mese per vedere esattamente cosa fare.",
    "calendar.scheduleTitle": "Calendario di semina",
    "calendar.scheduleSub": "Quando mettere a dimora ogni coltura e quando raccogliere{gh}.",
    "calendar.scheduleSub.gh": " · serra",
    "calendar.putOut": "Metti a dimora",
    "calendar.harvest": "Raccolta",
    "calendar.inSeason": "In stagione",
    "calendar.noCrops": "Nessuna coltura pianificata.",

    "crops.title": "Colture nel tuo piano",
    "crops.growing": "{n} in coltivazione",
    "crops.sub": "Le colture evidenziate sono state approvate e guidano il calendario. Le altre sono state analizzate ma escluse.",

    "companions.title": "Consociazione delle piante",
    "companions.list": "Elenco",
    "companions.graph": "Grafico",
    "companions.empty": "Nessuna consociazione rilevante per questa selezione.",
    "companions.note": "Nota del botanico",

    "pests.title": "Parassiti e malattie",
    "pests.sub": "Problemi comuni per le tue colture con rimedi biologici — e quali piante aiutano a tenerli sotto controllo.",
    "pests.helpedBy": "Aiutato da:",
    "pests.allies": "I tuoi alleati protettivi:",

    "savings.title": "Raccolto e risparmi",
    "savings.sub": "Una stima per l'intera stagione della tua selezione — e quanto costerebbe lo stesso prodotto al negozio.",
    "savings.harvest": "Raccolto stimato",
    "savings.value": "Valore al mercato / anno",
    "savings.companion": "consociata",

    "ask.title": "Chiedi al consulente del giardino",
    "ask.sub": "Domande di approfondimento sul tuo piano — sostituzioni, irrigazione, tempistiche. Le risposte vengono verificate sul tuo clima e sulle tue colture.",
    "ask.empty": "Prova “Posso sostituire il basilico con la menta?” o “Quale coltura ha bisogno di meno acqua?”",
    "ask.placeholder": "Chiedi qualcosa sul tuo piano…",
    "ask.error": "Il consulente non è riuscito a rispondere.",

    "ribbon.sow": "Semina",
    "ribbon.harvest": "Raccolta",
    "ribbon.care": "Cura",
    "ribbon.now": "ora",
    "ribbon.nothing": "Niente da fare questo mese — lascia crescere.",
    "ribbon.inSeason": "In stagione",

    "graph.empty": "Nessuna coltura selezionata da rappresentare.",
    "graph.help": "Si aiutano a vicenda",
    "graph.apart": "Da tenere separate",
    "map.open": "Apri in OpenStreetMap ↗",

    "exp.South": "Pieno sole, tutto il giorno",
    "exp.South-East": "Sole fino al primo pomeriggio",
    "exp.South-West": "Sole da mezzogiorno in poi",
    "exp.East": "Sole del mattino",
    "exp.West": "Sole del pomeriggio",
    "exp.North-East": "Luce soffusa del mattino",
    "exp.North-West": "Luce soffusa della sera",
    "exp.North": "Per lo più ombra",

    "season.Spring": "Primavera",
    "season.Summer": "Estate",
    "season.Autumn": "Autunno",
    "season.Winter": "Inverno",
    "season.Spring.range": "Mar–Mag",
    "season.Summer.range": "Giu–Ago",
    "season.Autumn.range": "Set–Nov",
    "season.Winter.range": "Dic–Feb",

    "err.unexpected": "Risposta inattesa dal server.",
    "err.plan": "Impossibile calcolare il piano di coltivazione.",
    "err.confirm": "Errore durante la conferma.",
  },
};

const LanguageContext = createContext(null);

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => {
    try {
      const stored = localStorage.getItem("uap-lang");
      if (stored) return stored;
      return (navigator.language || "en").toLowerCase().startsWith("it") ? "it" : "en";
    } catch {
      return "en";
    }
  });

  useEffect(() => {
    try { localStorage.setItem("uap-lang", lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
  }, [lang]);

  const t = (key, vars) => {
    const table = DICT[lang] || DICT.en;
    const str = table[key] ?? DICT.en[key] ?? key;
    return interpolate(str, vars);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useT() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useT must be used within LanguageProvider");
  return ctx;
}

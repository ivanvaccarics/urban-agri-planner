"""Backend localization for generated, user-facing text.

Two kinds of text reach the user from the backend:

1. **LLM-generated** prose (agent comments, the reviewer's critique, the chat
   advisor's replies). These are localized by appending a language directive to
   the message we send the model — see :func:`language_directive`.

2. **Python-templated** narrative (the cultivation calendar actions, the
   planting-schedule note, the yield assumption, the pest climate note and
   tips, the watering advice). These are localized here via :func:`tr` plus the
   localized :data:`MONTHS` / :data:`MONTH_ABBR` tables.

Data that originates in ``db.json`` (plant names, scientific names, pest names
and remedies, companion reasons) is *not* translated here — it is returned in
its source language. Structural keys such as a calendar action's ``type`` are
kept stable (English) because the frontend maps them to categories/CSS classes.
"""

from __future__ import annotations

SUPPORTED_LANGS = ("en", "it")
DEFAULT_LANG = "en"


def normalize_lang(lang: str | None) -> str:
    """Return a supported language code, defaulting to English."""
    code = (lang or "").strip().lower()[:2]
    return code if code in SUPPORTED_LANGS else DEFAULT_LANG


MONTHS: dict[str, list[str]] = {
    "en": [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ],
    "it": [
        "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
        "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre",
    ],
}

MONTH_ABBR: dict[str, list[str]] = {
    "en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    "it": ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu",
           "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
}


def months(lang: str | None) -> list[str]:
    return MONTHS[normalize_lang(lang)]


def month_abbr(lang: str | None) -> list[str]:
    return MONTH_ABBR[normalize_lang(lang)]


def language_directive(lang: str | None) -> str:
    """Return an instruction to append to an LLM message to set its language.

    Empty for English (the models' default). For Italian it asks the model to
    write its prose in Italian while leaving plant and scientific names intact.
    """
    if normalize_lang(lang) == "it":
        return (
            "\n\nIMPORTANTE: scrivi tutte le tue risposte, riepiloghi e "
            "spiegazioni in italiano. Mantieni invariati i nomi delle piante e "
            "i nomi scientifici."
        )
    return ""


# Template strings keyed by a stable id. Each entry maps a language code to a
# ``str.format``-style template. Use :func:`tr` to render one.
_TEMPLATES: dict[str, dict[str, str]] = {
    # -- Calendar action texts ------------------------------------------------
    "cal.sow": {
        "en": ("Sow the {plant} in a pot (min diameter {pot} cm). This month's "
               "local climate ({tmin}°C - {tmax}°C) is ideal."),
        "it": ("Semina la {plant} in vaso (diametro minimo {pot} cm). Il clima "
               "locale di questo mese ({tmin}°C - {tmax}°C) è ideale."),
    },
    "cal.sow.gh": {
        "en": " The greenhouse keeps it warm enough to sow this early.",
        "it": " La serra mantiene il calore sufficiente per seminare così presto.",
    },
    "cal.protectedSow": {
        "en": ("Start the {plant} in a sheltered seed tray indoors. Outdoors it "
               "is still too cold ({tmin}°C, minimum required: {req}°C)."),
        "it": ("Avvia la {plant} in un semenzaio riparato al chiuso. All'aperto "
               "è ancora troppo freddo ({tmin}°C, minimo richiesto: {req}°C)."),
    },
    "cal.protection": {
        "en": ("Protect the {plant}. Minimum temperatures drop to {tmin}°C "
               "(below its tolerance threshold of {req}°C). Move the pot indoors "
               "or use a horticultural fleece cover."),
        "it": ("Proteggi la {plant}. Le temperature minime scendono a {tmin}°C "
               "(sotto la soglia di tolleranza di {req}°C). Sposta il vaso al "
               "chiuso o usa un telo di tessuto-non-tessuto."),
    },
    "cal.watering": {
        "en": ("Intense heat ({tmax}°C). Water the {plant} generously during the "
               "cooler hours (morning/evening) and consider shading it if it "
               "shows signs of stress."),
        "it": ("Caldo intenso ({tmax}°C). Annaffia la {plant} abbondantemente "
               "nelle ore più fresche (mattino/sera) e valuta di ombreggiarla se "
               "mostra segni di stress."),
    },
    "cal.maintenance": {
        "en": ("Active growth for the {plant}. Water regularly (needs: "
               "{watering}) and remove any weeds."),
        "it": ("Crescita attiva per la {plant}. Annaffia regolarmente "
               "(fabbisogno: {watering}) ed elimina le erbacce."),
    },
    "cal.harvest": {
        "en": ("Harvest time for the {plant}! Pick the leaves or fruit regularly "
               "to encourage the plant to keep producing."),
        "it": ("È tempo di raccolta per la {plant}! Raccogli foglie o frutti "
               "regolarmente per stimolare la pianta a continuare a produrre."),
    },
    # -- Planting schedule ----------------------------------------------------
    "sched.ghNote": {
        "en": ("Greenhouse: you can usually sow a few weeks earlier and harvest "
               "later than the outdoor window shown."),
        "it": ("Serra: di solito puoi seminare qualche settimana prima e "
               "raccogliere più tardi rispetto alla finestra all'aperto indicata."),
    },
    # -- Yield estimate -------------------------------------------------------
    "yield.assumption": {
        "en": ("Estimates assume {n} plant(s) per crop over a full growing "
               "season. Actual yields vary with care, variety, pot size and "
               "weather. Ornamental/companion plants contribute no grocery value."),
        "it": ("Le stime presuppongono {n} pianta/e per coltura su un'intera "
               "stagione. I raccolti reali variano con cura, varietà, dimensione "
               "del vaso e meteo. Le piante ornamentali/consociate non hanno "
               "valore alimentare."),
    },
    # -- Pest advisory --------------------------------------------------------
    "pest.warmWet": {
        "en": ("Warm and humid in-season conditions strongly favour fungal "
               "diseases (blight, powdery mildew) and rapid pest build-up. "
               "Prioritise airflow, water at the base, and inspect weekly."),
        "it": ("Condizioni calde e umide in stagione favoriscono fortemente le "
               "malattie fungine (peronospora, oidio) e il rapido aumento dei "
               "parassiti. Privilegia la ventilazione, annaffia alla base e "
               "controlla ogni settimana."),
    },
    "pest.warm": {
        "en": ("Warm in-season temperatures speed up pest reproduction (aphids, "
               "spider mites). Inspect undersides of leaves weekly and act early."),
        "it": ("Le temperature calde in stagione accelerano la riproduzione dei "
               "parassiti (afidi, ragnetti rossi). Controlla settimanalmente la "
               "pagina inferiore delle foglie e interveni presto."),
    },
    "pest.wet": {
        "en": ("Wet in-season conditions raise fungal-disease risk. Improve "
               "airflow, avoid wetting foliage, and remove infected leaves "
               "promptly."),
        "it": ("Le condizioni umide in stagione aumentano il rischio di malattie "
               "fungine. Migliora la ventilazione, evita di bagnare il fogliame e "
               "rimuovi tempestivamente le foglie infette."),
    },
    "pest.gh": {
        "en": ("Under greenhouse cover, ventilate daily to curb humidity-driven "
               "diseases and watch for whitefly and spider mites, which thrive in "
               "still, warm air."),
        "it": ("Sotto serra, ventila ogni giorno per contenere le malattie da "
               "umidità e fai attenzione ad aleurodidi e ragnetti rossi, che "
               "prosperano nell'aria calda e ferma."),
    },
    # -- Watering advice ------------------------------------------------------
    "water.skip": {
        "en": "Skip watering for now — significant rain is expected over the next 7 days.",
        "it": "Per ora salta l'irrigazione — sono previste piogge significative nei prossimi 7 giorni.",
    },
    "water.light": {
        "en": ("Light watering only — some rain is forecast this week. Check soil "
               "moisture before watering."),
        "it": ("Solo irrigazione leggera — sono previste alcune piogge questa "
               "settimana. Controlla l'umidità del terreno prima di annaffiare."),
    },
    "water.regular": {
        "en": "Water regularly — little to no rain is forecast over the next 7 days.",
        "it": "Annaffia regolarmente — poca o nessuna pioggia è prevista nei prossimi 7 giorni.",
    },
    "water.heat": {
        "en": (" High temperatures expected, so water early morning or evening to "
               "reduce evaporation."),
        "it": (" Sono previste temperature elevate, quindi annaffia al mattino "
               "presto o alla sera per ridurre l'evaporazione."),
    },
}

# General pest tips (lists are localized as a whole).
_TIPS: dict[str, list[str]] = {
    "en": [
        "Inspect plants weekly and act on the first signs — early action is far easier.",
        "Encourage beneficial insects (ladybugs, lacewings) instead of broad-spectrum sprays.",
        "Water at the base and keep foliage dry to limit fungal disease.",
        "Rotate crop families each year to break pest and disease cycles.",
    ],
    "it": [
        "Controlla le piante ogni settimana e interveni ai primi segni — agire presto è molto più facile.",
        "Favorisci gli insetti utili (coccinelle, crisope) invece degli insetticidi ad ampio spettro.",
        "Annaffia alla base e mantieni il fogliame asciutto per limitare le malattie fungine.",
        "Ruota le famiglie di colture ogni anno per spezzare i cicli di parassiti e malattie.",
    ],
}


def tr(lang: str | None, key: str, **kwargs: object) -> str:
    """Render a localized template by key, formatting in any ``kwargs``."""
    code = normalize_lang(lang)
    table = _TEMPLATES.get(key, {})
    template = table.get(code) or table.get(DEFAULT_LANG) or ""
    return template.format(**kwargs) if kwargs else template


def tips(lang: str | None) -> list[str]:
    """Return the localized general pest tips."""
    return list(_TIPS[normalize_lang(lang)])

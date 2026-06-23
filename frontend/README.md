# Urban Agri-Planner — Frontend

Single-page **Vite + React** dashboard for the Urban Agri-Planner. It collects the
address, available sunlight, balcony exposure, season and growing setup, drives the
two-step human-in-the-loop plan flow, and renders the results.

## Features

- **Address autocomplete** — debounced typeahead backed by the backend's cached,
  rate-limited Nominatim proxy.
- **Human-in-the-loop checkpoint** — review, edit or reject the crops the agent
  proposes before the final plan is generated.
- **Geo-climate panel** — hardiness zone, recorded minimum temperature, **frost
  dates**, the climate window used, and **7-day watering advice**.
- **Planting schedule & 12-month calendar** — month-by-month sowing / protection /
  harvest actions, with in-season highlighting.
- **Companion planting** — toggle between a **list** view and an interactive
  **graph** view (SVG network of green companion / red antagonist links).
- **Calendar export** — download the cultivation calendar as an `.ics` file or
  Print / Save as PDF.

## Setup

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The dev server expects the backend on `http://localhost:5001`.

## Configuration

The backend base URL is read from the `VITE_API_BASE` environment variable and
falls back to `http://localhost:5001`. To point at a different backend, copy the
example env file and edit it:

```bash
cp .env.example .env   # then set VITE_API_BASE
```

## Build

```bash
npm run build        # production bundle in dist/
npm run preview      # preview the production build
```

## Tech

- [Vite](https://vite.dev) + [React](https://react.dev) with HMR.
- ESLint configured in [eslint.config.js](eslint.config.js).
- Styling lives in [src/index.css](src/index.css); the entire UI is in
  [src/App.jsx](src/App.jsx).

# Flight Logbook Visualization

A static web app for visualizing ForeFlight logbook exports on an interactive map with route plotting, filtering, and flight hour charts.

## Live

https://bencpeters.github.io/flight-logbook-visualizer/

## Running locally

```bash
cd ff_log_visualization
python3 -m http.server 8080
```

Then open http://localhost:8080 in your browser.

## Usage

1. Export your logbook from ForeFlight as CSV
2. Drop the CSV file onto the upload screen (or click to browse)
3. Your data is cached in the browser's localStorage — no need to re-upload on subsequent visits

## Features

- **Map** — Interactive Leaflet map with multiple basemaps (OSM, Satellite, Terrain, VFR Sectionals, VFR Terminal, IFR Low Enroute)
- **Routes** — Plotted from logbook route fields or as great-circle arcs between airports. Color indicates recency (blue=oldest, orange=newest), thickness indicates frequency
- **Click routes** — Click any route segment to see flight details for that city pair
- **Filters** — Date range, aircraft type, tail number, airport, flight category (solo, XC, night, IFR, dual given/received, PIC)
- **Graphs** — Cumulative hours, monthly hours, hours by aircraft type, top airports by visit count. Drag across time charts to filter by date range
- **Table** — Sortable flight log with all entries
- **Stats** — Summary cards (total hours, PIC, night, XC, IFR, landings, airports, aircraft)
- **Resizable sidebar** — Drag the left edge to adjust width

## Privacy

Your logbook data never leaves your browser. The CSV is parsed client-side and cached in localStorage for convenience. No data is sent to any server.

## Data

Airport coordinates are sourced from the OurAirports database (public domain), covering all US and Canadian airports. The lookup handles both ICAO (KEAT) and FAA (EAT) identifiers.

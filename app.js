(function () {
    'use strict';

    let flights = [];
    let aircraft = {};
    let filteredFlights = [];
    let map, routeLayer, markerLayer;
    let chart = null;
    let sortColumn = 'date';
    let sortDirection = -1;

    // Color scale: old flights = cool blue, recent = warm orange/red
    function flightRecencyColor(date, minDate, maxDate) {
        const range = maxDate - minDate || 1;
        const t = (date - minDate) / range;
        const r = Math.round(40 + t * 215);
        const g = Math.round(80 + (1 - Math.abs(t - 0.5) * 2) * 80);
        const b = Math.round(220 - t * 180);
        return `rgb(${r},${g},${b})`;
    }

    function routeWeight(count) {
        return Math.min(2 + Math.log2(count) * 2, 8);
    }

    // --- CSV Parsing ---
    function parseForeFlight(csvText) {
        const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        let flightsStart = -1;
        let aircraftStart = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('Aircraft Table')) aircraftStart = i + 1;
            if (lines[i].startsWith('Flights Table')) { flightsStart = i + 1; break; }
        }

        // Parse aircraft
        if (aircraftStart > 0) {
            const acSection = lines.slice(aircraftStart, flightsStart - 2).join('\n');
            const acParsed = Papa.parse(acSection, { header: true, skipEmptyLines: true });
            acParsed.data.forEach(row => {
                if (row.AircraftID) {
                    aircraft[row.AircraftID] = {
                        type: row.TypeCode || '',
                        make: row.Make || '',
                        model: row.Model || '',
                        gear: row.GearType || '',
                        engine: row.EngineType || ''
                    };
                }
            });
        }

        // Parse flights
        const flightSection = lines.slice(flightsStart).join('\n');
        const flightParsed = Papa.parse(flightSection, { header: true, skipEmptyLines: true });

        flights = flightParsed.data
            .filter(row => row.Date && row.Date.match(/^\d{4}/))
            .map((row, idx) => ({
                id: idx,
                date: row.Date,
                aircraft: row.AircraftID || '',
                from: (row.From || '').trim(),
                to: (row.To || '').trim(),
                route: (row.Route || '').trim(),
                totalTime: parseFloat(row.TotalTime) || 0,
                pic: parseFloat(row.PIC) || 0,
                night: parseFloat(row.Night) || 0,
                solo: parseFloat(row.Solo) || 0,
                crossCountry: parseFloat(row.CrossCountry) || 0,
                actualInstrument: parseFloat(row.ActualInstrument) || 0,
                simulatedInstrument: parseFloat(row.SimulatedInstrument) || 0,
                dualGiven: parseFloat(row.DualGiven) || 0,
                dualReceived: parseFloat(row.DualReceived) || 0,
                distance: parseFloat(row.Distance) || 0,
                instructor: row.InstructorName || '',
                comments: (row.PilotComments || '').replace(/^"|"$/g, '').replace(/""/g, '"'),
                landings: parseInt(row.AllLandings) || 0
            }));

        filteredFlights = [...flights];
    }

    // --- Map Setup ---
    function initMap() {
        map = L.map('map', { zoomControl: true }).setView([42, -110], 5);

        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
        });

        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri',
            maxZoom: 19
        });

        const terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenTopoMap',
            maxZoom: 17
        });

        const vfrSectionalLayer = L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'FAA Aeronautical Information Services',
            maxZoom: 12,
            minZoom: 8
        });

        const vfrTerminalLayer = L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'FAA Aeronautical Information Services',
            maxZoom: 14,
            minZoom: 10
        });

        const ifrLowLayer = L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'FAA Aeronautical Information Services',
            maxZoom: 12,
            minZoom: 6
        });

        osmLayer.addTo(map);

        L.control.layers({
            'Roads (OSM)': osmLayer,
            'Satellite': satelliteLayer,
            'Terrain': terrainLayer,
            'VFR Sectionals': vfrSectionalLayer,
            'VFR Terminal': vfrTerminalLayer,
            'IFR Low Enroute': ifrLowLayer
        }, null, { position: 'topleft' }).addTo(map);

        routeLayer = L.layerGroup().addTo(map);
        markerLayer = L.layerGroup().addTo(map);
    }

    // --- Route Plotting ---
    function getAirportCoords(id) {
        if (!id) return null;
        const normalized = id.toUpperCase().trim();
        if (AIRPORTS[normalized]) return AIRPORTS[normalized];
        if (normalized.length <= 3 && AIRPORTS['K' + normalized]) return AIRPORTS['K' + normalized];
        if (normalized.startsWith('K') && AIRPORTS[normalized.substring(1)]) return AIRPORTS[normalized.substring(1)];
        return null;
    }

    function greatCirclePoints(lat1, lng1, lat2, lng2, numPoints) {
        if (numPoints === undefined) numPoints = 20;
        const toRad = Math.PI / 180;
        const toDeg = 180 / Math.PI;
        const points = [];
        const phi1 = lat1 * toRad, lam1 = lng1 * toRad;
        const phi2 = lat2 * toRad, lam2 = lng2 * toRad;

        for (let i = 0; i <= numPoints; i++) {
            const f = i / numPoints;
            const d = Math.acos(Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(lam2 - lam1));
            if (d < 0.0001) { points.push([lat1, lng1]); continue; }
            const A = Math.sin((1 - f) * d) / Math.sin(d);
            const B = Math.sin(f * d) / Math.sin(d);
            const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
            const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
            const z = A * Math.sin(phi1) + B * Math.sin(phi2);
            points.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg, Math.atan2(y, x) * toDeg]);
        }
        return points;
    }

    function sameAirport(a, b) {
        if (!a || !b) return false;
        a = a.toUpperCase().trim();
        b = b.toUpperCase().trim();
        if (a === b) return true;
        const stripK = id => id.startsWith('K') && id.length === 4 ? id.substring(1) : id;
        return stripK(a) === stripK(b);
    }

    function buildRouteKey(from, to) {
        const pair = [from, to].sort();
        return pair[0] + '-' + pair[1];
    }

    function plotRoutes() {
        routeLayer.clearLayers();
        markerLayer.clearLayers();

        const routeGroups = {};
        const airportsUsed = {};
        const dates = filteredFlights.filter(f => f.date).map(f => new Date(f.date).getTime());
        const minDate = dates.length ? Math.min(...dates) : 0;
        const maxDate = dates.length ? Math.max(...dates) : 1;

        filteredFlights.forEach(flight => {
            const waypoints = [];
            const fromCoords = getAirportCoords(flight.from);
            const toCoords = getAirportCoords(flight.to);

            if (flight.from && fromCoords) airportsUsed[flight.from] = fromCoords;
            if (flight.to && toCoords) airportsUsed[flight.to] = toCoords;

            // Build waypoint list from route or from/to
            if (flight.route) {
                const routeParts = flight.route.split(/\s+/).filter(Boolean);
                const allWpts = [...routeParts];

                // Prepend From if route doesn't already start with it
                if (flight.from && !sameAirport(flight.from, routeParts[0])) {
                    allWpts.unshift(flight.from);
                }
                // Append To if route doesn't already end with it
                if (flight.to && !sameAirport(flight.to, routeParts[routeParts.length - 1])) {
                    allWpts.push(flight.to);
                }

                for (const wp of allWpts) {
                    const c = getAirportCoords(wp);
                    if (c) {
                        waypoints.push({ id: wp, lat: c.lat, lng: c.lng });
                        airportsUsed[wp] = c;
                    }
                }
            } else if (flight.from && flight.to && flight.from !== flight.to) {
                if (fromCoords) waypoints.push({ id: flight.from, lat: fromCoords.lat, lng: fromCoords.lng });
                if (toCoords) waypoints.push({ id: flight.to, lat: toCoords.lat, lng: toCoords.lng });
            }

            // Create route segments
            for (let i = 0; i < waypoints.length - 1; i++) {
                const segKey = buildRouteKey(waypoints[i].id, waypoints[i + 1].id);
                if (!routeGroups[segKey]) {
                    routeGroups[segKey] = { from: waypoints[i], to: waypoints[i + 1], flights: [] };
                }
                routeGroups[segKey].flights.push(flight);
            }
        });

        // Draw routes
        Object.values(routeGroups).forEach(group => {
            const mostRecent = Math.max(...group.flights.map(f => new Date(f.date).getTime()));
            const color = flightRecencyColor(mostRecent, minDate, maxDate);
            const weight = routeWeight(group.flights.length);
            const points = greatCirclePoints(group.from.lat, group.from.lng, group.to.lat, group.to.lng);

            const polyline = L.polyline(points, {
                color: color,
                weight: weight,
                opacity: 0.7
            });

            polyline.on('click', () => showFlightDetail(group));
            polyline.on('mouseover', function () { this.setStyle({ opacity: 1, weight: weight + 2 }); });
            polyline.on('mouseout', function () { this.setStyle({ opacity: 0.7, weight: weight }); });

            routeLayer.addLayer(polyline);
        });

        // Draw airport markers
        Object.entries(airportsUsed).forEach(([id, coords]) => {
            const marker = L.circleMarker([coords.lat, coords.lng], {
                radius: 5,
                fillColor: '#fff',
                fillOpacity: 0.9,
                color: '#333',
                weight: 1.5
            });
            marker.bindTooltip(coords.name || id, { direction: 'top', offset: [0, -8] });
            markerLayer.addLayer(marker);
        });

        // Fit bounds
        if (Object.keys(airportsUsed).length > 0) {
            const bounds = Object.values(airportsUsed).map(c => [c.lat, c.lng]);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }

    // --- Flight Detail ---
    function showFlightDetail(routeGroup) {
        const panel = document.getElementById('flight-detail');
        const content = document.getElementById('detail-content');
        panel.classList.remove('hidden');

        const fromName = routeGroup.from.id;
        const toName = routeGroup.to.id;
        const flightList = routeGroup.flights
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 20);

        let html = `<h3>${fromName} &harr; ${toName}</h3>`;
        html += `<div class="multi-flight-header">${routeGroup.flights.length} flight${routeGroup.flights.length > 1 ? 's' : ''} on this segment</div>`;

        flightList.forEach(f => {
            const routeDisplay = f.route ? f.route : `${f.from} → ${f.to}`;
            html += `<div class="flight-item">`;
            html += `<div class="detail-row"><span class="label">Date</span><span class="value">${f.date}</span></div>`;
            html += `<div class="detail-row"><span class="label">Aircraft</span><span class="value">${f.aircraft}</span></div>`;
            html += `<div class="detail-row"><span class="label">Route</span><span class="value">${routeDisplay}</span></div>`;
            html += `<div class="detail-row"><span class="label">Total Time</span><span class="value">${f.totalTime}h</span></div>`;
            if (f.comments) html += `<div class="flight-comment">${f.comments}</div>`;
            html += `</div>`;
        });

        if (routeGroup.flights.length > 20) {
            html += `<div class="multi-flight-header">...and ${routeGroup.flights.length - 20} more</div>`;
        }

        content.innerHTML = html;
    }

    // --- Table ---
    function renderTable() {
        const tbody = document.querySelector('#flights-table tbody');
        const sorted = [...filteredFlights].sort((a, b) => {
            let va = a[sortColumn], vb = b[sortColumn];
            if (sortColumn === 'totalTime') return (va - vb) * sortDirection;
            if (typeof va === 'string') return va.localeCompare(vb) * sortDirection;
            return (va - vb) * sortDirection;
        });

        tbody.innerHTML = sorted.map(f => `
            <tr data-id="${f.id}">
                <td>${f.date}</td>
                <td title="${aircraft[f.aircraft] ? aircraft[f.aircraft].model : ''}">${f.aircraft}</td>
                <td>${f.from}</td>
                <td>${f.to}</td>
                <td title="${f.route}">${f.route || '-'}</td>
                <td>${f.totalTime || '-'}</td>
                <td title="${f.comments}">${f.comments || ''}</td>
            </tr>
        `).join('');
    }

    // --- Graph ---
    let cumulativeChart = null;
    let monthlyChart = null;
    let typeChart = null;

    // Custom plugin for drag-to-select date range
    const dragSelectPlugin = {
        id: 'dragSelect',
        beforeInit(chart) {
            chart.dragSelect = { dragging: false, startX: null, endX: null };
        },
        afterEvent(chart, args) {
            const { event } = args;
            const ds = chart.dragSelect;
            const area = chart.chartArea;
            if (!area) return;

            if (event.type === 'mousedown' && event.x >= area.left && event.x <= area.right && event.y >= area.top && event.y <= area.bottom) {
                ds.dragging = true;
                ds.startX = event.x;
                ds.endX = event.x;
            } else if (event.type === 'mousemove' && ds.dragging) {
                ds.endX = Math.max(area.left, Math.min(event.x, area.right));
                chart.draw();
            } else if ((event.type === 'mouseup' || event.type === 'mouseleave') && ds.dragging) {
                ds.dragging = false;
                if (event.type === 'mouseleave') {
                    ds.endX = Math.max(area.left, Math.min(event.x || ds.endX, area.right));
                }
                const minX = Math.min(ds.startX, ds.endX);
                const maxX = Math.max(ds.startX, ds.endX);
                if (maxX - minX > 10) {
                    const scale = chart.scales.x;
                    const minVal = scale.getValueForPixel(minX);
                    const maxVal = scale.getValueForPixel(maxX);
                    applyDateFilterFromChart(minVal, maxVal);
                }
                ds.startX = null;
                ds.endX = null;
                chart.draw();
            }
        },
        afterDraw(chart) {
            const ds = chart.dragSelect;
            if (!ds.dragging || ds.startX === null) return;
            const { ctx, chartArea } = chart;
            const minX = Math.min(ds.startX, ds.endX);
            const maxX = Math.max(ds.startX, ds.endX);
            ctx.save();
            ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.5)';
            ctx.lineWidth = 1;
            ctx.fillRect(minX, chartArea.top, maxX - minX, chartArea.bottom - chartArea.top);
            ctx.strokeRect(minX, chartArea.top, maxX - minX, chartArea.bottom - chartArea.top);
            ctx.restore();
        }
    };

    function applyDateFilterFromChart(minVal, maxVal) {
        const fromDate = new Date(minVal).toISOString().substring(0, 10);
        const toDate = new Date(maxVal).toISOString().substring(0, 10);
        document.getElementById('filter-date-from').value = fromDate;
        document.getElementById('filter-date-to').value = toDate;
        applyFilters();
    }

    function updateGraphDateIndicator() {
        const indicator = document.getElementById('graph-date-indicator');
        if (!indicator) return;
        const allDates = flights.map(f => f.date).filter(Boolean).sort();
        const fullFrom = allDates[0];
        const fullTo = allDates[allDates.length - 1];
        const currentFrom = document.getElementById('filter-date-from').value;
        const currentTo = document.getElementById('filter-date-to').value;
        const isFiltered = currentFrom > fullFrom || currentTo < fullTo;
        if (isFiltered) {
            indicator.innerHTML = `<span>Showing: <strong>${currentFrom}</strong> to <strong>${currentTo}</strong></span><button id="graph-reset-dates" class="btn btn-sm">Reset dates</button>`;
            indicator.classList.add('active');
            document.getElementById('graph-reset-dates').addEventListener('click', () => {
                document.getElementById('filter-date-from').value = fullFrom;
                document.getElementById('filter-date-to').value = fullTo;
                applyFilters();
            });
        } else {
            indicator.innerHTML = '';
            indicator.classList.remove('active');
        }
    }

    function renderGraphs() {
        if (cumulativeChart) cumulativeChart.destroy();
        if (monthlyChart) monthlyChart.destroy();
        updateGraphDateIndicator();

        const sorted = [...filteredFlights].filter(f => f.totalTime > 0).sort((a, b) => a.date.localeCompare(b.date));
        if (sorted.length === 0) return;

        // Cumulative chart
        let cumulative = 0;
        const cumulativeData = sorted.map(f => {
            cumulative += f.totalTime;
            return { x: f.date, y: Math.round(cumulative * 10) / 10 };
        });

        cumulativeChart = new Chart(document.getElementById('cumulative-chart'), {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Total Hours',
                    data: cumulativeData,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37,99,235,0.1)',
                    fill: true,
                    pointRadius: 0,
                    pointHitRadius: 6,
                    tension: 0.1,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'year', tooltipFormat: 'MMM yyyy' },
                        title: { display: false }
                    },
                    y: { title: { display: true, text: 'Hours' }, beginAtZero: true }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { title: (items) => items[0]?.raw?.x || '' } }
                },
                events: ['mousedown', 'mousemove', 'mouseup', 'mouseleave']
            },
            plugins: [dragSelectPlugin]
        });

        // Monthly bar chart
        const monthly = {};
        sorted.forEach(f => {
            const month = f.date.substring(0, 7) + '-01';
            monthly[month] = (monthly[month] || 0) + f.totalTime;
        });

        const monthKeys = Object.keys(monthly).sort();
        const monthlyData = monthKeys.map(m => ({ x: m, y: Math.round(monthly[m] * 10) / 10 }));

        monthlyChart = new Chart(document.getElementById('monthly-chart'), {
            type: 'bar',
            data: {
                datasets: [{
                    label: 'Hours',
                    data: monthlyData,
                    backgroundColor: '#2563eb',
                    borderRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'month', tooltipFormat: 'MMM yyyy' },
                        title: { display: false },
                        offset: true
                    },
                    y: { title: { display: true, text: 'Hours' }, beginAtZero: true }
                },
                plugins: { legend: { display: false } },
                events: ['mousedown', 'mousemove', 'mouseup', 'mouseleave']
            },
            plugins: [dragSelectPlugin]
        });

        // Aircraft type chart
        if (typeChart) typeChart.destroy();
        const byType = {};
        filteredFlights.forEach(f => {
            const t = getAircraftType(f.aircraft) || 'Unknown';
            byType[t] = (byType[t] || 0) + f.totalTime;
        });
        const typeLabels = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
        const typeValues = typeLabels.map(t => Math.round(byType[t] * 10) / 10);
        const typeColors = typeLabels.map((_, i) => {
            const hue = (i * 137.5) % 360;
            return `hsl(${hue}, 55%, 55%)`;
        });

        typeChart = new Chart(document.getElementById('type-chart'), {
            type: 'doughnut',
            data: {
                labels: typeLabels,
                datasets: [{
                    data: typeValues,
                    backgroundColor: typeColors,
                    borderWidth: 1,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.label}: ${ctx.raw}h`
                        }
                    }
                }
            }
        });
    }

    // --- Stats ---
    function renderStats() {
        const content = document.getElementById('stats-content');
        const totalHours = filteredFlights.reduce((s, f) => s + f.totalTime, 0);
        const picHours = filteredFlights.reduce((s, f) => s + f.pic, 0);
        const nightHours = filteredFlights.reduce((s, f) => s + f.night, 0);
        const xcHours = filteredFlights.reduce((s, f) => s + f.crossCountry, 0);
        const ifrHours = filteredFlights.reduce((s, f) => s + f.actualInstrument, 0);
        const simIfrHours = filteredFlights.reduce((s, f) => s + f.simulatedInstrument, 0);
        const dualGivenHours = filteredFlights.reduce((s, f) => s + f.dualGiven, 0);
        const soloHours = filteredFlights.reduce((s, f) => s + f.solo, 0);
        const totalLandings = filteredFlights.reduce((s, f) => s + f.landings, 0);
        const uniqueAirports = new Set();
        filteredFlights.forEach(f => { if (f.from) uniqueAirports.add(f.from); if (f.to) uniqueAirports.add(f.to); });
        const uniqueAircraft = new Set(filteredFlights.map(f => f.aircraft).filter(Boolean));

        content.innerHTML = `
            <div class="stat-card"><div class="label">Total Flights</div><div class="value">${filteredFlights.length}</div></div>
            <div class="stat-card"><div class="label">Total Hours</div><div class="value">${totalHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">PIC Hours</div><div class="value">${picHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Night Hours</div><div class="value">${nightHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Cross-Country</div><div class="value">${xcHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Actual IFR</div><div class="value">${ifrHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Sim Instrument</div><div class="value">${simIfrHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Solo</div><div class="value">${soloHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Dual Given</div><div class="value">${dualGivenHours.toFixed(1)}</div></div>
            <div class="stat-card"><div class="label">Total Landings</div><div class="value">${totalLandings}</div></div>
            <div class="stat-card"><div class="label">Airports Visited</div><div class="value">${uniqueAirports.size}</div></div>
            <div class="stat-card"><div class="label">Aircraft Flown</div><div class="value">${uniqueAircraft.size}</div></div>
        `;
    }

    // --- Filters ---
    function getAircraftType(acId) {
        return (aircraft[acId] && aircraft[acId].type) || '';
    }

    function populateFilters() {
        const aircraftSelect = document.getElementById('filter-aircraft');
        const aircraftTypeSelect = document.getElementById('filter-aircraft-type');
        const airportSelect = document.getElementById('filter-airport');

        const acIds = [...new Set(flights.map(f => f.aircraft).filter(Boolean))].sort();
        aircraftSelect.innerHTML = acIds.map(id => `<option value="${id}">${id}${aircraft[id] ? ' (' + aircraft[id].type + ')' : ''}</option>`).join('');

        const types = [...new Set(acIds.map(id => getAircraftType(id)).filter(Boolean))].sort();
        aircraftTypeSelect.innerHTML = types.map(t => `<option value="${t}">${t}</option>`).join('');

        const airports = new Set();
        flights.forEach(f => { if (f.from) airports.add(f.from); if (f.to) airports.add(f.to); });
        const apSorted = [...airports].sort();
        airportSelect.innerHTML = apSorted.map(id => `<option value="${id}">${id}</option>`).join('');

        // Date range defaults
        const dates = flights.map(f => f.date).filter(Boolean).sort();
        document.getElementById('filter-date-from').value = dates[0] || '';
        document.getElementById('filter-date-to').value = dates[dates.length - 1] || '';
    }

    function applyFilters() {
        const dateFrom = document.getElementById('filter-date-from').value;
        const dateTo = document.getElementById('filter-date-to').value;
        const selAircraft = [...document.getElementById('filter-aircraft').selectedOptions].map(o => o.value);
        const selAircraftTypes = [...document.getElementById('filter-aircraft-type').selectedOptions].map(o => o.value);
        const selAirports = [...document.getElementById('filter-airport').selectedOptions].map(o => o.value);
        const typeChecks = [...document.querySelectorAll('#filter-type input:checked')].map(cb => cb.value);

        filteredFlights = flights.filter(f => {
            if (dateFrom && f.date < dateFrom) return false;
            if (dateTo && f.date > dateTo) return false;
            if (selAircraft.length && !selAircraft.includes(f.aircraft)) return false;
            if (selAircraftTypes.length && !selAircraftTypes.includes(getAircraftType(f.aircraft))) return false;
            if (selAirports.length && !selAirports.includes(f.from) && !selAirports.includes(f.to)) return false;
            if (typeChecks.length) {
                const pass = typeChecks.some(t => {
                    switch (t) {
                        case 'solo': return f.solo > 0;
                        case 'xc': return f.crossCountry > 0;
                        case 'night': return f.night > 0;
                        case 'ifr': return f.actualInstrument > 0;
                        case 'simInstrument': return f.simulatedInstrument > 0;
                        case 'dualGiven': return f.dualGiven > 0;
                        case 'dualReceived': return f.dualReceived > 0;
                        case 'pic': return f.pic > 0;
                        default: return true;
                    }
                });
                if (!pass) return false;
            }
            return true;
        });

        updateAll();
        const summary = document.getElementById('filter-summary');
        summary.textContent = `Showing ${filteredFlights.length} of ${flights.length} flights (${filteredFlights.reduce((s, f) => s + f.totalTime, 0).toFixed(1)} hours)`;
    }

    function clearFilters() {
        document.getElementById('filter-aircraft').selectedIndex = -1;
        document.getElementById('filter-aircraft-type').selectedIndex = -1;
        document.getElementById('filter-airport').selectedIndex = -1;
        document.querySelectorAll('#filter-type input').forEach(cb => cb.checked = false);
        const dates = flights.map(f => f.date).filter(Boolean).sort();
        document.getElementById('filter-date-from').value = dates[0] || '';
        document.getElementById('filter-date-to').value = dates[dates.length - 1] || '';
        filteredFlights = [...flights];
        updateAll();
        document.getElementById('filter-summary').textContent = '';
    }

    function updateAll() {
        plotRoutes();
        renderTable();
        renderStats();
        renderGraphs();
    }

    // --- UI Wiring ---
    function setupUI() {
        // Sidebar toggle
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
            setTimeout(() => map.invalidateSize(), 350);
        });

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
                if (tab.dataset.tab === 'graph') renderGraphs();
            });
        });



        // Table sorting
        document.querySelectorAll('#flights-table th').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.sort;
                if (sortColumn === col) sortDirection *= -1;
                else { sortColumn = col; sortDirection = col === 'date' ? -1 : 1; }
                renderTable();
            });
        });

        // Filters
        document.getElementById('apply-filters').addEventListener('click', applyFilters);
        document.getElementById('clear-filters').addEventListener('click', clearFilters);

        // Close detail
        document.getElementById('close-detail').addEventListener('click', () => {
            document.getElementById('flight-detail').classList.add('hidden');
        });

        // Sidebar resize
        const sidebar = document.getElementById('sidebar');
        const resizeHandle = document.getElementById('sidebar-resize-handle');
        let resizing = false;
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            resizing = true;
            document.body.classList.add('sidebar-resizing');
        });
        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const newWidth = Math.max(300, Math.min(window.innerWidth - 200, window.innerWidth - e.clientX));
            sidebar.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            document.body.classList.remove('sidebar-resizing');
            map.invalidateSize();
        });
    }

    // --- File Upload ---
    function setupUpload() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');

        dropZone.addEventListener('click', () => fileInput.click());

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) loadFile(file);
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) loadFile(e.target.files[0]);
        });
    }

    function loadFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            parseForeFlight(e.target.result);
            document.getElementById('upload-screen').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden');
            initMap();
            setupUI();
            populateFilters();
            updateAll();
        };
        reader.readAsText(file);
    }

    // --- Init ---
    setupUpload();
})();

(function () {
  "use strict";

  /* ---------- formatting / bands ---------- */
  function fmt(value, decimals) {
    if (value === undefined || value === null || Number.isNaN(value)) return "—";
    return Number(value).toFixed(decimals);
  }

  function timeAgo(isoOrEpochSeconds) {
    if (!isoOrEpochSeconds) return "—";
    const ms = typeof isoOrEpochSeconds === "number" ? isoOrEpochSeconds * 1000 : new Date(isoOrEpochSeconds).getTime();
    if (Number.isNaN(ms)) return "—";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  const BAND_ORDER = ["good", "fair", "poor", "bad"];
  const BAND_WORD = { good: "Good", fair: "Fair", poor: "Poor", bad: "Very poor" };

  function bandFromAqi(aqi) {
    if (aqi === undefined || aqi === null || Number.isNaN(aqi)) return null;
    if (aqi > 150) return "bad";
    if (aqi > 100) return "poor";
    if (aqi > 50) return "fair";
    return "good";
  }
  function bandFromCo2(co2) {
    if (co2 === undefined || co2 === null || Number.isNaN(co2)) return null;
    if (co2 > 2000) return "bad";
    if (co2 > 1500) return "poor";
    if (co2 > 1000) return "fair";
    return "good";
  }
  function worseBand(a, b) {
    if (!a) return b;
    if (!b) return a;
    return BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b) ? a : b;
  }
  function bandVar(band) {
    return band ? `var(--${band})` : "var(--ink-dim)";
  }

  function insideSentence(band) {
    switch (band) {
      case "good": return "CO2 and particulates are both low right now — nothing to do.";
      case "fair": return "Slightly elevated — cracking a window would help.";
      case "poor": return "CO2 or particulates are elevated — ventilating is a good idea.";
      case "bad": return "Air quality is poor right now — ventilate if you can.";
      default: return "Waiting for a reading…";
    }
  }
  function outsideSentence(category, pollutant) {
    if (!category) return "Loading…";
    return `${category} — ${pollutant || "AQI"} is the main pollutant outside.`;
  }

  /* ---------- chart rendering (SVG, hand-drawn) ----------
   * Series are plotted by real timestamp (not array index) so that sources
   * sampled at different rates — e.g. indoor readings every ~5-10min vs.
   * AirNow's hourly outdoor readings — overlay correctly on one chart. */
  const W = 760, H = 160, PAD = { l: 34, r: 4, t: 10, b: 18 };

  function formatTick(v) {
    const abs = Math.abs(v);
    if (abs >= 100) return String(Math.round(v));
    if (abs >= 10) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }

  function pathFor(points, tMin, tMax, vMin, vMax) {
    const xw = W - PAD.l - PAD.r;
    const yh = H - PAD.t - PAD.b;
    return points.map((p, i) => {
      const x = PAD.l + ((p.t - tMin) / (tMax - tMin || 1)) * xw;
      const y = PAD.t + yh - ((p.v - vMin) / (vMax - vMin || 1)) * yh;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  function pointAt(p, tMin, tMax, vMin, vMax) {
    const xw = W - PAD.l - PAD.r;
    const yh = H - PAD.t - PAD.b;
    const x = PAD.l + ((p.t - tMin) / (tMax - tMin || 1)) * xw;
    const y = PAD.t + yh - ((p.v - vMin) / (vMax - vMin || 1)) * yh;
    return [x, y];
  }

  // series: [{ color, points: [{t, v}], area }]
  function renderChart(el, series, opts) {
    const nonEmpty = series.filter((s) => s.points.length > 0);
    if (nonEmpty.length === 0) {
      el.innerHTML = '<div class="empty-state">No data in this range yet.</div>';
      return;
    }
    const allTimes = nonEmpty.flatMap((s) => s.points.map((p) => p.t));
    const allVals = nonEmpty.flatMap((s) => s.points.map((p) => p.v));
    const tMin = Math.min(...allTimes), tMax = Math.max(...allTimes);
    const vMin = Math.min(...allVals), vMax = Math.max(...allVals);
    const pad = (vMax - vMin) * 0.12 || 1;
    const lo = vMin - pad;
    const hi = vMax + pad;

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${opts.label || "chart"}">`;
    for (let gy = 0; gy <= 3; gy++) {
      const y = PAD.t + (gy / 3) * (H - PAD.t - PAD.b);
      svg += `<line class="chart-grid-line" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" />`;
      const tickVal = hi - (gy / 3) * (hi - lo);
      svg += `<text class="chart-axis-label chart-y-label" x="${(PAD.l - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${formatTick(tickVal)}</text>`;
    }
    nonEmpty.forEach((s) => {
      const d = pathFor(s.points, tMin, tMax, lo, hi);
      if (s.area) {
        const yh = H - PAD.t - PAD.b;
        const areaD = `${d} L${(W - PAD.r).toFixed(1)},${(PAD.t + yh).toFixed(1)} L${PAD.l},${(PAD.t + yh).toFixed(1)} Z`;
        svg += `<path d="${areaD}" fill="${s.color}" opacity="0.12" stroke="none" />`;
      }
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
      const last = s.points[s.points.length - 1];
      const [ex, ey] = pointAt(last, tMin, tMax, lo, hi);
      svg += `<circle class="chart-endpoint" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--panel-raised)" stroke-width="1.5" />`;
    });
    svg += `<text class="chart-axis-label" x="${PAD.l}" y="${H - 4}">${opts.leftLabel || ""}</text>`;
    svg += `<text class="chart-axis-label" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">now</text>`;
    svg += "</svg>";
    el.innerHTML = svg;
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function seriesFor(points, key, color, area) {
    return {
      color,
      area: !!area,
      points: points
        .filter((p) => typeof p[key] === "number")
        .map((p) => ({ t: new Date(p.time).getTime(), v: p[key] })),
    };
  }

  function renderAllCharts(points, outsidePoints, rangeLabel) {
    renderChart(document.getElementById("chart-co2"), [
      seriesFor(points, "co2_ppm", cssVar("--accent"), true),
    ], { leftLabel: rangeLabel, label: "CO2 history" });

    renderChart(document.getElementById("chart-pm"), [
      seriesFor(points, "pm1_0_ugm3", "#6f9be0"),
      seriesFor(points, "pm2_5_ugm3", "#e0935a"),
      seriesFor(points, "pm4_0_ugm3", "#b23a3a"),
      seriesFor(points, "pm10_0_ugm3", "#6a5acd"),
    ], { leftLabel: rangeLabel, label: "Particulate matter history" });

    renderChart(document.getElementById("chart-voc"), [
      seriesFor(points, "voc_index", cssVar("--accent")),
      seriesFor(points, "nox_index", "#e0935a"),
    ], { leftLabel: rangeLabel, label: "VOC and NOx index history" });

    renderChart(document.getElementById("chart-temp"), [
      seriesFor(points, "temperature_c", "#e0935a", true),
    ], { leftLabel: rangeLabel, label: "Temperature history" });

    renderChart(document.getElementById("chart-hum"), [
      seriesFor(points, "humidity_pct", "#6f9be0", true),
    ], { leftLabel: rangeLabel, label: "Humidity history" });

    renderChart(document.getElementById("chart-aqi-compare"), [
      seriesFor(points, "aqi", cssVar("--accent")),
      seriesFor(outsidePoints, "aqi", cssVar("--zone-outside")),
    ], { leftLabel: rangeLabel, label: "Inside vs outside AQI history" });

    document.getElementById("legend-pm").innerHTML = [
      ["#6f9be0", "PM1.0"], ["#e0935a", "PM2.5"], ["#b23a3a", "PM4.0"], ["#6a5acd", "PM10"],
    ].map(([c, l]) => `<span><span class="legend-dot" style="background:${c}"></span>${l}</span>`).join("");
    document.getElementById("legend-voc").innerHTML = [
      [cssVar("--accent"), "VOC index"], ["#e0935a", "NOx index"],
    ].map(([c, l]) => `<span><span class="legend-dot" style="background:${c}"></span>${l}</span>`).join("");
    document.getElementById("legend-aqi-compare").innerHTML = [
      [cssVar("--accent"), "Inside (NowCast)"], [cssVar("--zone-outside"), "Outside (AirNow)"],
    ].map(([c, l]) => `<span><span class="legend-dot" style="background:${c}"></span>${l}</span>`).join("");
  }

  /* ---------- toast ---------- */
  function toast(msg) {
    const stack = document.getElementById("toast-stack");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  /* ---------- live readout tiles (Technical view) ---------- */
  const READOUT_DEFS = [
    { id: "co2", label: "CO2", unit: "ppm", key: "co2_ppm", decimals: 0, band: (v) => v > 1500 ? "bad" : v > 1000 ? "poor" : null },
    { id: "aqi", label: "AQI (NowCast)", unit: "", key: "aqi", decimals: 0, band: bandFromAqi },
    { id: "pm25", label: "PM2.5", unit: "µg/m³", key: "pm2_5_ugm3", decimals: 1, band: (v) => v > 35 ? "bad" : v > 12 ? "poor" : null },
    { id: "voc", label: "VOC index", unit: "", key: "voc_index", decimals: 0, band: (v) => v > 250 ? "bad" : v > 150 ? "poor" : null },
    { id: "nox", label: "NOx index", unit: "", key: "nox_index", decimals: 0, band: () => null },
    { id: "temp", label: "Temperature", unit: "°C", key: "temperature_c", decimals: 1, band: () => null },
    { id: "hum", label: "Humidity", unit: "%", key: "humidity_pct", decimals: 1, band: () => null },
    { id: "pressure", label: "Pressure", unit: "hPa", key: "pressure_hpa", decimals: 1, band: () => null },
  ];

  let previousLatest = null;

  function renderReadouts(latest) {
    const grid = document.getElementById("readout-grid");
    grid.innerHTML = READOUT_DEFS.map((r) => {
      const value = latest ? latest[r.key] : null;
      const prevValue = previousLatest ? previousLatest[r.key] : null;
      let dir = "flat";
      if (typeof value === "number" && typeof prevValue === "number" && value !== prevValue) {
        dir = value > prevValue ? "up" : "down";
      }
      const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
      const bandKey = typeof value === "number" ? r.band(value) : null;
      return `<div class="readout" style="--edge-color: ${bandKey ? `var(--${bandKey})` : "var(--hairline)"}">
        <div class="r-label"><span>${r.label}</span><span class="trend" data-dir="${dir}">${arrow}</span></div>
        <div class="r-value">${fmt(value, r.decimals)}<span class="r-unit">${r.unit}</span></div>
      </div>`;
    }).join("");
  }

  /* ---------- indoor latest reading ---------- */
  async function loadLatest() {
    try {
      const res = await fetch("/api/latest");
      if (res.status === 404) {
        setIndoorUnavailable("No sensor data yet — waiting for the AIR-1 to report in.");
        return;
      }
      if (!res.ok) throw new Error("request failed");
      const d = await res.json();

      renderReadouts(d);
      previousLatest = d;

      document.getElementById("s-co2").textContent = fmt(d.co2_ppm, 0);
      document.getElementById("s-pm25").textContent = fmt(d.pm2_5_ugm3, 1);
      document.getElementById("s-temp").textContent = fmt(d.temperature_c, 1);
      document.getElementById("s-hum").textContent = fmt(d.humidity_pct, 1);

      document.getElementById("g-no2").textContent = fmt(d.nitrogen_dioxide_ppm, 3) + " ppm";
      document.getElementById("g-co").textContent = fmt(d.carbon_monoxide_ppm, 3) + " ppm";
      document.getElementById("g-h2").textContent = fmt(d.hydrogen_ppm, 3) + " ppm";
      document.getElementById("g-ethanol").textContent = fmt(d.ethanol_ppm, 3) + " ppm";
      document.getElementById("g-methane").textContent = fmt(d.methane_ppm, 3) + " ppm";
      document.getElementById("g-ammonia").textContent = fmt(d.ammonia_ppm, 3) + " ppm";

      document.getElementById("d-rssi").textContent = fmt(d.wifi_rssi_db, 0) + " dB";
      document.getElementById("d-esptemp").textContent = fmt(d.esp_temperature_c, 1) + " °C";
      const uptimeMin = typeof d.uptime_s === "number" ? d.uptime_s / 60 : null;
      document.getElementById("d-uptime").textContent = fmt(uptimeMin, 1) + " min";
      document.getElementById("d-firmware").textContent = d.firmware_version || "—";

      const band = worseBand(bandFromAqi(d.aqi), bandFromCo2(d.co2_ppm));
      const heroBadge = document.getElementById("hero-badge");
      heroBadge.textContent = BAND_WORD[band] || "—";
      heroBadge.style.setProperty("--band-color", bandVar(band));
      document.getElementById("hero-sentence").textContent = insideSentence(band);
      document.getElementById("hero-updated-rel").textContent = timeAgo(d.time);
      document.getElementById("since-reading").textContent = timeAgo(d.time);
    } catch (e) {
      setIndoorUnavailable("Unable to reach the dashboard's InfluxDB reader.");
    }
  }

  const INDOOR_FIELD_IDS = [
    "s-co2", "s-pm25", "s-temp", "s-hum",
    "g-no2", "g-co", "g-h2", "g-ethanol", "g-methane", "g-ammonia",
    "d-rssi", "d-esptemp", "d-uptime", "d-firmware",
  ];

  function setIndoorUnavailable(msg) {
    document.getElementById("hero-sentence").textContent = msg;
    document.getElementById("hero-updated-rel").textContent = "—";
    document.getElementById("since-reading").textContent = "—";
    const heroBadge = document.getElementById("hero-badge");
    heroBadge.textContent = "—";
    heroBadge.style.setProperty("--band-color", "var(--ink-dim)");
    INDOOR_FIELD_IDS.forEach((id) => { document.getElementById(id).textContent = "—"; });
    document.getElementById("readout-grid").innerHTML = "";
    previousLatest = null;
  }

  /* ---------- history / charts ---------- */
  async function loadHistory(hours) {
    const rangeLabel = { 6: "6h ago", 24: "24h ago", 72: "3d ago", 168: "7d ago" }[hours] || `${hours}h ago`;
    const [insideRes, outsideRes] = await Promise.allSettled([
      fetch(`/api/history?hours=${hours}`),
      fetch(`/api/outside/history?hours=${hours}`),
    ]);
    const points = insideRes.status === "fulfilled" && insideRes.value.ok ? await insideRes.value.json() : [];
    const outsidePoints = outsideRes.status === "fulfilled" && outsideRes.value.ok ? await outsideRes.value.json() : [];
    renderAllCharts(points, outsidePoints, rangeLabel);
  }

  /* ---------- outside (AirNow) ---------- */
  async function loadOutside() {
    try {
      const res = await fetch("/api/outside");
      if (!res.ok) throw new Error("request failed");
      const d = await res.json();

      const band = d.band;

      const outsideBadge = document.getElementById("outside-badge");
      outsideBadge.textContent = d.category || "—";
      outsideBadge.style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-area").textContent = d.reporting_area || "—";
      document.getElementById("outside-sentence").textContent = outsideSentence(d.category, d.dominant_pollutant);
      document.getElementById("outside-updated-rel").textContent = `hour ${d.observed_hour}`;

      document.getElementById("outside-aqi-tech").textContent = d.aqi ?? "—";
      document.getElementById("outside-aqi-tech").style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-category-tech").textContent = d.category || "—";
      document.getElementById("outside-area-tech").textContent = d.reporting_area || "—";
      document.getElementById("outside-updated-tech").textContent = `${d.observed} · hour ${d.observed_hour}`;
      document.getElementById("outside-tech-card").style.setProperty("--edge-color", bandVar(band));

      document.getElementById("outside-pollutants").innerHTML = (d.pollutants || [])
        .map((p) => `<span class="outside-pollutant">${p.parameter}<span class="op-value">${p.aqi}</span></span>`)
        .join("");
    } catch (e) {
      document.getElementById("outside-sentence").textContent = "Couldn't reach AirNow.";
      document.getElementById("outside-category-tech").textContent = "Unavailable";
    }
  }

  /* ---------- forecast / saved locations ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function dayLabel(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }

  let savedLocations = [];
  let selectedZip = null; // null = home (AIRNOW_ZIP)

  async function loadLocations() {
    try {
      const res = await fetch("/api/locations");
      savedLocations = res.ok ? await res.json() : [];
    } catch (e) {
      savedLocations = [];
    }
    renderLocationSwitch();
  }

  function renderLocationSwitch() {
    const wrap = document.getElementById("location-switch");
    const homeBtn = `<button type="button" class="location-chip" data-zip="" aria-pressed="${selectedZip === null}">Home</button>`;
    const chips = savedLocations.map((loc) => `
      <span class="location-chip-wrap">
        <button type="button" class="location-chip" data-zip="${loc.zip}" aria-pressed="${selectedZip === loc.zip}">${escapeHtml(loc.label)}</button>
        <button type="button" class="location-chip-remove" data-zip="${loc.zip}" aria-label="Remove ${escapeHtml(loc.label)}">×</button>
      </span>`).join("");
    const addBtn = `<button type="button" class="location-chip location-chip-add" id="add-location-toggle">+ Add</button>`;
    wrap.innerHTML = homeBtn + chips + addBtn;

    wrap.querySelectorAll(".location-chip[data-zip]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedZip = btn.getAttribute("data-zip") || null;
        renderLocationSwitch();
        loadForecast();
      });
    });
    wrap.querySelectorAll(".location-chip-remove").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const zip = btn.getAttribute("data-zip");
        try {
          const res = await fetch(`/api/locations/${zip}`, { method: "DELETE" });
          const result = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(result.error || "request failed");
          savedLocations = result;
          if (selectedZip === zip) {
            selectedZip = null;
            loadForecast();
          }
          renderLocationSwitch();
          toast("Removed");
        } catch (err) {
          toast("Couldn't remove that — " + err.message);
        }
      });
    });
    document.getElementById("add-location-toggle").addEventListener("click", () => {
      document.getElementById("add-location-form").hidden = false;
    });
  }

  async function loadForecast() {
    const daysEl = document.getElementById("forecast-days");
    const areaEl = document.getElementById("forecast-area");
    const discussionWrap = document.getElementById("forecast-discussion");
    const discussionText = document.getElementById("discussion-text");
    const discussionToggle = document.getElementById("discussion-toggle");

    const url = selectedZip ? `/api/forecast?zip=${encodeURIComponent(selectedZip)}` : "/api/forecast";
    try {
      const res = await fetch(url);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "request failed");

      areaEl.textContent = d.reporting_area || "—";
      daysEl.innerHTML = (d.days && d.days.length ? d.days.map((day) => {
        const aqiText = day.aqi != null ? `AQI ${day.aqi}` : "AQI —";
        return `<div class="forecast-day">
          <div class="fd-label">${dayLabel(day.date)}</div>
          <div class="fd-badge" style="--band-color: ${bandVar(day.band)}">${escapeHtml(day.category)}</div>
          <div class="fd-aqi">${aqiText}</div>
          <div class="fd-pollutant">${escapeHtml(day.dominant_pollutant)}</div>
        </div>`;
      }).join("") : '<div class="empty-state">No forecast published for this location right now.</div>');

      if (d.discussion) {
        discussionWrap.hidden = false;
        discussionText.textContent = d.discussion;
        discussionToggle.setAttribute("aria-expanded", "false");
        discussionText.hidden = true;
      } else {
        discussionWrap.hidden = true;
      }
    } catch (e) {
      areaEl.textContent = "—";
      daysEl.innerHTML = `<div class="empty-state">Couldn't reach AirNow — ${escapeHtml(e.message)}</div>`;
      discussionWrap.hidden = true;
    }
  }

  document.getElementById("discussion-toggle").addEventListener("click", () => {
    const btn = document.getElementById("discussion-toggle");
    const p = document.getElementById("discussion-text");
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    p.hidden = expanded;
  });

  document.getElementById("add-location-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = document.getElementById("new-location-label").value;
    const zip = document.getElementById("new-location-zip").value;
    try {
      const res = await fetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, zip }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "request failed");
      savedLocations = result;
      document.getElementById("new-location-label").value = "";
      document.getElementById("new-location-zip").value = "";
      document.getElementById("add-location-form").hidden = true;
      renderLocationSwitch();
      toast("Saved");
    } catch (err) {
      toast("Couldn't save that — " + err.message);
    }
  });
  document.getElementById("cancel-location-btn").addEventListener("click", () => {
    document.getElementById("add-location-form").hidden = true;
  });

  /* ---------- controls (real MQTT bridge) ---------- */
  const stepperConf = {
    sleep: { object_id: "sleep_duration", step: 1, min: 0, max: 800, digits: 0, stateKey: "sleep_duration_min" },
    toffset: { object_id: "sen55_temperature_offset", step: 0.5, min: -70, max: 70, digits: 1, stateKey: "sen55_temperature_offset" },
    hoffset: { object_id: "sen55_humidity_offset", step: 0.5, min: -70, max: 70, digits: 1, stateKey: "sen55_humidity_offset" },
    poffset: { object_id: "dps310_pressure_offset", step: 1, min: -100, max: 100, digits: 1, stateKey: "dps310_pressure_offset" },
  };
  const stepperState = { sleep: null, toffset: null, hoffset: null, poffset: null };

  async function postControl(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "request failed");
    }
  }

  async function loadControls() {
    try {
      const res = await fetch("/api/controls");
      if (!res.ok) throw new Error("request failed");
      const s = await res.json();

      const lamp = document.getElementById("lamp");
      const connStatus = document.getElementById("conn-status");
      if (s.online) {
        lamp.setAttribute("data-state", "mqtt");
        connStatus.textContent = "Online now";
      } else if (s.status_seen_at) {
        lamp.setAttribute("data-state", "offline");
        connStatus.textContent = `Asleep — last seen ${timeAgo(s.status_seen_at)}`;
      } else {
        lamp.setAttribute("data-state", "stale");
        connStatus.textContent = "No connection data yet";
      }

      const rocker = document.getElementById("rocker-sleep");
      rocker.setAttribute("aria-pressed", String(!!s.prevent_sleep));

      Object.entries(stepperConf).forEach(([key, conf]) => {
        const v = s[conf.stateKey];
        if (typeof v === "number") {
          stepperState[key] = v;
          document.getElementById("val-" + key).textContent = v.toFixed(conf.digits);
        }
      });
    } catch (e) {
      // Controls staying at their last-known display is preferable to blanking them out.
    }
  }

  document.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-step");
      const dir = Number(btn.getAttribute("data-dir"));
      const conf = stepperConf[key];
      const base = stepperState[key] ?? 0;
      let v = base + dir * conf.step;
      v = Math.max(conf.min, Math.min(conf.max, v));
      v = Math.round(v * 10) / 10;
      stepperState[key] = v;
      document.getElementById("val-" + key).textContent = v.toFixed(conf.digits);
      try {
        await postControl(`/api/control/number/${conf.object_id}`, { value: v });
        toast("Sent — applies next time the device wakes");
      } catch (e) {
        toast("Couldn't send that — " + e.message);
      }
    });
  });

  const rockerSleep = document.getElementById("rocker-sleep");
  rockerSleep.addEventListener("click", async () => {
    const on = rockerSleep.getAttribute("aria-pressed") !== "true";
    rockerSleep.setAttribute("aria-pressed", String(on));
    try {
      await postControl("/api/control/switch/prevent_sleep", { state: on });
      toast(on
        ? "Sent — stays awake once it's next connected"
        : "Sent — resumes its normal sleep cycle next wake");
    } catch (e) {
      rockerSleep.setAttribute("aria-pressed", String(!on));
      toast("Couldn't send that — " + e.message);
    }
  });

  async function pressButton(objectId, sentMessage) {
    try {
      await postControl(`/api/control/button/${objectId}`);
      toast(sentMessage);
    } catch (e) {
      toast("Couldn't send that — " + e.message);
    }
  }
  document.getElementById("btn-calibrate").addEventListener("click", () => {
    pressButton("calibrate_scd40_to_420ppm", "Sent — calibrates next time the device wakes");
  });
  document.getElementById("btn-clean").addEventListener("click", () => {
    pressButton("clean_sen55", "Sent — cleans next time the device wakes");
  });
  document.getElementById("btn-reboot").addEventListener("click", () => {
    pressButton("esp_reboot", "Sent — restarts if the device is currently awake");
  });

  const holdBtn = document.getElementById("btn-factory-reset");
  const holdFill = document.getElementById("hold-fill");
  let holdTimer = null, holdStart = 0;
  const HOLD_MS = 3000;
  function holdStep() {
    const pct = Math.min(100, ((Date.now() - holdStart) / HOLD_MS) * 100);
    holdFill.style.width = pct + "%";
    if (pct >= 100) {
      cancelHold();
      pressButton("factory_reset_esp", "Sent — factory reset applies if the device is currently awake");
      return;
    }
    holdTimer = requestAnimationFrame(holdStep);
  }
  function startHold() { holdStart = Date.now(); holdTimer = requestAnimationFrame(holdStep); }
  function cancelHold() { if (holdTimer) cancelAnimationFrame(holdTimer); holdTimer = null; holdFill.style.width = "0%"; }
  holdBtn.addEventListener("mousedown", startHold);
  holdBtn.addEventListener("touchstart", startHold, { passive: true });
  ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((ev) => holdBtn.addEventListener(ev, cancelHold));

  /* ---------- view toggle ---------- */
  const tabSimple = document.getElementById("tab-simple");
  const tabTechnical = document.getElementById("tab-technical");
  const viewSimple = document.getElementById("view-simple");
  const viewTechnical = document.getElementById("view-technical");
  let currentRange = 24;

  function setView(v) {
    const toTech = v === "technical";
    tabSimple.setAttribute("aria-pressed", String(!toTech));
    tabTechnical.setAttribute("aria-pressed", String(toTech));
    viewSimple.hidden = toTech;
    viewTechnical.hidden = !toTech;
    const active = toTech ? viewTechnical : viewSimple;
    active.classList.remove("view-fade");
    void active.offsetWidth;
    active.classList.add("view-fade");
    localStorage.setItem("apollo-air1-view", toTech ? "technical" : "simple");
    if (toTech) {
      loadHistory(currentRange);
      loadControls();
      loadForecast();
    }
  }
  tabSimple.addEventListener("click", () => setView("simple"));
  tabTechnical.addEventListener("click", () => setView("technical"));
  document.getElementById("to-technical").addEventListener("click", () => setView("technical"));

  /* ---------- theme toggle ---------- */
  document.getElementById("theme-toggle").addEventListener("click", (e) => {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    e.target.textContent = next === "dark" ? "switch to light" : "switch to dark";
    loadHistory(currentRange);
  });

  /* ---------- range toggle ---------- */
  document.querySelectorAll("#range-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#range-toggle button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      currentRange = Number(btn.getAttribute("data-range"));
      loadHistory(currentRange);
    });
  });

  /* ---------- clock ---------- */
  function tickClock() {
    document.getElementById("footer-clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ---------- service worker ---------- */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is a nice-to-have; the app works fine without it.
    });
  }

  /* ---------- init ---------- */
  const savedView = localStorage.getItem("apollo-air1-view");
  setView(savedView === "technical" ? "technical" : "simple");
  loadLatest();
  loadOutside();
  loadControls();
  loadLocations();
  setInterval(loadLatest, 60000);
  setInterval(loadOutside, 15 * 60000);
  setInterval(loadControls, 30000);
  setInterval(() => { if (!viewTechnical.hidden) loadHistory(currentRange); }, 60000);
  setInterval(() => { if (!viewTechnical.hidden) loadForecast(); }, 15 * 60000);
})();

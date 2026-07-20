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

  /* ---------- temperature unit (F/C) ---------- */
  let currentUnit = localStorage.getItem("apollo-air1-unit") || "f";

  function tempUnitLabel() {
    return currentUnit === "f" ? "°F" : "°C";
  }
  // Absolute reading: F = C * 9/5 + 32.
  function displayTemp(celsius) {
    return typeof celsius === "number" ? (currentUnit === "f" ? celsius * 9 / 5 + 32 : celsius) : null;
  }
  // A *difference* between two temperatures (e.g. a calibration offset)
  // converts without the +32 -- that's only for absolute readings.
  function displayTempDelta(deltaCelsius) {
    return typeof deltaCelsius === "number" ? (currentUnit === "f" ? deltaCelsius * 9 / 5 : deltaCelsius) : null;
  }

  function renderUnitToggle() {
    document.querySelectorAll(".unit-toggle").forEach((wrap) => {
      wrap.querySelectorAll("button").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-unit") === currentUnit));
      });
    });
    document.querySelectorAll("#chart-temp-unit, #unit-toffset").forEach((el) => {
      el.textContent = tempUnitLabel();
    });
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".unit-toggle button");
    if (!btn) return;
    currentUnit = btn.getAttribute("data-unit");
    localStorage.setItem("apollo-air1-unit", currentUnit);
    renderUnitToggle();
    loadLatest();
    loadControls();
    loadHistory(currentRange);
  });

  // bandFromAqi comes from static/aqi.js (loaded first), shared across pages.
  function bandFromCo2(co2) {
    if (co2 === undefined || co2 === null || Number.isNaN(co2)) return null;
    if (co2 > 2000) return "bad";
    if (co2 > 1500) return "poor";
    if (co2 > 1000) return "fair";
    return "good";
  }
  // No official health thresholds exist for Sensirion's VOC index the way
  // the EPA publishes them for AQI/CO2 -- these two cutoffs are the same
  // ones used for the readout tile's edge color, just pulled out so the
  // VOC history row can share them.
  function bandForVocIndex(v) {
    if (typeof v !== "number") return null;
    return v > 250 ? "bad" : v > 150 ? "poor" : null;
  }
  function bandVar(band) {
    return band ? `var(--${band})` : "var(--ink-dim)";
  }

  /* ---------- chart rendering (SVG, hand-drawn) ----------
   * Series are plotted by real timestamp (not array index) so sources
   * sampled at different rates overlay correctly on one chart.
   *
   * The viewBox width is the wrap element's own measured pixel width, not a
   * fixed constant -- with CSS sizing the svg to width:100%/height:auto,
   * a fixed viewBox gets scaled to fit whatever the container actually is,
   * and that scale applies to EVERYTHING inside, including fixed-px text
   * and row heights. Measuring the real width and using it 1:1 as the
   * viewBox width means 1 unit = 1 real CSS pixel, so text/stroke/row-height
   * stay true size on every screen. */
  const H = 170, PAD = { l: 38, r: 4, t: 10, b: 20 };

  function measureWidth(el) {
    return Math.max(el.clientWidth, 240);
  }

  function formatTick(v) {
    const abs = Math.abs(v);
    if (abs >= 100) return String(Math.round(v));
    if (abs >= 10) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }

  function pathFor(points, tMin, tMax, vMin, vMax, W) {
    const xw = W - PAD.l - PAD.r;
    const yh = H - PAD.t - PAD.b;
    return points.map((p, i) => {
      const x = PAD.l + ((p.t - tMin) / (tMax - tMin || 1)) * xw;
      const y = PAD.t + yh - ((p.v - vMin) / (vMax - vMin || 1)) * yh;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  function pointAt(p, tMin, tMax, vMin, vMax, W) {
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
    const W = measureWidth(el);
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
      const d = pathFor(s.points, tMin, tMax, lo, hi, W);
      if (s.area) {
        const yh = H - PAD.t - PAD.b;
        const areaD = `${d} L${(W - PAD.r).toFixed(1)},${(PAD.t + yh).toFixed(1)} L${PAD.l},${(PAD.t + yh).toFixed(1)} Z`;
        svg += `<path d="${areaD}" fill="${s.color}" opacity="0.12" stroke="none" />`;
      }
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
      const last = s.points[s.points.length - 1];
      const [ex, ey] = pointAt(last, tMin, tMax, lo, hi, W);
      svg += `<circle class="chart-endpoint" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--panel-raised)" stroke-width="1.5" />`;
    });
    svg += `<text class="chart-axis-label" x="${PAD.l}" y="${H - 4}">${opts.leftLabel || ""}</text>`;
    svg += `<text class="chart-axis-label" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">now</text>`;
    svg += "</svg>";
    el.innerHTML = svg;
  }

  function seriesFor(points, key, color, area) {
    return {
      color,
      area: !!area,
      points: points
        .filter((p) => typeof p[key] === "number")
        .map((p) => ({ t: new Date(p.time).getTime(), v: p[key] })),
    };
  }

  // One SVG, N horizontal lanes -- all rows share the same time axis (drawn
  // once, at the bottom) but each gets its own y-scale sized to its own
  // min/max, so a small-magnitude series is never squashed flat by a big
  // one sharing its axis. Color tracks severity, per point, via the row's
  // own bandFor(value): the line changes color exactly where a reading
  // crosses into fair/poor/bad.
  const ROW_H = 58, ROW_PAD_TOP = 17, ROW_PAD_BOTTOM = 8;
  const ROW_PAD = { l: 2, r: 4 };

  // rows: [{ label, unit, decimals, points: [{t, v}], bandFor(v) => band|null }]
  function renderRowChart(el, rows, opts) {
    const nonEmpty = rows.filter((r) => r.points.length > 0);
    if (nonEmpty.length === 0) {
      el.innerHTML = '<div class="empty-state">No data in this range yet.</div>';
      return;
    }
    const W = measureWidth(el);
    const allTimes = nonEmpty.flatMap((r) => r.points.map((p) => p.t));
    const tMin = Math.min(...allTimes), tMax = Math.max(...allTimes);
    const totalH = nonEmpty.length * ROW_H + 14;

    let svg = `<svg viewBox="0 0 ${W} ${totalH}" preserveAspectRatio="none" role="img" aria-label="${opts.label || "chart"}">`;
    nonEmpty.forEach((r, i) => {
      const top = i * ROW_H;
      if (i > 0) {
        svg += `<line class="chart-grid-line" x1="${ROW_PAD.l}" y1="${top.toFixed(1)}" x2="${W - ROW_PAD.r}" y2="${top.toFixed(1)}" />`;
      }
      const dotY = top + ROW_PAD_TOP - 8;
      const labelY = top + ROW_PAD_TOP - 5;
      const vals = r.points.map((p) => p.v);
      const vMin = Math.min(...vals), vMax = Math.max(...vals);
      const pad = (vMax - vMin) * 0.12 || 1;
      const lo = vMin - pad, hi = vMax + pad;
      const xw = W - ROW_PAD.l - ROW_PAD.r;
      const yh = ROW_H - ROW_PAD_TOP - ROW_PAD_BOTTOM;
      const xAt = (t) => ROW_PAD.l + ((t - tMin) / (tMax - tMin || 1)) * xw;
      const yAt = (v) => top + ROW_PAD_TOP + yh - ((v - lo) / (hi - lo || 1)) * yh;

      for (let j = 1; j < r.points.length; j++) {
        const p0 = r.points[j - 1], p1 = r.points[j];
        const segColor = bandVar(r.bandFor(p1.v));
        svg += `<path d="M${xAt(p0.t).toFixed(1)},${yAt(p0.v).toFixed(1)} L${xAt(p1.t).toFixed(1)},${yAt(p1.v).toFixed(1)}" fill="none" stroke="${segColor}" stroke-width="2" stroke-linecap="round" />`;
      }

      const last = r.points[r.points.length - 1];
      const lastColor = bandVar(r.bandFor(last.v));
      const ex = xAt(last.t), ey = yAt(last.v);
      svg += `<circle class="chart-endpoint" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${lastColor}" stroke="var(--panel-raised)" stroke-width="1.5" />`;
      svg += `<circle cx="${(ROW_PAD.l + 3).toFixed(1)}" cy="${dotY.toFixed(1)}" r="3" fill="${lastColor}" />`;
      svg += `<text class="chart-axis-label" x="${(ROW_PAD.l + 10).toFixed(1)}" y="${labelY.toFixed(1)}">${escapeHtml(r.label)} <tspan style="fill:${lastColor}">${fmt(last.v, r.decimals)}${r.unit}</tspan></text>`;
    });
    const bottomY = nonEmpty.length * ROW_H + 10;
    svg += `<text class="chart-axis-label" x="${ROW_PAD.l}" y="${bottomY}">${opts.leftLabel || ""}</text>`;
    svg += `<text class="chart-axis-label" x="${W - ROW_PAD.r}" y="${bottomY}" text-anchor="end">now</text>`;
    svg += "</svg>";
    el.innerHTML = svg;
  }

  // Rows colored by severity, not identity. PM1.0/PM4.0 have no
  // EPA-recognized health thresholds (only PM2.5/PM10 do), so those two
  // rows stay neutral rather than borrowing numbers that don't apply.
  function renderInsideCharts(points, rangeLabel) {
    renderRowChart(document.getElementById("chart-co2"), [
      { label: "CO2", unit: " ppm", decimals: 0, bandFor: bandFromCo2, points: seriesFor(points, "co2_ppm", null).points },
    ], { leftLabel: rangeLabel, label: "CO2 history" });

    renderRowChart(document.getElementById("chart-pm"), [
      { label: "PM1.0", unit: " µg/m³", decimals: 1, bandFor: () => null, points: seriesFor(points, "pm1_0_ugm3", null).points },
      { label: "PM4.0", unit: " µg/m³", decimals: 1, bandFor: () => null, points: seriesFor(points, "pm4_0_ugm3", null).points },
    ], { leftLabel: rangeLabel, label: "Particulate matter history" });

    renderRowChart(document.getElementById("chart-voc"), [
      { label: "VOC index", unit: "", decimals: 0, bandFor: bandForVocIndex, points: seriesFor(points, "voc_index", null).points },
      { label: "NOx index", unit: "", decimals: 0, bandFor: () => null, points: seriesFor(points, "nox_index", null).points },
    ], { leftLabel: rangeLabel, label: "VOC and NOx index history" });

    const tempSeries = seriesFor(points, "temperature_c", "#e0935a", true);
    if (currentUnit === "f") {
      tempSeries.points = tempSeries.points.map((p) => ({ t: p.t, v: p.v * 9 / 5 + 32 }));
    }
    renderChart(document.getElementById("chart-temp"), [tempSeries], { leftLabel: rangeLabel, label: "Temperature history" });

    renderChart(document.getElementById("chart-hum"), [
      seriesFor(points, "humidity_pct", "#6f9be0", true),
    ], { leftLabel: rangeLabel, label: "Humidity history" });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

  /* ---------- live readout tiles ---------- */
  const READOUT_DEFS = [
    { id: "co2", label: "CO2", unit: "ppm", key: "co2_ppm", decimals: 0, band: (v) => v > 1500 ? "bad" : v > 1000 ? "poor" : null },
    { id: "aqi", label: "AQI", unit: "", key: "aqi", decimals: 0, band: bandFromAqi },
    { id: "pm25", label: "PM2.5", unit: "µg/m³", key: "pm2_5_ugm3", decimals: 1, band: (v) => v > 35 ? "bad" : v > 12 ? "poor" : null },
    { id: "voc", label: "VOC index", unit: "", key: "voc_index", decimals: 0, band: bandForVocIndex },
    { id: "nox", label: "NOx index", unit: "", key: "nox_index", decimals: 0, band: () => null },
    { id: "temp", label: "Temperature", unit: () => tempUnitLabel(), key: "temperature_c", decimals: 1, band: () => null, convert: displayTemp },
    { id: "hum", label: "Humidity", unit: "%", key: "humidity_pct", decimals: 1, band: () => null },
    { id: "pressure", label: "Pressure", unit: "hPa", key: "pressure_hpa", decimals: 1, band: () => null },
  ];

  let previousLatest = null;

  function renderReadouts(latest) {
    const grid = document.getElementById("readout-grid");
    grid.innerHTML = READOUT_DEFS.map((r) => {
      const rawValue = latest ? latest[r.key] : null;
      const prevRawValue = previousLatest ? previousLatest[r.key] : null;
      let dir = "flat";
      if (typeof rawValue === "number" && typeof prevRawValue === "number" && rawValue !== prevRawValue) {
        dir = rawValue > prevRawValue ? "up" : "down";
      }
      const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
      const bandKey = typeof rawValue === "number" ? r.band(rawValue) : null;
      const value = typeof r.convert === "function" ? r.convert(rawValue) : rawValue;
      const unit = typeof r.unit === "function" ? r.unit() : r.unit;
      return `<div class="readout" style="--edge-color: ${bandKey ? `var(--${bandKey})` : "var(--hairline)"}">
        <div class="r-label"><span>${r.label}</span><span class="trend" data-dir="${dir}">${arrow}</span></div>
        <div class="r-value">${fmt(value, r.decimals)}<span class="r-unit">${unit}</span></div>
      </div>`;
    }).join("");
  }

  /* ---------- indoor latest reading ---------- */
  const INDOOR_FIELD_IDS = ["d-rssi", "d-esptemp", "d-uptime", "d-firmware"];

  async function loadLatest() {
    try {
      const res = await fetch("/api/latest");
      if (res.status === 404) {
        setIndoorUnavailable();
        return;
      }
      if (!res.ok) throw new Error("request failed");
      const d = await res.json();

      renderReadouts(d);
      previousLatest = d;

      document.getElementById("d-rssi").textContent = fmt(d.wifi_rssi_db, 0) + " dB";
      document.getElementById("d-esptemp").textContent = fmt(displayTemp(d.esp_temperature_c), 1) + " " + tempUnitLabel();
      const uptimeMin = typeof d.uptime_s === "number" ? d.uptime_s / 60 : null;
      document.getElementById("d-uptime").textContent = fmt(uptimeMin, 1) + " min";
      document.getElementById("d-firmware").textContent = d.firmware_version || "—";
      document.getElementById("since-reading").textContent = timeAgo(d.time);
    } catch (e) {
      setIndoorUnavailable();
    }
  }

  function setIndoorUnavailable() {
    document.getElementById("since-reading").textContent = "—";
    INDOOR_FIELD_IDS.forEach((id) => { document.getElementById(id).textContent = "—"; });
    document.getElementById("readout-grid").innerHTML = "";
    previousLatest = null;
  }

  /* ---------- history / charts ---------- */
  function rangeLabelFor(hours) {
    return { 6: "6h ago", 24: "24h ago", 72: "3d ago", 168: "7d ago" }[hours] || `${hours}h ago`;
  }

  // Charts measure their container's real width at render time (see
  // measureWidth), so a viewport change needs a re-render at the new width.
  // Caching the last-fetched points lets that happen instantly on resize
  // without a network round-trip.
  let lastInsidePoints = null, lastInsideRangeLabel = "";

  async function loadHistory(hours) {
    const res = await fetch(`/api/history?hours=${hours}`);
    const points = res.ok ? await res.json() : [];
    lastInsidePoints = points;
    lastInsideRangeLabel = rangeLabelFor(hours);
    renderInsideCharts(points, lastInsideRangeLabel);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastInsidePoints) renderInsideCharts(lastInsidePoints, lastInsideRangeLabel);
    }, 200);
  });

  /* ---------- controls (real MQTT bridge) -- device setup ---------- */
  const stepperConf = {
    sleep: { object_id: "sleep_duration", step: 1, min: 0, max: 800, digits: 0, stateKey: "sleep_duration_min" },
    toffset: { object_id: "sen55_temperature_offset", step: 0.5, min: -70, max: 70, digits: 1, stateKey: "sen55_temperature_offset", isTempDelta: true },
    hoffset: { object_id: "sen55_humidity_offset", step: 0.5, min: -70, max: 70, digits: 1, stateKey: "sen55_humidity_offset" },
    poffset: { object_id: "dps310_pressure_offset", step: 1, min: -100, max: 100, digits: 1, stateKey: "dps310_pressure_offset" },
  };
  const stepperState = { sleep: null, toffset: null, hoffset: null, poffset: null };

  // The stored/sent value always stays in the device's native °C -- only
  // the displayed text converts, so the +/- step size and what's posted to
  // the backend never change with the unit toggle.
  function displayStepperValue(conf, rawValue) {
    const value = conf.isTempDelta ? displayTempDelta(rawValue) : rawValue;
    return value.toFixed(conf.digits);
  }

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
          document.getElementById("val-" + key).textContent = displayStepperValue(conf, v);
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
      document.getElementById("val-" + key).textContent = displayStepperValue(conf, v);
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

  /* ---------- theme toggle ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function renderThemeToggle() {
    const theme = currentTheme();
    document.querySelectorAll(".theme-toggle button").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-theme-choice") === theme));
    });
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-toggle button");
    if (!btn) return;
    const next = btn.getAttribute("data-theme-choice");
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("apollo-air1-theme", next);
    renderThemeToggle();
  });

  /* ---------- settings panel ---------- */
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const settingsBackdrop = document.getElementById("settings-backdrop");

  function positionSettingsPanel() {
    if (window.innerWidth <= 560) {
      settingsPanel.style.top = "";
      settingsPanel.style.right = "";
      return;
    }
    const rect = settingsToggle.getBoundingClientRect();
    const margin = 20;
    settingsPanel.style.top = `${rect.bottom + 8}px`;
    settingsPanel.style.right = `${Math.max(margin, window.innerWidth - rect.right)}px`;
  }
  function openSettings() {
    positionSettingsPanel();
    settingsPanel.hidden = false;
    settingsBackdrop.hidden = false;
    settingsToggle.setAttribute("aria-expanded", "true");
    window.addEventListener("resize", positionSettingsPanel);
  }
  function closeSettings() {
    settingsPanel.hidden = true;
    settingsBackdrop.hidden = true;
    settingsToggle.setAttribute("aria-expanded", "false");
    window.removeEventListener("resize", positionSettingsPanel);
  }
  settingsToggle.addEventListener("click", () => {
    if (settingsPanel.hidden) openSettings(); else closeSettings();
  });
  settingsBackdrop.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !settingsPanel.hidden) closeSettings();
  });

  /* ---------- range toggle ---------- */
  let currentRange = 24;
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

  /* ---------- init ---------- */
  renderUnitToggle();
  renderThemeToggle();
  loadLatest();
  loadHistory(currentRange);
  loadControls();
  setInterval(loadLatest, 60000);
  setInterval(loadControls, 30000);
  setInterval(() => { loadHistory(currentRange); }, 60000);
})();

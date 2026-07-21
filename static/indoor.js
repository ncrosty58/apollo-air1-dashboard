(function () {
  "use strict";

  // fmt / timeAgo / escapeHtml / bandVar / seriesFor / bandFromCo2 /
  // bandForVocIndex come from common.js; the SVG chart renderers
  // (measureWidth / renderChart / renderRowChart) from chart.js; bandFromAqi
  // from aqi.js. Theme toggle, settings panel, and clock self-init in
  // common.js.

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

  // bandFromCo2 / bandForVocIndex / bandVar / seriesFor come from common.js;
  // measureWidth / renderChart / renderRowChart from chart.js (both loaded
  // first). Charts plot by real timestamp so sources sampled at different
  // rates overlay correctly.

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

  /* ---------- home location editor ----------
   * Deliberately rare to touch: it repoints what Node-RED polls and logs to
   * InfluxDB (see home_config.py), unlike Away (edited from the header's
   * settings panel on every page). Living here rather than in that popover
   * is the friction -- same "Setup" section as the sleep/calibration/
   * factory-reset controls above, which are also rarely-touched device
   * config. This is the same form the old /away page used to host. */

  function renderHome(home) {
    const el = document.getElementById("home-current");
    if (!home || !home.zip) { el.textContent = "No home set"; return; }
    const where = home.reporting_area || home.location_slug || home.zip;
    const sensor = home.purpleair_sensor != null ? ` · PurpleAir #${home.purpleair_sensor}` : " · no PurpleAir sensor";
    el.innerHTML = `${escapeHtml(where)} <span class="eyebrow">(ZIP ${escapeHtml(home.zip)}${escapeHtml(sensor)})</span>`;
  }

  async function loadHome() {
    try {
      const res = await fetch("/api/home");
      renderHome(res.ok ? await res.json() : null);
    } catch (e) {
      renderHome(null);
    }
  }

  // Suggest-and-confirm: preview the nearest PurpleAir sensor before saving, so
  // a bad/flaky pick is visible rather than silently locked in.
  document.getElementById("home-find").addEventListener("click", async () => {
    const zip = document.getElementById("home-zip").value;
    const preview = document.getElementById("home-preview");
    preview.hidden = false;
    preview.textContent = "Looking…";
    try {
      const res = await fetch(`/api/purpleair/nearest?zip=${encodeURIComponent(zip)}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "request failed");
      const s = d.sensor;
      const area = d.reporting_area ? ` — ${d.reporting_area}` : "";
      preview.innerHTML = s
        ? `Will use PurpleAir <strong>${escapeHtml(s.name || "#" + s.index)}</strong> (${s.distance_km} km, confidence ${s.confidence ?? "?"})${escapeHtml(area)}`
        : `No PurpleAir sensor nearby${escapeHtml(area)} — home will have no PurpleAir card.`;
    } catch (err) {
      preview.textContent = "Couldn't check PurpleAir — " + err.message;
    }
  });

  document.getElementById("home-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const zip = document.getElementById("home-zip").value;
    const label = document.getElementById("home-label").value;
    try {
      const res = await fetch("/api/home", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip, label }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "request failed");
      renderHome(d.home);
      document.getElementById("home-preview").hidden = true;
      document.getElementById("home-zip").value = "";
      document.getElementById("home-label").value = "";
      toast(d.published ? "Home updated" : "Home saved (Node-RED will pick it up when the broker reconnects)");
    } catch (err) {
      toast("Couldn't save — " + err.message);
    }
  });

  loadHome();

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

  /* ---------- init ---------- */
  renderUnitToggle();
  loadLatest();
  loadHistory(currentRange);
  loadControls();
  pollInterval(loadLatest, 60000);
  pollInterval(loadControls, 30000);
  pollInterval(() => { loadHistory(currentRange); }, 60000);
})();

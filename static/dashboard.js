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

  function renderUnitToggle() {
    document.querySelectorAll(".unit-toggle").forEach((wrap) => {
      wrap.querySelectorAll("button").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-unit") === currentUnit));
      });
    });
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".unit-toggle button");
    if (!btn) return;
    currentUnit = btn.getAttribute("data-unit");
    localStorage.setItem("apollo-air1-unit", currentUnit);
    renderUnitToggle();
    loadLatest();
  });

  const BAND_ORDER = ["good", "fair", "poor", "bad"];

  // bandFromAqi / aqiFromConcentration / bandForConcentration come from
  // static/aqi.js (loaded first), shared with the other pages.
  function bandFromCo2(co2) {
    if (co2 === undefined || co2 === null || Number.isNaN(co2)) return null;
    if (co2 > 2000) return "bad";
    if (co2 > 1500) return "poor";
    if (co2 > 1000) return "fair";
    return "good";
  }
  function bandForVocIndex(v) {
    if (typeof v !== "number") return null;
    return v > 250 ? "bad" : v > 150 ? "poor" : null;
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
  function bandLabel(band) {
    return { good: "Good", fair: "Fair", poor: "Poor", bad: "Bad" }[band] || null;
  }

  /* ---------- mini sparkline (rack-spark) ----------
   * Deliberately simpler than Technical's charts: one flat color (the
   * current band), no axis/grid/labels -- at 84x34px those would just be
   * noise. Just enough to show "trending up/down/flat" at a glance. */
  function renderMiniSpark(el, points, band) {
    if (!el) return;
    if (!points || points.length === 0) { el.innerHTML = ""; return; }
    const w = el.clientWidth || 84, h = el.clientHeight || 34;
    // A single sample (common for the sparse AirNow feed in a short window)
    // can't draw a trend line -- show a centered dot so the tile reads as
    // "one reading so far", not "broken/blank".
    if (points.length === 1) {
      const c = bandVar(band);
      el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-hidden="true">
        <circle cx="${(w / 2).toFixed(1)}" cy="${(h / 2).toFixed(1)}" r="3" fill="${c}" /></svg>`;
      return;
    }
    const vals = points.map((p) => p.v);
    const vMin = Math.min(...vals), vMax = Math.max(...vals);
    const pad = (vMax - vMin) * 0.15 || 1;
    const lo = vMin - pad, hi = vMax + pad;
    const tMin = points[0].t, tMax = points[points.length - 1].t;
    const xAt = (t) => ((t - tMin) / (tMax - tMin || 1)) * w;
    const yAt = (v) => h - ((v - lo) / (hi - lo || 1)) * h;
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(p.t).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(" ");
    const color = bandVar(band);
    const areaD = `${d} L${w.toFixed(1)},${h} L0,${h} Z`;
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-hidden="true">
      <path d="${areaD}" fill="${color}" opacity="0.14" stroke="none" />
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
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

  /* ---------- provider switch (AirNow / Google / PurpleAir / OpenWeatherMap) ----------
   * The only screen with a switcher -- Technical and Forecast just display
   * whichever provider is currently selected (shared via localStorage). */
  let currentProvider = localStorage.getItem("apollo-air1-provider") || "airnow";

  const PROVIDER_NAMES = { airnow: "AirNow", google: "Google", purpleair: "PurpleAir", openweathermap: "OWM" };
  const PROVIDER_ORDER = ["airnow", "google", "purpleair", "openweathermap"];
  // PurpleAir is the only provider with no forecast: it's one real-time
  // sensor (current + historical only), with no forward-looking model to
  // surface. AirNow, Google and OpenWeatherMap all have a forecast the
  // /forecast page serves (see app.py api_forecast). Showing a Forecast link
  // for PurpleAir would hand back a *different* provider's forecast (AirNow's),
  // which is misleading, so the link is hidden for it. Kept in sync with the
  // server: any provider not handled by api_forecast belongs in this set.
  const PROVIDERS_WITHOUT_FORECAST = new Set(["purpleair"]);

  function providerLabel() {
    return PROVIDER_NAMES[currentProvider] || "AirNow";
  }

  function renderForecastLinkVisibility() {
    const link = document.getElementById("forecast-link");
    if (link) link.hidden = PROVIDERS_WITHOUT_FORECAST.has(currentProvider);
  }

  // Each chip shows that provider's own live AQI (from /api/outside/all,
  // one best-effort call per provider server-side, no extra upstream
  // traffic beyond what browsing them individually would cost) so tapping
  // between sources is also how you see what the other three are reading
  // -- not just a blind tab switch.
  async function loadProviderChips() {
    const wrap = document.getElementById("provider-chips");
    if (!wrap) return;
    try {
      const res = await fetch("/api/outside/all");
      const summary = res.ok ? await res.json() : {};
      wrap.innerHTML = PROVIDER_ORDER.map((p) => {
        const s = summary[p] || { available: false };
        const color = s.available ? bandVar(s.band) : "var(--ink-dim)";
        const aqiText = s.available && typeof s.aqi === "number" ? String(s.aqi) : "—";
        return `<button type="button" class="provider-chip" data-provider="${p}" aria-pressed="${p === currentProvider}" data-unavailable="${!s.available}" style="--pc-color: ${color}">` +
          `<span class="pc-dot"></span>${PROVIDER_NAMES[p]} <span class="pc-aqi">${aqiText}</span></button>`;
      }).join("");
    } catch (e) {
      // Chips just stay at their last-rendered state.
    }
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-chip");
    if (!btn) return;
    currentProvider = btn.getAttribute("data-provider");
    localStorage.setItem("apollo-air1-provider", currentProvider);
    loadProviderChips();
    renderForecastLinkVisibility();
    loadOutside();
    loadBasicSparks();
  });

  // Google's own enum value, abbreviated to the unit symbol everyone reads
  // at a glance.
  function formatConcentrationUnits(units) {
    const short = { PARTS_PER_BILLION: "ppb", MICROGRAMS_PER_CUBIC_METER: "µg/m³" };
    return short[units] || (units || "").replace(/_/g, " ").toLowerCase();
  }

  // EPA's own AQI breakpoint tables (current/2024 revision for PM2.5), each
  // One row per metric instead of a badge grid -- the rack-rows list.
  // --rr-color is a CSS custom prop the .rr-value rule already reads, so an
  // unset (null) band just falls back to the row's default ink color rather
  // than needing a conditional class per row.
  function rackRow(label, valueHtml, band) {
    const style = band ? ` style="--rr-color: ${bandVar(band)}"` : "";
    return `<div class="rack-row"${style}><span class="rr-label">${escapeHtml(label)}</span><span class="rr-value">${valueHtml}</span></div>`;
  }

  // VOC index is included here even though it has no outside equivalent --
  // it's as central an indoor air quality signal as CO2/PM2.5. Temp/Humidity/
  // Pressure/NOx have no severity bands anywhere in this app, so those rows
  // stay neutral-colored. The full set AIR-1's base hardware always reports
  // (SCD40 + SEN55 + DPS310) -- as opposed to the MICS-4514 gas readings,
  // which are an optional add-on this unit doesn't have and stay
  // Technical-only in the Gas sensors table.
  function insideRowsHtml(d) {
    const items = [
      { label: "CO2", value: d.co2_ppm, decimals: 0, unit: "ppm", band: bandFromCo2(d.co2_ppm) },
      { label: "PM2.5", value: d.pm2_5_ugm3, decimals: 1, unit: "µg/m³", band: bandForConcentration("PM2.5", d.pm2_5_ugm3, "MICROGRAMS_PER_CUBIC_METER") },
      { label: "VOC", value: d.voc_index, decimals: 0, unit: "", band: bandForVocIndex(d.voc_index) },
      { label: "NOx", value: d.nox_index, decimals: 0, unit: "", band: null },
      { label: "Temp", value: displayTemp(d.temperature_c), decimals: 1, unit: tempUnitLabel(), band: null },
      { label: "Humidity", value: d.humidity_pct, decimals: 1, unit: "%", band: null },
      { label: "Pressure", value: d.pressure_hpa, decimals: 1, unit: "hPa", band: null },
    ];
    return items.map((it) => {
      const valueHtml = typeof it.value === "number"
        ? `${fmt(it.value, it.decimals)}${it.unit ? `<span class="rr-unit">${it.unit}</span>` : ""}`
        : "—";
      return rackRow(it.label, valueHtml, it.band);
    }).join("");
  }

  // Same pollutant envelope every provider returns (parameter/aqi or
  // parameter/concentration_value).
  function outsideRowsHtml(pollutants) {
    return (pollutants || []).map((p) => {
      let valueHtml, band = null;
      if (typeof p.aqi === "number") {
        valueHtml = String(p.aqi);
        band = bandFromAqi(p.aqi);
      } else if (typeof p.concentration_value === "number") {
        valueHtml = `${p.concentration_value}<span class="rr-unit">${formatConcentrationUnits(p.concentration_units)}</span>`;
        band = bandForConcentration(p.parameter, p.concentration_value, p.concentration_units);
      } else {
        valueHtml = "—";
      }
      return rackRow(p.parameter, valueHtml, band);
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Google's per-population-group guidance -- its equivalent of AirNow's
  // forecaster discussion, just structured differently (no narrative,
  // tailored text per group instead). Children get their own always-visible
  // line, same as general population. Everyone else (elderly, lung
  // disease, heart disease, athletes, pregnant) stays behind a toggle.
  const HEALTH_GROUP_LABELS = {
    elderly: "Elderly",
    lungDiseasePopulation: "Lung disease",
    heartDiseasePopulation: "Heart disease",
    athletes: "Athletes",
    pregnantWomen: "Pregnant",
  };

  function healthRecommendationsHtml(hr) {
    if (!hr || !hr.generalPopulation) return "";
    const groups = Object.entries(HEALTH_GROUP_LABELS)
      .filter(([key]) => hr[key])
      .map(([key, label]) => `<p><strong>${label}:</strong> ${escapeHtml(hr[key])}</p>`)
      .join("");
    const childrenP = hr.children ? `<p><strong>Children:</strong> ${escapeHtml(hr.children)}</p>` : "";
    return `<div class="health-guidance">
      <p class="health-guidance-text">${escapeHtml(hr.generalPopulation)}</p>
      ${childrenP}
      ${groups ? `<button type="button" class="health-guidance-toggle" aria-expanded="false">Guidance for sensitive groups</button>
      <div class="health-guidance-groups" hidden>${groups}</div>` : ""}
    </div>`;
  }

  function outsideDiscussionHtml(d) {
    if (currentProvider === "google") return healthRecommendationsHtml(d.health_recommendations);
    if (!d.discussion) return "";
    return `<div class="forecast-discussion">
      <button type="button" class="discussion-toggle" aria-expanded="false">Forecaster's discussion</button>
      <p class="discussion-text" hidden>${escapeHtml(d.discussion)}</p>
    </div>`;
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".discussion-toggle, .health-guidance-toggle");
    if (!btn) return;
    const body = btn.nextElementSibling;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });

  /* ---------- outside (AirNow / Google / PurpleAir / OpenWeatherMap) ---------- */
  async function loadOutside() {
    try {
      const res = await fetch(`/api/outside?provider=${currentProvider}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "request failed");

      const band = d.band;
      const outAqi = document.getElementById("out-aqi");
      outAqi.textContent = typeof d.aqi === "number" ? String(d.aqi) : "—";
      outAqi.style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-area").textContent = d.reporting_area || "—";
      document.getElementById("out-category").textContent = d.category || "Loading…";
      document.getElementById("out-sub").textContent = d.dominant_pollutant ? `Driven by ${d.dominant_pollutant}` : "";
      document.getElementById("outside-rows").innerHTML = outsideRowsHtml(d.pollutants);
      document.getElementById("outside-discussion").innerHTML = outsideDiscussionHtml(d);
    } catch (e) {
      document.getElementById("out-aqi").textContent = "—";
      document.getElementById("out-category").textContent = "Couldn't reach " + providerLabel() + ".";
      document.getElementById("out-sub").textContent = "";
      document.getElementById("outside-rows").innerHTML = "";
      document.getElementById("outside-discussion").innerHTML = "";
    }
  }

  // Basic view's compact trend lines -- a short (6h) fetch, independent of
  // Technical's own range control (a separate page now), so the
  // at-a-glance sparkline never jumps around based on state set elsewhere.
  async function loadBasicSparks() {
    try {
      const [insideRes, outsideRes] = await Promise.allSettled([
        fetch("/api/history?hours=6"),
        fetch(`/api/outside/history?hours=6&provider=${currentProvider}`),
      ]);
      const insidePoints = insideRes.status === "fulfilled" && insideRes.value.ok ? await insideRes.value.json() : [];
      const outsidePoints = outsideRes.status === "fulfilled" && outsideRes.value.ok ? await outsideRes.value.json() : [];
      const inSeries = seriesFor(insidePoints, "aqi", null).points;
      const outSeries = seriesFor(outsidePoints, "aqi", null).points;
      renderMiniSpark(document.getElementById("in-spark"), inSeries, inSeries.length ? bandFromAqi(inSeries[inSeries.length - 1].v) : null);
      renderMiniSpark(document.getElementById("out-spark"), outSeries, outSeries.length ? bandFromAqi(outSeries[outSeries.length - 1].v) : null);
    } catch (e) {
      // Decorative -- fine to leave the sparklines blank on failure.
    }
  }

  /* ---------- indoor latest reading ---------- */
  async function loadLatest() {
    try {
      const res = await fetch("/api/latest");
      if (res.status === 404) {
        setIndoorUnavailable("Waiting for the AIR-1 to report in.");
        return;
      }
      if (!res.ok) throw new Error("request failed");
      const d = await res.json();

      const band = worseBand(bandFromAqi(d.aqi), bandFromCo2(d.co2_ppm));
      const inAqi = document.getElementById("in-aqi");
      inAqi.textContent = typeof d.aqi === "number" ? String(Math.round(d.aqi)) : "—";
      inAqi.style.setProperty("--band-color", bandVar(band));
      document.getElementById("in-category").textContent = bandLabel(band) || "Waiting for a reading…";
      document.getElementById("in-sub").textContent = insideSentence(band);
      document.getElementById("inside-rows").innerHTML = insideRowsHtml(d);
    } catch (e) {
      setIndoorUnavailable("Couldn't reach the sensor feed.");
    }
  }

  function setIndoorUnavailable(msg) {
    document.getElementById("in-category").textContent = "—";
    document.getElementById("in-sub").textContent = msg;
    const inAqi = document.getElementById("in-aqi");
    inAqi.textContent = "—";
    inAqi.style.setProperty("--band-color", "var(--ink-dim)");
    document.getElementById("inside-rows").innerHTML = insideRowsHtml({});
  }

  /* ---------- connection status (lamp) ---------- */
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
    } catch (e) {
      // Staying at the last-known display is preferable to blanking it out.
    }
  }

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
  loadProviderChips();
  renderForecastLinkVisibility();
  renderUnitToggle();
  renderThemeToggle();
  loadLatest();
  loadOutside();
  loadBasicSparks();
  loadControls();
  setInterval(loadLatest, 60000);
  setInterval(() => { loadOutside(); loadProviderChips(); loadBasicSparks(); }, 15 * 60000);
  setInterval(loadControls, 30000);
})();

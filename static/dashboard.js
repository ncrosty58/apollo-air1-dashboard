(function () {
  "use strict";

  // fmt / timeAgo / escapeHtml / bandVar / formatConcentrationUnits /
  // bandFromCo2 / bandForVocIndex / seriesFor / readoutMode and the provider
  // constants come from common.js; bandFromAqi / bandForConcentration /
  // aqiFromConcentration from aqi.js (both loaded first). Theme toggle, readout
  // toggle, settings panel, clock, and SW registration self-init in common.js.

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

  function worseBand(a, b) {
    if (!a) return b;
    if (!b) return a;
    return BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b) ? a : b;
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

  /* ---------- provider switch (AirNow / Google / PurpleAir / OpenWeatherMap) ----------
   * The only screen with a switcher -- Technical and Forecast just display
   * whichever provider is currently selected (shared via localStorage).
   * PROVIDER_NAMES / PROVIDER_ORDER / PROVIDERS_WITHOUT_FORECAST live in
   * common.js so this page and the server's api_forecast set can't drift.
   *
   * Home and Away each remember their own provider choice (currentMode/
   * getAwayLoc come from common.js) so flipping modes never clobbers the
   * other's pick -- same reasoning as the old Away page's own storage key. */
  function providerStorageKey() {
    return currentMode() === "away" ? "apollo-air1-away-provider" : "apollo-air1-provider";
  }
  function defaultProvider() {
    return currentMode() === "away" ? "google" : "airnow";
  }
  let currentProvider = localStorage.getItem(providerStorageKey()) || defaultProvider();

  function providerLabel() {
    return PROVIDER_NAMES[currentProvider] || "AirNow";
  }

  function updateForecastLink() {
    const link = document.getElementById("forecast-link");
    if (!link) return;
    link.hidden = PROVIDERS_WITHOUT_FORECAST.has(currentProvider);
    const awayLoc = currentMode() === "away" ? getAwayLoc() : null;
    link.href = awayLoc ? `/forecast?zip=${encodeURIComponent(awayLoc.zip)}` : "/forecast";
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
      const res = await fetch(`/api/outside/all?mode=${currentMode()}`);
      const summary = res.ok ? await res.json() : {};
      wrap.innerHTML = PROVIDER_ORDER.map((p) => {
        const s = summary[p] || { available: false };
        const color = s.available ? bandVar(s.band) : "var(--ink-dim)";
        const aqiText = s.available && typeof s.aqi === "number" ? String(s.aqi) : "—";
        // A dim chip alone doesn't say why -- e.g. "no healthy PurpleAir
        // sensor nearby" vs. "no away location set" are both just "off"
        // without this, so the reason the API already returns goes on the
        // chip as a hover title.
        const titleAttr = !s.available && s.reason ? ` title="${escapeHtml(s.reason)}"` : "";
        return `<button type="button" class="provider-chip" data-provider="${p}" aria-pressed="${p === currentProvider}" data-unavailable="${!s.available}" style="--pc-color: ${color}"${titleAttr}>` +
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
    localStorage.setItem(providerStorageKey(), currentProvider);
    loadProviderChips();
    updateForecastLink();
    loadOutside();
    loadBasicSparks();
  });

  // The header's Home/Away rail (common.js) flips the whole outside half of
  // this page over to the other location's data.
  document.addEventListener("modechange", () => {
    currentProvider = localStorage.getItem(providerStorageKey()) || defaultProvider();
    loadProviderChips();
    updateForecastLink();
    loadOutside();
    loadBasicSparks();
  });

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

  // Readout=AQI (the default) puts every provider on one comparable scale --
  // each pollutant's AQI. Anything that can't be put on that scale (OWM's NH3,
  // which has no EPA breakpoint) is dropped here; it reappears under
  // Readout=Units, which shows the provider's reported concentration instead,
  // falling back to AQI for AirNow (which reports no concentration). The AQI is
  // derived upstream (Node-RED) and read per pollutant; the concentration->AQI
  // fallback only fills a gap for older points stored without a per-pollutant
  // AQI -- the app does no primary AQI math.
  function outsideRowsHtml(pollutants) {
    const units = readoutMode() === "units";
    return (pollutants || []).map((p) => {
      if (units) {
        if (typeof p.concentration_value === "number") {
          const valueHtml = `${p.concentration_value}<span class="rr-unit">${formatConcentrationUnits(p.concentration_units)}</span>`;
          return rackRow(p.parameter, valueHtml, bandForConcentration(p.parameter, p.concentration_value, p.concentration_units));
        }
        return typeof p.aqi === "number" ? rackRow(p.parameter, String(p.aqi), bandFromAqi(p.aqi)) : null;
      }
      const aqi = typeof p.aqi === "number" ? p.aqi
        : (typeof p.concentration_value === "number" ? aqiFromConcentration(p.parameter, p.concentration_value, p.concentration_units) : null);
      return typeof aqi === "number" ? rackRow(p.parameter, String(aqi), bandFromAqi(aqi)) : null;
    }).filter(Boolean).join("");
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
  // Kept so the AQI/Units readout toggle can re-render the rows without refetching.
  let lastOutsidePollutants = null;

  async function loadOutside() {
    // Kept outside the try/catch so the catch block can tell an API-reported
    // reason (e.g. "no healthy PurpleAir sensor nearby") apart from a genuine
    // network/parse failure, and show the real one instead of a generic line.
    let apiErrorMsg = null;
    try {
      const res = await fetch(`/api/outside?provider=${currentProvider}&mode=${currentMode()}`);
      const d = await res.json();
      if (!res.ok) { apiErrorMsg = d.error || "request failed"; throw new Error(apiErrorMsg); }

      const band = d.band;
      const outAqi = document.getElementById("out-aqi");
      outAqi.textContent = typeof d.aqi === "number" ? String(d.aqi) : "—";
      outAqi.style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-area").textContent = d.reporting_area || "—";
      document.getElementById("out-category").textContent = d.category || "Loading…";
      document.getElementById("out-sub").textContent = d.dominant_pollutant ? `Driven by ${d.dominant_pollutant}` : "";
      lastOutsidePollutants = d.pollutants;
      document.getElementById("outside-rows").innerHTML = outsideRowsHtml(d.pollutants);
      document.getElementById("outside-discussion").innerHTML = outsideDiscussionHtml(d);
      // When the selected provider's reading was last refreshed into the DB.
      document.getElementById("out-updated").textContent = d.time ? "Updated " + timeAgo(d.time) : "";
    } catch (e) {
      document.getElementById("out-aqi").textContent = "—";
      document.getElementById("out-category").textContent = apiErrorMsg || ("Couldn't reach " + providerLabel() + ".");
      document.getElementById("out-sub").textContent = "";
      lastOutsidePollutants = null;
      document.getElementById("outside-rows").innerHTML = "";
      document.getElementById("outside-discussion").innerHTML = "";
      document.getElementById("out-updated").textContent = "";
    }
  }

  // Re-render the outside rows in place when the AQI/Units readout is toggled
  // (common.js persists the choice and fires this event); no refetch needed.
  document.addEventListener("readoutchange", () => {
    if (lastOutsidePollutants) {
      document.getElementById("outside-rows").innerHTML = outsideRowsHtml(lastOutsidePollutants);
    }
  });

  // Basic view's compact trend lines -- a short (6h) fetch, independent of
  // Technical's own range control (a separate page now), so the
  // at-a-glance sparkline never jumps around based on state set elsewhere.
  async function loadBasicSparks() {
    try {
      const [insideRes, outsideRes] = await Promise.allSettled([
        fetch("/api/history?hours=6"),
        fetch(`/api/outside/history?hours=6&provider=${currentProvider}&mode=${currentMode()}`),
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
      // When the AIR-1 last reported a reading into the DB.
      document.getElementById("in-updated").textContent = d.time ? "Updated " + timeAgo(d.time) : "";
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
    document.getElementById("in-updated").textContent = "";
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

  /* ---------- init ---------- */
  loadProviderChips();
  updateForecastLink();
  fetchAwayLoc().then(updateForecastLink);
  renderUnitToggle();
  loadLatest();
  loadOutside();
  loadBasicSparks();
  loadControls();
  pollInterval(loadLatest, 60000);
  pollInterval(() => { loadOutside(); loadProviderChips(); loadBasicSparks(); }, 15 * 60000);
  pollInterval(loadControls, 30000);
})();

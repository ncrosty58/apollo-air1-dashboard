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

  // Matches Outside rack-sub's "Driven by <pollutant>" instead of a custom
  // advice sentence -- same worseBand() comparison used for the headline
  // category (below), so whichever factor actually pushed it there is the
  // one named, not a fixed guess.
  function insideDrivenBy(d, band) {
    if (!band) return "";
    const aqiBand = bandFromAqi(d.aqi);
    const co2Band = bandFromCo2(d.co2_ppm);
    const co2IsWorse = !aqiBand || (co2Band && BAND_ORDER.indexOf(co2Band) > BAND_ORDER.indexOf(aqiBand));
    return co2IsWorse ? "Driven by CO2" : "Driven by PM2.5";
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
   * The chip bar itself, currentProvider(), and the shared "modechange"
   * re-fetch all live in common.js now (the persistent bar is the same
   * control on Overview/Outdoor/Forecast, not just this page). This page
   * only needs to react to a provider actually changing. */
  function providerLabel() {
    return PROVIDER_NAMES[currentProvider()] || "AirNow";
  }

  document.addEventListener("providerchange", () => {
    loadOutside();
    loadBasicSparks();
  });

  // The header's Home/Away rail (common.js) flips the whole outside half of
  // this page over to the other location's data -- the provider choice
  // itself doesn't change, just what it's fetched for.
  document.addEventListener("modechange", () => {
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

  // PM2.5 leads (and, under Readout=AQI, reads on the same 0-500 scale as
  // Outside's own first row) so it lands on the same row as Outside's PM2.5
  // -- the one pollutant both racks share -- letting a glance across the two
  // columns compare them directly instead of hunting for the matching label.
  // PM1.0/PM4.0 follow PM10 as neutral (no EPA band) rows -- the non-standard
  // sizes have no health threshold and no Outside counterpart, shown here only
  // for parity with the Inside tab.
  // VOC index comes next even though it has no outside equivalent -- it's as
  // central an indoor air quality signal as CO2/PM2.5. Temp/Humidity/
  // Pressure/NOx have no severity bands anywhere in this app, so those rows
  // stay neutral-colored. The full set AIR-1's base hardware always reports
  // (SCD40 + SEN55 + DPS310) -- as opposed to the MICS-4514 gas readings,
  // which are an optional add-on this unit doesn't have and stay
  // Technical-only in the Gas sensors table.
  function insideRowsHtml(d) {
    const units = readoutMode() === "units";
    const pmRow = (parameter, raw) => {
      const band = bandForConcentration(parameter, raw, "MICROGRAMS_PER_CUBIC_METER");
      return units
        ? { label: parameter, value: raw, decimals: 1, unit: "µg/m³", band }
        : { label: parameter, value: aqiFromConcentration(parameter, raw, "MICROGRAMS_PER_CUBIC_METER"), decimals: 0, unit: "", band };
    };
    const items = [
      pmRow("PM2.5", d.pm2_5_ugm3),
      pmRow("PM10", d.pm10_0_ugm3),
      // "PM1"/"PM4", not "PM1.0"/"PM4.0" -- with a real (non-placeholder)
      // decimal value next to it, the full label overflowed the rack's
      // narrow column even with the unit hidden (see .rack-row .rr-label
      // in style.css). Indoor/Technical keep the full "PM1.0"/"PM4.0".
      { label: "PM1", value: d.pm1_0_ugm3, decimals: 1, unit: "µg/m³", band: null },
      { label: "PM4", value: d.pm4_0_ugm3, decimals: 1, unit: "µg/m³", band: null },
      { label: "CO2", value: d.co2_ppm, decimals: 0, unit: "ppm", band: bandFromCo2(d.co2_ppm) },
      { label: "VOC", value: d.voc_index, decimals: 0, unit: "", band: bandForVocIndex(d.voc_index) },
      { label: "NOx", value: d.nox_index, decimals: 0, unit: "", band: null },
      // Whole-number here (not Indoor/Technical's 1 decimal) -- same
      // column-width problem as PM1/PM4 above, but a fractional degree/
      // percent/hPa isn't information this glance view needs anyway.
      { label: "Temp", value: displayTemp(d.temperature_c), decimals: 0, unit: tempUnitLabel(), band: null },
      // Shortened from Indoor/Technical's "Humidity"/"Pressure" -- "Humid"/
      // "Press" still overflowed by a character's width once real (not
      // placeholder-dash) values were in the value column next to them.
      { label: "Hum", value: d.humidity_pct, decimals: 0, unit: "%", band: null },
      { label: "Pres", value: d.pressure_hpa, decimals: 0, unit: "hPa", band: null },
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

  /* ---------- outside (AirNow / Google / PurpleAir / OpenWeatherMap) ---------- */
  // Kept so the AQI/Units readout toggle can re-render the rows without refetching.
  let lastOutsidePollutants = null;

  // Forecaster's discussion / Google health guidance live on the Outdoor
  // page now (technical.js), not here -- the dashboard is the at-a-glance
  // view and that commentary was the biggest thing standing between it and
  // fitting on one screen without scrolling.
  async function loadOutside() {
    // Kept outside the try/catch so the catch block can tell an API-reported
    // reason (e.g. "no healthy PurpleAir sensor nearby") apart from a genuine
    // network/parse failure, and show the real one instead of a generic line.
    let apiErrorMsg = null;
    try {
      const res = await fetch(`/api/outside?provider=${currentProvider()}&mode=${currentMode()}`);
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
      // Which provider this reading is from and when it was last refreshed
      // into the DB -- both in one place, since the persistent chip bar's
      // highlight alone wasn't a clear enough tell of the current selection.
      document.getElementById("out-updated").textContent = d.time
        ? `via ${providerLabel()} · Updated ${timeAgo(d.time)}`
        : `via ${providerLabel()}`;
    } catch (e) {
      document.getElementById("out-aqi").textContent = "—";
      document.getElementById("out-category").textContent = apiErrorMsg || ("Couldn't reach " + providerLabel() + ".");
      document.getElementById("out-sub").textContent = "";
      lastOutsidePollutants = null;
      document.getElementById("outside-rows").innerHTML = "";
      document.getElementById("out-updated").textContent = "";
    }
  }

  // Re-render both racks' rows in place when the AQI/Units readout is
  // toggled (common.js persists the choice and fires this event); no
  // refetch needed. Inside's row order doesn't otherwise depend on this --
  // only PM2.5's own value/unit does (see insideRowsHtml).
  document.addEventListener("readoutchange", () => {
    if (lastOutsidePollutants) {
      document.getElementById("outside-rows").innerHTML = outsideRowsHtml(lastOutsidePollutants);
    }
    if (lastInsideLatest) {
      document.getElementById("inside-rows").innerHTML = insideRowsHtml(lastInsideLatest);
    }
  });

  // Basic view's compact trend lines -- a short (6h) fetch, independent of
  // Technical's own range control (a separate page now), so the
  // at-a-glance sparkline never jumps around based on state set elsewhere.
  async function loadBasicSparks() {
    try {
      const [insideRes, outsideRes] = await Promise.allSettled([
        fetch("/api/history?hours=6"),
        fetch(`/api/outside/history?hours=6&provider=${currentProvider()}&mode=${currentMode()}`),
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
  // Kept so the AQI/Units readout toggle can re-render PM2.5's row without
  // refetching -- same pattern as lastOutsidePollutants above.
  let lastInsideLatest = null;

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
      document.getElementById("in-sub").textContent = insideDrivenBy(d, band);
      lastInsideLatest = d;
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
    lastInsideLatest = null;
    document.getElementById("inside-rows").innerHTML = insideRowsHtml({});
    document.getElementById("in-updated").textContent = "";
  }

  /* ---------- init ---------- */
  updateForecastLink();
  fetchAwayLoc().then(updateForecastLink);
  renderUnitToggle();
  loadLatest();
  loadOutside();
  loadBasicSparks();
  pollInterval(loadLatest, 60000);
  pollInterval(() => { loadOutside(); loadBasicSparks(); }, 15 * 60000);
})();

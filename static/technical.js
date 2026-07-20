(function () {
  "use strict";

  // fmt / timeAgo / bandVar / escapeHtml / formatConcentrationUnits /
  // seriesFor and the provider constants come from common.js; the SVG chart
  // renderers (measureWidth / renderRowChart / renderOverlayRowChart) from
  // chart.js; bandFromAqi / aqiFromConcentration / bandForConcentration from
  // aqi.js. Theme toggle, settings panel, and clock self-init in common.js.

  function formatObservedHour(hour) {
    if (typeof hour !== "number") return "—";
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.toLocaleTimeString([], { hour: "numeric" });
  }

  /* ---------- temperature unit (F/C) -- the Inside vs Outside weather
     overlay chart needs this even though this page has no indoor readouts
     of its own. ---------- */
  let currentUnit = localStorage.getItem("apollo-air1-unit") || "f";

  function tempUnitLabel() {
    return currentUnit === "f" ? "°F" : "°C";
  }
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
    loadOutsideHistorySection(currentRangeOutside);
  });

  // bandVar / measureWidth / renderRowChart / renderOverlayRowChart come from
  // common.js + chart.js (loaded first). Charts plot by real timestamp so
  // sources sampled at different rates (indoor ~5-10min vs AirNow hourly)
  // overlay correctly.

  // defs: [key, label, unit, decimals, bandFor(v)][]
  function renderPollutantRows(chartElId, points, defs, rangeLabel, chartLabel) {
    const rows = defs.map(([key, label, unit, decimals, bandFor]) => ({
      label, unit, decimals, bandFor,
      points: seriesFor(points, key, null).points,
    }));
    renderRowChart(document.getElementById(chartElId), rows, { leftLabel: rangeLabel, label: chartLabel });
  }

  function toAqiSeries(points, parameter, units) {
    return points
      .map((p) => ({ t: p.t, v: aqiFromConcentration(parameter, p.v, units) }))
      .filter((p) => typeof p.v === "number");
  }

  // AirNow is the only provider that gives *only* a computed AQI, never a
  // raw concentration -- Google, PurpleAir, and OpenWeatherMap all report
  // real µg/m³/ppb numbers (owm.py and purpleair.py deliberately reuse
  // google_aq.py's own field names -- pm2_5_ugm3, o3_ppb, etc. -- for
  // exactly this reason), so they share the same "raw concentration"
  // branch as Google rather than each needing their own case.
  function providerGivesConcentrations() {
    return currentProvider !== "airnow";
  }

  // insidePoints/outsidePoints are both needed on the same time axis --
  // called from the same place that already fetches both (see
  // loadOutsideHistorySection) rather than each chart fetching its own copy.
  //
  // AQI is the one number every provider gives on a shared 0-500 scale, so it
  // always overlays. Everything else only overlays where AIR-1 and the
  // selected provider measure the *same* thing in real units: providers that
  // give raw concentrations overlay PM2.5/PM10 (already µg/m³ on both sides)
  // directly. AirNow never gives a raw concentration for anything -- only
  // computed AQI numbers -- so AIR-1's own raw PM2.5/PM10 convert to an
  // actual EPA AQI number (toAqiSeries/aqiFromConcentration) and overlay
  // against AirNow's pm2_5_aqi/pm10_aqi on that shared scale instead. CO/NO2
  // needed the optional MICS-4514, which this unit doesn't have, so those
  // never overlay. O3 and SO2 have no indoor equivalent either (no ozone or
  // SO2 sensor at all), so they stay outside-only in the charts above.
  function renderInsideOutsideCharts(insidePoints, outsidePoints, rangeLabel) {
    renderOverlayRowChart(document.getElementById("chart-aqi-compare"), [
      {
        label: "AQI", unit: "", decimals: 0,
        inside: { points: seriesFor(insidePoints, "aqi", null).points, bandFor: bandFromAqi },
        outside: { points: seriesFor(outsidePoints, "aqi", null).points, bandFor: bandFromAqi },
      },
    ], { leftLabel: rangeLabel, label: "Inside vs outside AQI history" });

    if (providerGivesConcentrations()) {
      renderOverlayRowChart(document.getElementById("chart-inside-outside-pollutants"), [
        {
          label: "PM2.5", unit: " µg/m³", decimals: 1,
          inside: { points: seriesFor(insidePoints, "pm2_5_ugm3", null).points, bandFor: (v) => bandForConcentration("PM2.5", v, "MICROGRAMS_PER_CUBIC_METER") },
          outside: { points: seriesFor(outsidePoints, "pm2_5_ugm3", null).points, bandFor: (v) => bandForConcentration("PM2.5", v, "MICROGRAMS_PER_CUBIC_METER") },
        },
        {
          label: "PM10", unit: " µg/m³", decimals: 1,
          inside: { points: seriesFor(insidePoints, "pm10_0_ugm3", null).points, bandFor: (v) => bandForConcentration("PM10", v, "MICROGRAMS_PER_CUBIC_METER") },
          outside: { points: seriesFor(outsidePoints, "pm10_ugm3", null).points, bandFor: (v) => bandForConcentration("PM10", v, "MICROGRAMS_PER_CUBIC_METER") },
        },
      ], { leftLabel: rangeLabel, label: "Inside vs outside pollutant concentration history" });
    } else {
      renderOverlayRowChart(document.getElementById("chart-inside-outside-pollutants"), [
        {
          label: "PM2.5 AQI", unit: "", decimals: 0,
          inside: { points: toAqiSeries(seriesFor(insidePoints, "pm2_5_ugm3", null).points, "PM2.5", "MICROGRAMS_PER_CUBIC_METER"), bandFor: bandFromAqi },
          outside: { points: seriesFor(outsidePoints, "pm2_5_aqi", null).points, bandFor: bandFromAqi },
        },
        {
          label: "PM10 AQI", unit: "", decimals: 0,
          inside: { points: toAqiSeries(seriesFor(insidePoints, "pm10_0_ugm3", null).points, "PM10", "MICROGRAMS_PER_CUBIC_METER"), bandFor: bandFromAqi },
          outside: { points: seriesFor(outsidePoints, "pm10_aqi", null).points, bandFor: bandFromAqi },
        },
      ], { leftLabel: rangeLabel, label: "Inside vs outside pollutant AQI history" });
    }

    // Weather isn't provider-dependent -- it comes from a separate feed
    // regardless of which provider is selected for pollutants -- so this
    // renders the same way either way. No severity bands exist anywhere in
    // this app for temp/humidity/pressure.
    const insideTemp = seriesFor(insidePoints, "temperature_c", null).points.map((p) => ({ t: p.t, v: displayTemp(p.v) }));
    const outsideTemp = seriesFor(outsidePoints, "temperature_c", null).points.map((p) => ({ t: p.t, v: displayTemp(p.v) }));
    renderOverlayRowChart(document.getElementById("chart-inside-outside-weather"), [
      {
        label: "Temp", unit: tempUnitLabel(), decimals: 1,
        inside: { points: insideTemp, bandFor: () => null },
        outside: { points: outsideTemp, bandFor: () => null },
      },
      {
        label: "Humidity", unit: "%", decimals: 1,
        inside: { points: seriesFor(insidePoints, "humidity_pct", null).points, bandFor: () => null },
        outside: { points: seriesFor(outsidePoints, "humidity_pct", null).points, bandFor: () => null },
      },
      {
        label: "Pressure", unit: " hPa", decimals: 1,
        inside: { points: seriesFor(insidePoints, "pressure_hpa", null).points, bandFor: () => null },
        outside: { points: seriesFor(outsidePoints, "pressure_hpa", null).points, bandFor: () => null },
      },
    ], { leftLabel: rangeLabel, label: "Inside vs outside temperature, humidity, pressure history" });
  }

  // Which non-overlapping pollutants (if any) this provider has beyond
  // PM2.5/PM10 -- those already live in the Inside vs Outside overlay chart
  // above, so they're never plotted twice here. AirNow gives per-pollutant
  // AQI numbers; Google/OpenWeatherMap give raw gas concentrations (same
  // field names, see providerGivesConcentrations); PurpleAir is PM-only --
  // a single physical sensor with no gas channel at all -- so it has
  // nothing left to show in this section once PM is excluded.
  function outsideExtraPollutantsMode() {
    if (currentProvider === "airnow") return "aqi";
    if (currentProvider === "purpleair") return "none";
    return "gases";
  }

  function renderOutsideCharts(outsidePoints, rangeLabel) {
    const mode = outsideExtraPollutantsMode();
    document.getElementById("card-outside-pollutants-aqi").hidden = mode !== "aqi";
    document.getElementById("card-outside-pollutants-gases").hidden = mode !== "gases";

    if (mode === "gases") {
      // CO/NO2 used to overlay against AIR-1's MICS-4514 readings, but this
      // unit doesn't have that sensor -- they're outside-only now, same as
      // O3/SO2 (which never had an indoor equivalent to begin with).
      renderPollutantRows("chart-outside-gases", outsidePoints, [
        ["o3_ppb", "O3", " ppb", 1, (v) => bandForConcentration("O3", v, "PARTS_PER_BILLION")],
        ["no2_ppb", "NO2", " ppb", 2, (v) => bandForConcentration("NO2", v, "PARTS_PER_BILLION")],
        ["so2_ppb", "SO2", " ppb", 2, (v) => bandForConcentration("SO2", v, "PARTS_PER_BILLION")],
        ["co_ppb", "CO", " ppb", 2, (v) => bandForConcentration("CO", v, "PARTS_PER_BILLION")],
      ], rangeLabel, "Outside gas concentration history");
    } else if (mode === "aqi") {
      renderPollutantRows("chart-outside-pollutants", outsidePoints, [
        ["o3_aqi", "O3", "", 0, bandFromAqi],
        ["no2_aqi", "NO2", "", 0, bandFromAqi],
      ], rangeLabel, "Outside pollutant AQI history");
    }
  }

  /* ---------- provider (read-only here -- switching only happens on Basic) ----------
   * PROVIDER_NAMES / PROVIDERS_WITHOUT_FORECAST live in common.js. */
  let currentProvider = localStorage.getItem("apollo-air1-provider") || "airnow";

  function providerLabel() {
    return PROVIDER_NAMES[currentProvider] || "AirNow";
  }

  // Technical is the engineering view: prefer the raw concentration (µg/m³ /
  // ppb) when the provider reports one, and fall back to AQI only for providers
  // that report no concentration (AirNow). Providers now also carry a per-
  // pollutant AQI used by the Basic dashboard; checking concentration first
  // keeps this page showing units, not that AQI.
  function pollutantFactorsHtml(pollutants) {
    return (pollutants || []).map((p) => {
      let valueHtml;
      let band = null;
      if (typeof p.concentration_value === "number") {
        valueHtml = `${p.concentration_value}<span class="op-unit">${formatConcentrationUnits(p.concentration_units)}</span>`;
        band = bandForConcentration(p.parameter, p.concentration_value, p.concentration_units);
      } else if (typeof p.aqi === "number") {
        valueHtml = String(p.aqi);
        band = bandFromAqi(p.aqi);
      } else {
        valueHtml = "—";
      }
      const colorStyle = band ? ` style="color: ${bandVar(band)}"` : "";
      return `<span class="outside-pollutant">${p.parameter}<span class="op-value"${colorStyle}>${valueHtml}</span></span>`;
    }).join("");
  }

  /* ---------- outside current reading ---------- */
  async function loadOutside() {
    try {
      const res = await fetch(`/api/outside?provider=${currentProvider}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "request failed");

      const band = d.band;
      const whenText = d.time ? timeAgo(d.time) : formatObservedHour(d.observed_hour);

      document.getElementById("outside-aqi-tech").textContent = d.aqi ?? "—";
      document.getElementById("outside-aqi-tech").style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-category-tech").textContent = d.category || "—";
      document.getElementById("outside-dominant-tech").textContent = d.dominant_pollutant ? `Driven by ${d.dominant_pollutant}` : "";
      document.getElementById("outside-area-tech").textContent = d.reporting_area || "—";
      document.getElementById("outside-updated-tech").textContent = whenText;
      document.getElementById("outside-tech-card").style.setProperty("--edge-color", bandVar(band));
      document.getElementById("outside-pollutants").innerHTML = pollutantFactorsHtml(d.pollutants);
    } catch (e) {
      document.getElementById("outside-aqi-tech").textContent = "—";
      document.getElementById("outside-category-tech").textContent = "Unavailable";
      document.getElementById("outside-dominant-tech").textContent = "";
      document.getElementById("outside-pollutants").innerHTML = "";
    }
  }

  /* ---------- history / charts ---------- */
  function rangeLabelFor(hours) {
    return { 6: "6h ago", 24: "24h ago", 72: "3d ago", 168: "7d ago" }[hours] || `${hours}h ago`;
  }

  // Charts measure their container's real width at render time (see
  // measureWidth), so a viewport change needs a re-render at the new width.
  // Caching the last-fetched points lets that happen instantly on resize
  // without a network round-trip.
  let lastOutsideSectionInsidePoints = null, lastOutsidePoints = null, lastOutsideRangeLabel = "";

  async function loadOutsideHistorySection(hours) {
    const [insideRes, outsideRes] = await Promise.allSettled([
      fetch(`/api/history?hours=${hours}`),
      fetch(`/api/outside/history?hours=${hours}&provider=${currentProvider}`),
    ]);
    const insidePoints = insideRes.status === "fulfilled" && insideRes.value.ok ? await insideRes.value.json() : [];
    const outsidePoints = outsideRes.status === "fulfilled" && outsideRes.value.ok ? await outsideRes.value.json() : [];
    lastOutsideSectionInsidePoints = insidePoints;
    lastOutsidePoints = outsidePoints;
    lastOutsideRangeLabel = rangeLabelFor(hours);
    renderOutsideCharts(outsidePoints, lastOutsideRangeLabel);
    renderInsideOutsideCharts(insidePoints, outsidePoints, lastOutsideRangeLabel);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastOutsidePoints) {
        renderOutsideCharts(lastOutsidePoints, lastOutsideRangeLabel);
        renderInsideOutsideCharts(lastOutsideSectionInsidePoints, lastOutsidePoints, lastOutsideRangeLabel);
      }
    }, 200);
  });

  /* ---------- connection status (lamp) -- read-only awareness, Setup lives on /indoor ---------- */
  async function loadConnectionStatus() {
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

  /* ---------- range toggle ---------- */
  let currentRangeOutside = 24;
  document.querySelectorAll("#range-toggle-outside button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#range-toggle-outside button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      currentRangeOutside = Number(btn.getAttribute("data-range"));
      loadOutsideHistorySection(currentRangeOutside);
    });
  });

  /* ---------- init ---------- */
  renderUnitToggle();
  document.getElementById("outside-source-tech").textContent = providerLabel();
  const forecastLink = document.getElementById("forecast-link");
  if (forecastLink) forecastLink.hidden = PROVIDERS_WITHOUT_FORECAST.has(currentProvider);
  loadOutside();
  loadOutsideHistorySection(currentRangeOutside);
  loadConnectionStatus();
  pollInterval(loadOutside, 15 * 60000);
  pollInterval(loadConnectionStatus, 30000);
  pollInterval(() => { loadOutsideHistorySection(currentRangeOutside); }, 60000);
})();

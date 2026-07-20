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

  // bandFromAqi / aqiFromConcentration / bandForConcentration come from
  // static/aqi.js (loaded first), shared with the other pages.
  function bandVar(band) {
    return band ? `var(--${band})` : "var(--ink-dim)";
  }

  /* ---------- chart rendering (SVG, hand-drawn, row-based) ----------
   * Series are plotted by real timestamp (not array index) so that sources
   * sampled at different rates — e.g. indoor readings every ~5-10min vs.
   * AirNow's hourly outdoor readings — overlay correctly on one chart.
   *
   * The viewBox width is the wrap element's own measured pixel width, not a
   * fixed constant -- with CSS sizing the svg to width:100%/height:auto,
   * a fixed viewBox gets scaled to fit whatever the container actually is,
   * and that scale applies to EVERYTHING inside, including fixed-px text
   * and row heights. Measuring the real width and using it 1:1 as the
   * viewBox width means 1 unit = 1 real CSS pixel, so text/stroke/
   * row-height stay true size on every screen. */
  function measureWidth(el) {
    return Math.max(el.clientWidth, 240);
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
  // min/max, so a small-magnitude series (CO ~0.1ppb) is never squashed flat
  // by a big one (O3 ~45ppb) sharing its axis. Identity isn't color-coded
  // here (each row is already labeled by name) -- color instead tracks
  // severity, per point, via the row's own bandFor(value).
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

  // Same idea as renderRowChart, but each row overlays two series (Inside
  // and Outside) sharing one y-scale within that row. Color still tracks
  // severity per point on each line; Inside/Outside identity comes from
  // line style (Inside dashed, Outside solid) and the "In"/"Out" label
  // prefix instead, since color is already spoken for.
  // rows: [{ label, unit, decimals, inside: {points, bandFor}, outside: {points, bandFor} }]
  function renderOverlayRowChart(el, rows, opts) {
    const nonEmpty = rows.filter((r) => r.inside.points.length > 0 || r.outside.points.length > 0);
    if (nonEmpty.length === 0) {
      el.innerHTML = '<div class="empty-state">No data in this range yet.</div>';
      return;
    }
    const W = measureWidth(el);
    const allTimes = nonEmpty.flatMap((r) => [...r.inside.points, ...r.outside.points].map((p) => p.t));
    const tMin = Math.min(...allTimes), tMax = Math.max(...allTimes);
    const totalH = nonEmpty.length * ROW_H + 14;

    let svg = `<svg viewBox="0 0 ${W} ${totalH}" preserveAspectRatio="none" role="img" aria-label="${opts.label || "chart"}">`;
    nonEmpty.forEach((r, i) => {
      const top = i * ROW_H;
      if (i > 0) {
        svg += `<line class="chart-grid-line" x1="${ROW_PAD.l}" y1="${top.toFixed(1)}" x2="${W - ROW_PAD.r}" y2="${top.toFixed(1)}" />`;
      }
      const combined = [...r.inside.points, ...r.outside.points];
      const vals = combined.map((p) => p.v);
      const vMin = Math.min(...vals), vMax = Math.max(...vals);
      const pad = (vMax - vMin) * 0.12 || 1;
      const lo = vMin - pad, hi = vMax + pad;
      const xw = W - ROW_PAD.l - ROW_PAD.r;
      const yh = ROW_H - ROW_PAD_TOP - ROW_PAD_BOTTOM;
      const xAt = (t) => ROW_PAD.l + ((t - tMin) / (tMax - tMin || 1)) * xw;
      const yAt = (v) => top + ROW_PAD_TOP + yh - ((v - lo) / (hi - lo || 1)) * yh;

      const drawSeries = (series, dashed) => {
        for (let j = 1; j < series.points.length; j++) {
          const p0 = series.points[j - 1], p1 = series.points[j];
          const segColor = bandVar(series.bandFor(p1.v));
          const dashAttr = dashed ? ' stroke-dasharray="4,3"' : "";
          svg += `<path d="M${xAt(p0.t).toFixed(1)},${yAt(p0.v).toFixed(1)} L${xAt(p1.t).toFixed(1)},${yAt(p1.v).toFixed(1)}" fill="none" stroke="${segColor}" stroke-width="2" stroke-linecap="round"${dashAttr} />`;
        }
        if (series.points.length === 0) return null;
        const last = series.points[series.points.length - 1];
        const color = bandVar(series.bandFor(last.v));
        const ex = xAt(last.t), ey = yAt(last.v);
        if (dashed) {
          svg += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="var(--panel-raised)" stroke="${color}" stroke-width="2" />`;
        } else {
          svg += `<circle class="chart-endpoint" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${color}" stroke="var(--panel-raised)" stroke-width="1.5" />`;
        }
        return last;
      };

      const lastIn = drawSeries(r.inside, true);
      const lastOut = drawSeries(r.outside, false);
      const inColor = lastIn ? bandVar(r.inside.bandFor(lastIn.v)) : "var(--ink-dim)";
      const outColor = lastOut ? bandVar(r.outside.bandFor(lastOut.v)) : "var(--ink-dim)";
      const inText = lastIn ? `In ${fmt(lastIn.v, r.decimals)}${r.unit}` : "In —";
      const outText = lastOut ? `Out ${fmt(lastOut.v, r.decimals)}${r.unit}` : "Out —";
      const labelY = top + ROW_PAD_TOP - 5;
      svg += `<text class="chart-axis-label" x="${ROW_PAD.l.toFixed(1)}" y="${labelY.toFixed(1)}">${escapeHtml(r.label)} <tspan style="fill:${inColor}">${inText}</tspan> · <tspan style="fill:${outColor}">${outText}</tspan></text>`;
    });
    const bottomY = nonEmpty.length * ROW_H + 10;
    svg += `<text class="chart-axis-label" x="${ROW_PAD.l}" y="${bottomY}">${opts.leftLabel || ""}</text>`;
    svg += `<text class="chart-axis-label" x="${W - ROW_PAD.r}" y="${bottomY}" text-anchor="end">now</text>`;
    svg += "</svg>";
    el.innerHTML = svg;
  }

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

  /* ---------- provider (read-only here -- switching only happens on Basic) ---------- */
  let currentProvider = localStorage.getItem("apollo-air1-provider") || "airnow";
  const PROVIDER_NAMES = { airnow: "AirNow", google: "Google", purpleair: "PurpleAir", openweathermap: "OWM" };
  // PurpleAir is the only provider with no forecast (one real-time sensor,
  // nothing forward-looking to show) -- the Forecast link would point at a
  // different provider's data than what's on screen, so it's hidden for it.
  const PROVIDERS_WITHOUT_FORECAST = new Set(["purpleair"]);

  function providerLabel() {
    return PROVIDER_NAMES[currentProvider] || "AirNow";
  }

  // Google's own enum value, abbreviated to the unit symbol everyone reads
  // at a glance.
  function formatConcentrationUnits(units) {
    const short = { PARTS_PER_BILLION: "ppb", MICROGRAMS_PER_CUBIC_METER: "µg/m³" };
    return short[units] || (units || "").replace(/_/g, " ").toLowerCase();
  }

  // AQI breakpoints + aqiFromConcentration + bandForConcentration come from
  // static/aqi.js (loaded first), shared with the other pages.

  function pollutantFactorsHtml(pollutants) {
    return (pollutants || []).map((p) => {
      let valueHtml;
      let band = null;
      if (typeof p.aqi === "number") {
        valueHtml = String(p.aqi);
        band = bandFromAqi(p.aqi);
      } else if (typeof p.concentration_value === "number") {
        valueHtml = `${p.concentration_value}<span class="op-unit">${formatConcentrationUnits(p.concentration_units)}</span>`;
        band = bandForConcentration(p.parameter, p.concentration_value, p.concentration_units);
      } else {
        valueHtml = "—";
      }
      const colorStyle = band ? ` style="color: ${bandVar(band)}"` : "";
      return `<span class="outside-pollutant">${p.parameter}<span class="op-value"${colorStyle}>${valueHtml}</span></span>`;
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  let currentRangeOutside = 24;
  document.querySelectorAll("#range-toggle-outside button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#range-toggle-outside button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      currentRangeOutside = Number(btn.getAttribute("data-range"));
      loadOutsideHistorySection(currentRangeOutside);
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
  document.getElementById("outside-source-tech").textContent = providerLabel();
  const forecastLink = document.getElementById("forecast-link");
  if (forecastLink) forecastLink.hidden = PROVIDERS_WITHOUT_FORECAST.has(currentProvider);
  loadOutside();
  loadOutsideHistorySection(currentRangeOutside);
  loadConnectionStatus();
  setInterval(loadOutside, 15 * 60000);
  setInterval(loadConnectionStatus, 30000);
  setInterval(() => { loadOutsideHistorySection(currentRangeOutside); }, 60000);
})();

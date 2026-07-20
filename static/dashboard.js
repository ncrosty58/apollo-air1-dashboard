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
    if (!viewTechnical.hidden) loadHistory(currentRange);
  });

  const BAND_ORDER = ["good", "fair", "poor", "bad"];

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
  // No official health thresholds exist for Sensirion's VOC index the way
  // the EPA publishes them for AQI/CO2 -- these two cutoffs are the same
  // ones already used for the Technical readout tile's edge color, just
  // pulled out so the new VOC history row can share them instead of
  // duplicating the numbers.
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
   * Deliberately simpler than the Technical charts: one flat color (the
   * current band), no axis/grid/labels -- at 84x34px those would just be
   * noise. Just enough to show "trending up/down/flat" at a glance. */
  function renderMiniSpark(el, points, band) {
    if (!el) return;
    if (!points || points.length < 2) { el.innerHTML = ""; return; }
    const w = el.clientWidth || 84, h = el.clientHeight || 34;
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
  /* ---------- chart rendering (SVG, hand-drawn) ----------
   * Series are plotted by real timestamp (not array index) so that sources
   * sampled at different rates — e.g. indoor readings every ~5-10min vs.
   * AirNow's hourly outdoor readings — overlay correctly on one chart.
   *
   * The viewBox width is the wrap element's own measured pixel width, not a
   * fixed constant -- with CSS sizing the svg to width:100%/height:auto,
   * a fixed viewBox (e.g. 760) gets scaled to fit whatever the container
   * actually is, and that scale applies to EVERYTHING inside, including
   * fixed-px text and row heights. On a ~300px mobile card that's a ~0.4x
   * squeeze -- an 11px label renders at under 5px. Measuring the real width
   * and using it 1:1 as the viewBox width means 1 unit = 1 real CSS pixel,
   * so text/stroke/row-height stay true size on every screen; only the
   * horizontal data density changes with available width, same as any
   * other responsive chart. */
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

  // Styled like the outside pollutant charts: rows colored by severity
  // instead of identity, sharing a time axis but each scaled to its own
  // range. PM1.0/PM4.0 have no EPA-recognized health thresholds (only
  // PM2.5/PM10 do), so those two rows stay neutral rather than borrowing
  // numbers that don't apply to them. PM2.5/PM10 reuse the same
  // bandForConcentration thresholds as the outside particulate chart, so
  // "orange" means the same thing on both sides of the wall.
  function renderInsideCharts(points, rangeLabel) {
    renderRowChart(document.getElementById("chart-co2"), [
      { label: "CO2", unit: " ppm", decimals: 0, bandFor: bandFromCo2, points: seriesFor(points, "co2_ppm", null).points },
    ], { leftLabel: rangeLabel, label: "CO2 history" });

    // PM2.5 and PM10 are covered by the Inside vs Outside pollutants chart
    // (which shows this same indoor line, overlaid against the outdoor
    // reading) -- listing them again here would just be the same data twice.
    // PM1.0 and PM4.0 have no outdoor equivalent, so they stay here.
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

  // One SVG, N horizontal lanes -- all rows share the same time axis (drawn
  // once, at the bottom) but each gets its own y-scale sized to its own
  // min/max, so a small-magnitude series (CO ~0.1ppb) is never squashed flat
  // by a big one (O3 ~45ppb) sharing its axis. Identity isn't color-coded
  // here (each row is already labeled by name) -- color instead tracks
  // severity, per point, via the row's own bandFor(value): the line changes
  // color exactly where a reading crosses into fair/poor/bad, same as the
  // band colors used everywhere else in the app (bandFromAqi, bandVar).
  const ROW_H = 58, ROW_PAD_TOP = 17, ROW_PAD_BOTTOM = 8;
  // Row charts have no left-side axis (that's what PAD.l's 38px is for --
  // renderChart's numeric y-axis ticks). Each row labels itself above its
  // own line instead, so a big left gutter here is just unexplained empty
  // space -- rows get a small margin matching the right side instead.
  const ROW_PAD = { l: 2, r: 4 };

  // rows: [{ label, unit, decimals, points: [{t, v}], bandFor(v) => band|null }]
  // Rows with no points in range (e.g. a pollutant this station never
  // reports at all, like NO2 for some AirNow stations) are dropped
  // entirely rather than shown as a permanent "no data" placeholder.
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

      // Drawn as one short segment per point-to-point step (instead of one
      // path for the whole line) so each step can carry its own stroke
      // color -- the segment ending at a reading is colored by that
      // reading's band.
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
  // and Outside) sharing one y-scale within that row, since the whole point
  // is comparing their magnitudes directly. Color still tracks severity per
  // point on each line; Inside/Outside identity comes from line style
  // (Inside dashed, Outside solid) and the "In"/"Out" label prefix instead,
  // since color is already spoken for.
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
  // History/branch as Google rather than each needing their own case.
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

    // Weather isn't provider-dependent -- neither AirNow nor Google gives
    // it, it comes from a separate feed regardless of which one is
    // selected for pollutants -- so this renders the same way either way.
    // No severity bands exist anywhere in this app for temp/humidity/
    // pressure, same as the indoor-only Temperature/Humidity charts.
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
  async function loadLatest() {
    try {
      const res = await fetch("/api/latest");
      if (res.status === 404) {
        setIndoorUnavailable("Waiting for the AIR-1 to report in.");
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

  const INDOOR_FIELD_IDS = ["d-rssi", "d-esptemp", "d-uptime", "d-firmware"];

  function setIndoorUnavailable(msg) {
    document.getElementById("in-category").textContent = "—";
    document.getElementById("in-sub").textContent = msg;
    document.getElementById("since-reading").textContent = "—";
    const inAqi = document.getElementById("in-aqi");
    inAqi.textContent = "—";
    inAqi.style.setProperty("--band-color", "var(--ink-dim)");
    document.getElementById("inside-rows").innerHTML = insideRowsHtml({});
    INDOOR_FIELD_IDS.forEach((id) => { document.getElementById(id).textContent = "—"; });
    document.getElementById("readout-grid").innerHTML = "";
    previousLatest = null;
  }

  /* ---------- history / charts ---------- */
  function rangeLabelFor(hours) {
    return { 6: "6h ago", 24: "24h ago", 72: "3d ago", 168: "7d ago" }[hours] || `${hours}h ago`;
  }

  // Charts measure their container's real width at render time (see
  // measureWidth), so a viewport change -- rotating a phone, resizing a
  // window -- needs a re-render at the new width or it stays sized for the
  // old one. Caching the last-fetched points lets that re-render happen
  // instantly on resize without a network round-trip.
  let lastInsidePoints = null, lastInsideRangeLabel = "";
  let lastOutsideSectionInsidePoints = null, lastOutsidePoints = null, lastOutsideRangeLabel = "";

  async function loadHistory(hours) {
    const res = await fetch(`/api/history?hours=${hours}`);
    const points = res.ok ? await res.json() : [];
    lastInsidePoints = points;
    lastInsideRangeLabel = rangeLabelFor(hours);
    renderInsideCharts(points, lastInsideRangeLabel);
  }

  // Outside gets its own range control (separate from Inside's, above) --
  // the comparison chart still needs an Inside series on the same axis, so
  // this re-fetches /api/history at whatever range Outside is set to,
  // independent of what the Inside section is currently showing.
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

  function rerenderVisibleCharts() {
    if (viewTechnical.hidden) return;
    if (lastInsidePoints) renderInsideCharts(lastInsidePoints, lastInsideRangeLabel);
    if (lastOutsidePoints) {
      renderOutsideCharts(lastOutsidePoints, lastOutsideRangeLabel);
      renderInsideOutsideCharts(lastOutsideSectionInsidePoints, lastOutsidePoints, lastOutsideRangeLabel);
    }
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerenderVisibleCharts, 200);
  });

  /* ---------- provider switch (AirNow / Google / PurpleAir / OpenWeatherMap) ---------- */
  let currentProvider = localStorage.getItem("apollo-air1-provider") || "airnow";

  const PROVIDER_NAMES = { airnow: "AirNow", google: "Google", purpleair: "PurpleAir", openweathermap: "OWM" };
  const PROVIDER_ORDER = ["airnow", "google", "purpleair", "openweathermap"];

  function providerLabel() {
    return PROVIDER_NAMES[currentProvider] || "AirNow";
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
    document.getElementById("outside-source-tech").textContent = providerLabel();
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-chip");
    if (!btn) return;
    currentProvider = btn.getAttribute("data-provider");
    localStorage.setItem("apollo-air1-provider", currentProvider);
    loadProviderChips();
    loadOutside();
    loadBasicSparks();
    if (!viewTechnical.hidden) loadOutsideHistorySection(currentRangeOutside);
  });

  // Google's own enum value, abbreviated to the unit symbol everyone reads
  // at a glance -- spelled out ("parts per billion") it's fine in a
  // sentence but overwhelms a small readout tile.
  function formatConcentrationUnits(units) {
    const short = { PARTS_PER_BILLION: "ppb", MICROGRAMS_PER_CUBIC_METER: "µg/m³" };
    return short[units] || (units || "").replace(/_/g, " ").toLowerCase();
  }

  // EPA's own AQI breakpoint tables (current/2024 revision for PM2.5), each
  // row [concLo, concHi, aqiLo, aqiHi] -- lets a raw concentration convert
  // to the actual EPA AQI number via the same piecewise-linear interpolation
  // EPA uses, not just a good/fair/poor/bad bucket. That's what makes a
  // sensor-only pollutant (AIR-1's raw PM2.5/PM10 µg/m³) directly overlayable
  // against AirNow's own pm2_5_aqi/pm10_aqi, which is never a raw
  // concentration. Units must match what the source reports: ppb for gases
  // except CO (EPA's own CO breakpoints are in ppm), µg/m³ for particulates.
  const AQI_BREAKPOINTS = {
    "PM2.5": [[0.0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]],
    "PM10": [[0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150], [255, 354, 151, 200], [355, 424, 201, 300], [425, 604, 301, 500]],
    "O3": [[0, 54, 0, 50], [55, 70, 51, 100], [71, 85, 101, 150], [86, 105, 151, 200], [106, 200, 201, 300]],
    "NO2": [[0, 53, 0, 50], [54, 100, 51, 100], [101, 360, 101, 150], [361, 649, 151, 200], [650, 1249, 201, 300], [1250, 2049, 301, 500]],
    "SO2": [[0, 35, 0, 50], [36, 75, 51, 100], [76, 185, 101, 150], [186, 304, 151, 200]],
    "CO": [[0.0, 4.4, 0, 50], [4.5, 9.4, 51, 100], [9.5, 12.4, 101, 150], [12.5, 15.4, 151, 200]],
  };
  function aqiFromConcentration(parameter, value, units) {
    const table = AQI_BREAKPOINTS[parameter];
    if (typeof value !== "number" || !table) return null;
    const v = parameter === "CO" && units === "PARTS_PER_BILLION" ? value / 1000 : value;
    if (v <= 0) return 0;
    // EPA's tables round concentrations to 0.1 (PM2.5/CO) or a whole unit
    // before choosing a bucket, which leaves a hairline gap between one
    // bucket's high and the next's low (PM2.5: ...9.0 | 9.1...) that a raw
    // unrounded sensor reading can land inside. Picking the last bucket
    // whose low bound the value has reached (rather than requiring it fall
    // inside [low, high]) keeps the value in a bucket -- extrapolating a
    // hair past that bucket's own high end -- instead of falling through to
    // nothing and reporting a wrong 0.
    let row = table[0];
    for (const candidate of table) {
      if (v >= candidate[0]) row = candidate;
      else break;
    }
    const [concLo, concHi, aqiLo, aqiHi] = row;
    const aqi = ((aqiHi - aqiLo) / (concHi - concLo)) * (v - concLo) + aqiLo;
    return Math.round(Math.max(0, Math.min(500, aqi)));
  }
  function bandForConcentration(parameter, value, units) {
    return bandFromAqi(aqiFromConcentration(parameter, value, units));
  }

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
  // Pressure/NOx have no severity bands anywhere in this app (no established
  // thresholds), so those rows stay neutral-colored. The full set AIR-1's
  // base hardware always reports (SCD40 + SEN55 + DPS310) -- as opposed to
  // the MICS-4514 gas readings, which are an optional add-on this unit
  // doesn't have and stay Technical-only in the Gas sensors table.
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
  // parameter/concentration_value) -- shared by outsideRowsHtml (Basic
  // rack) and pollutantFactorsHtml (Technical card) below.
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

  // Google's per-population-group guidance -- its equivalent of AirNow's
  // forecaster discussion, just structured differently (no narrative,
  // tailored text per group instead). Children get their own always-visible
  // line, same as general population -- kids react differently to air
  // quality than the general-population text assumes, and it's the one
  // group most likely to matter for this household. Everyone else (elderly,
  // lung disease, heart disease, athletes, pregnant) stays behind a toggle.
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
      const whenText = d.time ? timeAgo(d.time) : formatObservedHour(d.observed_hour);

      const outAqi = document.getElementById("out-aqi");
      outAqi.textContent = typeof d.aqi === "number" ? String(d.aqi) : "—";
      outAqi.style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-area").textContent = d.reporting_area || "—";
      document.getElementById("out-category").textContent = d.category || "Loading…";
      document.getElementById("out-sub").textContent = d.dominant_pollutant ? `Driven by ${d.dominant_pollutant}` : "";
      document.getElementById("outside-rows").innerHTML = outsideRowsHtml(d.pollutants);
      document.getElementById("outside-discussion").innerHTML = outsideDiscussionHtml(d);

      document.getElementById("outside-aqi-tech").textContent = d.aqi ?? "—";
      document.getElementById("outside-aqi-tech").style.setProperty("--band-color", bandVar(band));
      document.getElementById("outside-category-tech").textContent = d.category || "—";
      document.getElementById("outside-dominant-tech").textContent = d.dominant_pollutant ? `Driven by ${d.dominant_pollutant}` : "";
      document.getElementById("outside-area-tech").textContent = d.reporting_area || "—";
      document.getElementById("outside-updated-tech").textContent = whenText;
      document.getElementById("outside-tech-card").style.setProperty("--edge-color", bandVar(band));
      document.getElementById("outside-pollutants").innerHTML = pollutantFactorsHtml(d.pollutants);
    } catch (e) {
      document.getElementById("out-aqi").textContent = "—";
      document.getElementById("out-category").textContent = "Couldn't reach " + providerLabel() + ".";
      document.getElementById("out-sub").textContent = "";
      document.getElementById("outside-rows").innerHTML = "";
      document.getElementById("outside-discussion").innerHTML = "";
      document.getElementById("outside-aqi-tech").textContent = "—";
      document.getElementById("outside-category-tech").textContent = "Unavailable";
      document.getElementById("outside-dominant-tech").textContent = "";
      document.getElementById("outside-pollutants").innerHTML = "";
    }
  }

  // Basic view's compact trend lines -- a short (6h) fetch of the same
  // history endpoints Technical uses at whatever range is selected there,
  // independent of that range so the at-a-glance sparkline never jumps
  // around when someone changes Technical's range control.
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
  /* ---------- controls (real MQTT bridge) ---------- */
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

  /* ---------- view toggle ---------- */
  const tabSimple = document.getElementById("tab-simple");
  const tabTechnical = document.getElementById("tab-technical");
  const viewSimple = document.getElementById("view-simple");
  const viewTechnical = document.getElementById("view-technical");
  let currentRange = 24;
  let currentRangeOutside = 24;

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
      loadOutsideHistorySection(currentRangeOutside);
      loadControls();
    }
  }
  tabSimple.addEventListener("click", () => setView("simple"));
  tabTechnical.addEventListener("click", () => setView("technical"));
  document.getElementById("to-technical").addEventListener("click", () => setView("technical"));

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
    loadHistory(currentRange);
    loadOutsideHistorySection(currentRangeOutside);
  });

  /* ---------- settings panel ---------- */
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const settingsBackdrop = document.getElementById("settings-backdrop");

  function positionSettingsPanel() {
    // Below 560px the panel is a fixed bottom sheet (CSS handles left/
    // right/bottom) -- clear any inline position so that isn't fought.
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

  /* ---------- range toggles (Inside and Outside are independent) ---------- */
  document.querySelectorAll("#range-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#range-toggle button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      currentRange = Number(btn.getAttribute("data-range"));
      loadHistory(currentRange);
    });
  });
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

  /* ---------- service worker ---------- */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is a nice-to-have; the app works fine without it.
    });
  }

  /* ---------- init ---------- */
  const savedView = localStorage.getItem("apollo-air1-view");
  setView(savedView === "technical" ? "technical" : "simple");
  loadProviderChips();
  renderUnitToggle();
  renderThemeToggle();
  loadLatest();
  loadOutside();
  loadBasicSparks();
  loadControls();
  setInterval(loadLatest, 60000);
  setInterval(() => { loadOutside(); loadProviderChips(); loadBasicSparks(); }, 15 * 60000);
  setInterval(loadControls, 30000);
  setInterval(() => {
    if (!viewTechnical.hidden) {
      loadHistory(currentRange);
      loadOutsideHistorySection(currentRangeOutside);
    }
  }, 60000);
})();

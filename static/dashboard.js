const SVG_NS = "http://www.w3.org/2000/svg";

function fmt(value, decimals) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(decimals);
}

function el(tag, attrs, children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (children || []).forEach((c) => e.appendChild(c));
  return e;
}

// Renders a multi-series line chart with hover crosshair + tooltip into `container`.
// series: [{ key, label, color }], points: [{ time: iso, [key]: number, ... }]
function renderLineChart(container, points, series) {
  container.innerHTML = "";
  if (!points || points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data in this range yet.";
    container.appendChild(empty);
    return;
  }

  const width = 1000;
  const height = 220;
  const margin = { top: 10, right: 12, bottom: 22, left: 40 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const times = points.map((p) => new Date(p.time).getTime());
  const xMin = Math.min(...times);
  const xMax = Math.max(...times);

  let yMin = Infinity, yMax = -Infinity;
  series.forEach((s) => {
    points.forEach((p) => {
      const v = p[s.key];
      if (typeof v === "number" && !Number.isNaN(v)) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    });
  });
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data in this range yet.";
    container.appendChild(empty);
    return;
  }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.1;
  yMin -= pad; yMax += pad;

  const x = (t) => margin.left + ((t - xMin) / (xMax - xMin || 1)) * innerW;
  const y = (v) => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
  });

  // gridlines (4 horizontal)
  const gridGroup = el("g", { class: "grid" });
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = margin.top + (innerH / gridSteps) * i;
    gridGroup.appendChild(el("line", { x1: margin.left, x2: width - margin.right, y1: gy, y2: gy }));
  }
  svg.appendChild(gridGroup);

  // y axis labels
  const axisGroup = el("g", { class: "axis" });
  for (let i = 0; i <= gridSteps; i++) {
    const v = yMax - ((yMax - yMin) / gridSteps) * i;
    const gy = margin.top + (innerH / gridSteps) * i;
    const t = el("text", { x: 4, y: gy + 3 });
    t.textContent = fmt(v, Math.abs(v) < 10 ? 1 : 0);
    axisGroup.appendChild(t);
  }
  // x axis labels (start / mid / end)
  [0, 0.5, 1].forEach((frac) => {
    const t = new Date(xMin + (xMax - xMin) * frac);
    const label = t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const anchor = frac === 0 ? "start" : frac === 1 ? "end" : "middle";
    const tx = el("text", { x: x(t.getTime()), y: height - 4, "text-anchor": anchor });
    tx.textContent = label;
    axisGroup.appendChild(tx);
  });
  svg.appendChild(axisGroup);

  // lines
  series.forEach((s) => {
    const pathPoints = points
      .filter((p) => typeof p[s.key] === "number" && !Number.isNaN(p[s.key]))
      .map((p) => `${x(new Date(p.time).getTime())},${y(p[s.key])}`);
    if (pathPoints.length === 0) return;
    const path = el("path", {
      class: "line",
      d: "M" + pathPoints.join(" L"),
      stroke: s.color,
    });
    svg.appendChild(path);
  });

  // hover layer
  const crosshair = el("line", { class: "crosshair", y1: margin.top, y2: margin.top + innerH, x1: -100, x2: -100 });
  svg.appendChild(crosshair);
  const hoverDots = series.map((s) => {
    const dot = el("circle", { class: "hover-dot", r: 4, fill: s.color, cx: -100, cy: -100 });
    svg.appendChild(dot);
    return dot;
  });

  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";
  wrapper.appendChild(svg);
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  wrapper.appendChild(tooltip);
  container.appendChild(wrapper);

  const overlay = el("rect", {
    x: margin.left, y: margin.top, width: innerW, height: innerH,
    fill: "transparent",
  });
  svg.appendChild(overlay);

  function nearestIndex(mouseT) {
    let best = 0, bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(new Date(p.time).getTime() - mouseT);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  overlay.addEventListener("mousemove", (evt) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const mx = (evt.clientX - rect.left) * scaleX;
    const mouseT = xMin + ((mx - margin.left) / innerW) * (xMax - xMin);
    const idx = nearestIndex(mouseT);
    const p = points[idx];
    const px = x(new Date(p.time).getTime());
    crosshair.setAttribute("x1", px);
    crosshair.setAttribute("x2", px);

    let rows = "";
    series.forEach((s, i) => {
      const v = p[s.key];
      const dot = hoverDots[i];
      if (typeof v === "number" && !Number.isNaN(v)) {
        dot.setAttribute("cx", px);
        dot.setAttribute("cy", y(v));
        rows += `<div class="row"><span class="swatch" style="background:${s.color}"></span>${s.label}: ${fmt(v, 1)}</div>`;
      } else {
        dot.setAttribute("cx", -100);
      }
    });
    const time = new Date(p.time).toLocaleString();
    tooltip.innerHTML = `<div class="row" style="color:var(--text-secondary)">${time}</div>${rows}`;
    tooltip.style.display = "block";
    const tipLeft = (px / width) * rect.width;
    tooltip.style.left = Math.min(tipLeft + 8, rect.width - 160) + "px";
    tooltip.style.top = "4px";
  });
  overlay.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    crosshair.setAttribute("x1", -100);
    crosshair.setAttribute("x2", -100);
    hoverDots.forEach((d) => d.setAttribute("cx", -100));
  });
}

function statusFor(kind, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  if (kind === "aqi") {
    if (value <= 50) return { label: "Good", color: "var(--good)" };
    if (value <= 100) return { label: "Moderate", color: "var(--warning)" };
    if (value <= 150) return { label: "Unhealthy (sensitive)", color: "var(--serious)" };
    return { label: "Unhealthy", color: "var(--critical)" };
  }
  if (kind === "co2") {
    if (value <= 1000) return { label: "Good", color: "var(--good)" };
    if (value <= 2000) return { label: "Elevated", color: "var(--warning)" };
    if (value <= 5000) return { label: "Poor", color: "var(--serious)" };
    return { label: "Very poor", color: "var(--critical)" };
  }
  return null;
}

function setTile(id, value, decimals) {
  const node = document.getElementById(id);
  if (node) node.textContent = fmt(value, decimals);
}

function setChip(id, kind, value) {
  const node = document.getElementById(id);
  if (!node) return;
  const status = statusFor(kind, value);
  if (!status) { node.style.display = "none"; return; }
  node.style.display = "inline-flex";
  node.innerHTML = `<span class="dot" style="background:${status.color}"></span>${status.label}`;
}

function setHero(aqi, co2) {
  const badge = document.getElementById("hero-badge");
  if (!badge) return;
  // Whichever of AQI / CO2 reads worse drives the headline, since a non-technical
  // reader only wants one answer, not two numbers to reconcile.
  const aqiStatus = statusFor("aqi", aqi);
  const co2Status = statusFor("co2", co2);
  const order = ["Good", "Moderate", "Elevated", "Unhealthy (sensitive)", "Poor", "Unhealthy", "Very poor"];
  let status = aqiStatus;
  if (co2Status && (!status || order.indexOf(co2Status.label) > order.indexOf(status.label))) {
    status = co2Status;
  }
  if (!status) {
    badge.textContent = "—";
    badge.style.color = "";
    return;
  }
  badge.textContent = status.label;
  badge.style.color = status.color;
}

async function loadLatest() {
  try {
    const res = await fetch("/api/latest");
    if (!res.ok) throw new Error("request failed");
    const d = await res.json();

    setTile("t-co2", d.co2_ppm, 0);
    setChip("c-co2", "co2", d.co2_ppm);
    setTile("t-aqi", d.aqi, 0);
    setChip("c-aqi", "aqi", d.aqi);
    setTile("t-pm25", d.pm2_5_ugm3, 1);
    setTile("t-voc", d.voc_index, 0);
    setTile("t-nox", d.nox_index, 0);
    setTile("t-temp", d.temperature_c, 1);
    setTile("t-hum", d.humidity_pct, 1);
    setTile("t-pressure", d.pressure_hpa, 1);

    setTile("d-rssi", d.wifi_rssi_db, 0);
    setTile("d-esptemp", d.esp_temperature_c, 1);
    const uptimeMin = typeof d.uptime_s === "number" ? d.uptime_s / 60 : null;
    setTile("d-uptime", uptimeMin, 1);
    const fw = document.getElementById("d-firmware");
    if (fw) fw.textContent = d.firmware_version || "—";

    setTile("g-no2", d.nitrogen_dioxide_ppm, 3);
    setTile("g-co", d.carbon_monoxide_ppm, 3);
    setTile("g-h2", d.hydrogen_ppm, 3);
    setTile("g-ethanol", d.ethanol_ppm, 3);
    setTile("g-methane", d.methane_ppm, 3);
    setTile("g-ammonia", d.ammonia_ppm, 3);

    setTile("s-co2", d.co2_ppm, 0);
    setTile("s-pm25", d.pm2_5_ugm3, 1);
    setTile("s-temp", d.temperature_c, 1);
    setTile("s-hum", d.humidity_pct, 1);
    setHero(d.aqi, d.co2_ppm);

    const updated = document.getElementById("updated");
    if (updated) updated.textContent = "Latest reading: " + new Date(d.time).toLocaleString();
  } catch (e) {
    const updated = document.getElementById("updated");
    if (updated) updated.textContent = "Unable to reach InfluxDB";
  }
}

async function loadHistory(hours) {
  const res = await fetch(`/api/history?hours=${hours}`);
  const points = res.ok ? await res.json() : [];

  renderLineChart(document.getElementById("chart-co2"), points, [
    { key: "co2_ppm", label: "CO2 (ppm)", color: "var(--series-1)" },
  ]);
  renderLineChart(document.getElementById("chart-pm"), points, [
    { key: "pm1_0_ugm3", label: "PM1.0", color: "var(--series-1)" },
    { key: "pm2_5_ugm3", label: "PM2.5", color: "var(--series-2)" },
    { key: "pm4_0_ugm3", label: "PM4.0", color: "var(--series-3)" },
    { key: "pm10_0_ugm3", label: "PM10", color: "var(--series-4)" },
  ]);
  renderLineChart(document.getElementById("chart-temp"), points, [
    { key: "temperature_c", label: "Temperature (°C)", color: "var(--series-1)" },
  ]);
  renderLineChart(document.getElementById("chart-hum"), points, [
    { key: "humidity_pct", label: "Humidity (%)", color: "var(--series-1)" },
  ]);
  renderLineChart(document.getElementById("chart-voc"), points, [
    { key: "voc_index", label: "VOC index", color: "var(--series-1)" },
    { key: "nox_index", label: "NOx index", color: "var(--series-2)" },
  ]);
}

function initRangeControls() {
  const buttons = document.querySelectorAll(".range-controls button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadHistory(Number(btn.dataset.hours));
    });
  });
}

function currentRangeHours() {
  const active = document.querySelector(".range-controls button.active");
  return active ? Number(active.dataset.hours) : 24;
}

function setView(view) {
  const simpleView = document.getElementById("simple-view");
  const advancedView = document.getElementById("advanced-view");
  const btnSimple = document.getElementById("btn-simple");
  const btnAdvanced = document.getElementById("btn-advanced");
  const isSimple = view !== "advanced";

  simpleView.style.display = isSimple ? "" : "none";
  advancedView.style.display = isSimple ? "none" : "";
  btnSimple.classList.toggle("active", isSimple);
  btnAdvanced.classList.toggle("active", !isSimple);
  localStorage.setItem("apollo-air1-view", isSimple ? "simple" : "advanced");

  // History/charts are only needed once someone actually opens Advanced —
  // skip the extra query and render for people who stay on Simple.
  if (!isSimple) loadHistory(currentRangeHours());
}

function initViewToggle() {
  document.getElementById("btn-simple").addEventListener("click", () => setView("simple"));
  document.getElementById("btn-advanced").addEventListener("click", () => setView("advanced"));
  const saved = localStorage.getItem("apollo-air1-view");
  setView(saved === "advanced" ? "advanced" : "simple");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is a nice-to-have; the app works fine without it.
    });
  }
}

initRangeControls();
initViewToggle();
registerServiceWorker();
loadLatest();
setInterval(loadLatest, 60000);
setInterval(() => { if (document.getElementById("advanced-view").style.display !== "none") loadHistory(currentRangeHours()); }, 60000);

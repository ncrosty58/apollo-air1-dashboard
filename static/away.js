(function () {
  "use strict";

  // escapeHtml / bandVar / seriesFor / pollInterval / toast helpers come from
  // common.js; bandFromAqi from aqi.js; renderRowChart from chart.js. Theme
  // toggle, settings panel, and clock self-init in common.js.

  const AWAY_PROVIDERS = [
    { id: "airnow", label: "AirNow" },
    { id: "google", label: "Google" },
    { id: "openweathermap", label: "OWM" },
    { id: "purpleair", label: "PurpleAir" },
  ];

  function toast(msg) {
    const stack = document.getElementById("toast-stack");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  let awayLoc = null; // { zip, lat, lon, reporting_area } or null
  let currentProvider = localStorage.getItem("apollo-air1-away-provider") || "google";
  let lastResult = null; // held so the readout/theme re-render doesn't refetch

  /* ---------- away location + provider switch ---------- */

  function renderProviders() {
    const wrap = document.getElementById("away-providers");
    if (!awayLoc) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = AWAY_PROVIDERS.map((p) =>
      `<button type="button" class="location-chip" data-provider="${p.id}" aria-pressed="${p.id === currentProvider}">${p.label}</button>`
    ).join("");
    wrap.querySelectorAll(".location-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentProvider = btn.getAttribute("data-provider");
        localStorage.setItem("apollo-air1-away-provider", currentProvider);
        renderProviders();
        loadHistory();
      });
    });
  }

  function renderStats(points) {
    const statsEl = document.getElementById("away-stats");
    const aqis = points.map((p) => p.aqi).filter((v) => typeof v === "number");
    if (!aqis.length) { statsEl.textContent = ""; return; }
    const now = aqis[aqis.length - 1];
    const avg = Math.round(aqis.reduce((a, b) => a + b, 0) / aqis.length);
    const peak = Math.max(...aqis);
    statsEl.innerHTML =
      `<span>Now <strong style="color:${bandVar(bandFromAqi(now))}">${now}</strong></span>` +
      `<span>7-day avg <strong>${avg}</strong></span>` +
      `<span>Peak <strong style="color:${bandVar(bandFromAqi(peak))}">${peak}</strong></span>`;
  }

  function renderChart(points) {
    const el = document.getElementById("away-chart");
    const pts = points
      .filter((p) => typeof p.aqi === "number")
      .map((p) => ({ t: new Date(p.time).getTime(), v: p.aqi }));
    renderRowChart(el, [{
      label: "AQI", unit: "", decimals: 0, points: pts, bandFor: bandFromAqi,
    }], { leftLabel: "7 days ago", label: "Away AQI history" });
  }

  function renderResult() {
    const noteEl = document.getElementById("away-note");
    if (!lastResult) return;
    const points = lastResult.points || [];
    renderStats(points);
    renderChart(points);
    // PurpleAir reports which sensor it resolved; the others don't.
    if (currentProvider === "purpleair") {
      const s = lastResult.sensor;
      noteEl.textContent = s
        ? `Nearest sensor: ${s.name || "#" + s.index} — ${s.distance_km} km away`
        : "No healthy PurpleAir sensor found near this location.";
    } else {
      noteEl.textContent = "";
    }
  }

  async function loadHistory() {
    const chartEl = document.getElementById("away-chart");
    const statsEl = document.getElementById("away-stats");
    const noteEl = document.getElementById("away-note");
    if (!awayLoc) {
      chartEl.innerHTML = '<div class="empty-state">Set an away location to see its last 7 days.</div>';
      statsEl.textContent = "";
      noteEl.textContent = "";
      return;
    }
    chartEl.innerHTML = '<div class="empty-state">Loading…</div>';
    statsEl.textContent = "";
    noteEl.textContent = "";
    try {
      const res = await fetch(`/api/away/history?provider=${currentProvider}&days=7`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "request failed");
      lastResult = d;
      renderResult();
      if (!(d.points || []).length) {
        chartEl.innerHTML = '<div class="empty-state">No data for this provider at this location.</div>';
      }
    } catch (e) {
      lastResult = null;
      chartEl.innerHTML = `<div class="empty-state">Couldn't load — ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAwayHeader() {
    const areaEl = document.getElementById("away-area");
    areaEl.textContent = awayLoc
      ? (awayLoc.reporting_area || awayLoc.zip || "Away")
      : "No away location set";
    renderProviders();
  }

  async function loadAway() {
    try {
      const res = await fetch("/api/away");
      awayLoc = res.ok ? await res.json() : null;
    } catch (e) {
      awayLoc = null;
    }
    if (awayLoc && awayLoc.lat == null) awayLoc = null; // stored but unresolved
    renderAwayHeader();
    loadHistory();
  }

  async function setAway(zip) {
    const res = await fetch("/api/away", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zip }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "request failed");
    awayLoc = d;
    renderAwayHeader();
    loadHistory();
  }

  document.getElementById("away-set-toggle").addEventListener("click", () => {
    const form = document.getElementById("away-form");
    form.hidden = !form.hidden;
    if (!form.hidden) document.getElementById("away-zip").focus();
  });
  document.getElementById("away-cancel").addEventListener("click", () => {
    document.getElementById("away-form").hidden = true;
  });
  document.getElementById("away-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const zip = document.getElementById("away-zip").value;
    try {
      await setAway(zip);
      document.getElementById("away-form").hidden = true;
      document.getElementById("away-zip").value = "";
      toast("Away location set");
    } catch (err) {
      toast("Couldn't set that — " + err.message);
    }
  });
  document.getElementById("away-refresh").addEventListener("click", async () => {
    if (!awayLoc) return;
    const btn = document.getElementById("away-refresh");
    btn.disabled = true; btn.textContent = "…";
    try {
      const res = await fetch(`/api/away/history?provider=${currentProvider}&days=7&refresh=1`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "request failed");
      lastResult = d;
      renderResult();
      toast("Refreshed");
    } catch (err) {
      toast("Couldn't refresh — " + err.message);
    }
    btn.disabled = false; btn.textContent = "Refresh";
  });

  /* ---------- home location editor ---------- */

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

  document.getElementById("home-edit-toggle").addEventListener("click", () => {
    const form = document.getElementById("home-form");
    form.hidden = !form.hidden;
    document.getElementById("home-preview").hidden = true;
  });
  document.getElementById("home-cancel").addEventListener("click", () => {
    document.getElementById("home-form").hidden = true;
    document.getElementById("home-preview").hidden = true;
  });

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
      document.getElementById("home-form").hidden = true;
      document.getElementById("home-preview").hidden = true;
      document.getElementById("home-zip").value = "";
      document.getElementById("home-label").value = "";
      toast(d.published ? "Home updated" : "Home saved (Node-RED will pick it up when the broker reconnects)");
    } catch (err) {
      toast("Couldn't save — " + err.message);
    }
  });

  // Theme change repaints band colors; re-render the held result without refetch.
  document.addEventListener("readoutchange", renderResult);

  loadAway();
  loadHome();
  // Away history is cached server-side (1h TTL); a gentle refresh keeps a
  // left-open tab from going stale without hammering the upstream APIs.
  pollInterval(loadHistory, 30 * 60000);
})();

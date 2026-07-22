// Shared browser helpers + self-initializing page chrome, loaded after aqi.js
// and before each page's own script (index/forecast/technical/indoor). Its
// top-level functions/consts are visible inside those scripts' IIFEs, the same
// way aqi.js's are. This is the single home for the formatting/band helpers and
// the theme/settings/clock UI that every page used to copy-paste verbatim.
//
// Deliberately NOT here: the temperature-unit toggle. Its click handler reloads
// different things on each page (loadLatest vs loadHistory vs the outside
// overlay) and renderUnitToggle updates page-specific elements, so that stays
// local to each page rather than forcing shared mutable unit state.

/* ---------- formatting ---------- */
function fmt(value, decimals) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(decimals);
}

// Accepts either an ISO timestamp string or epoch seconds (the MQTT seen_at
// values are epoch seconds; Influx times are ISO).
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A band name -> the CSS custom property the .rr-value / --band-color rules
// already read; null bands fall back to the neutral dim ink.
function bandVar(band) {
  return band ? `var(--${band})` : "var(--ink-dim)";
}

// Google's own enum value, abbreviated to the unit symbol everyone reads at a
// glance. Falls back to a de-underscored lowercase form for anything unmapped.
function formatConcentrationUnits(units) {
  const short = { PARTS_PER_BILLION: "ppb", MICROGRAMS_PER_CUBIC_METER: "µg/m³" };
  return short[units] || (units || "").replace(/_/g, " ").toLowerCase();
}

/* ---------- non-AQI bands (AQI bands live in aqi.js) ---------- */
function bandFromCo2(co2) {
  if (co2 === undefined || co2 === null || Number.isNaN(co2)) return null;
  if (co2 > 2000) return "bad";
  if (co2 > 1500) return "poor";
  if (co2 > 1000) return "fair";
  return "good";
}

// No official health thresholds exist for Sensirion's VOC index the way the EPA
// publishes them for AQI/CO2 -- these two cutoffs match the readout tile edge.
function bandForVocIndex(v) {
  if (typeof v !== "number") return null;
  return v > 250 ? "bad" : v > 150 ? "poor" : null;
}

/* ---------- provider identity (kept in one place so the pages and the
 * server's api_forecast set can't silently drift) ---------- */
const PROVIDER_NAMES = { airnow: "AirNow", google: "Google", purpleair: "PurpleAir", openweathermap: "OWM" };
const PROVIDER_ORDER = ["airnow", "google", "purpleair", "openweathermap"];
// PurpleAir is the only provider with no forecast: one real-time sensor, no
// forward-looking model. Its Forecast link would hand back a *different*
// provider's forecast, so it's hidden. Any provider not handled by the server's
// api_forecast belongs in this set.
const PROVIDERS_WITHOUT_FORECAST = new Set(["purpleair"]);

/* ---------- chart series helper ---------- */
// Turn flat history points into {t, v} series, dropping points that don't carry
// a numeric value for `key`. Plotting by real timestamp (not array index) lets
// sources sampled at different rates overlay correctly.
function seriesFor(points, key, color, area) {
  return {
    color,
    area: !!area,
    points: points
      .filter((p) => typeof p[key] === "number")
      .map((p) => ({ t: new Date(p.time).getTime(), v: p[key] })),
  };
}

/* ---------- theme toggle (self-initializing on every page) ---------- */
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

/* ---------- readout mode: AQI numbers vs engineering units ----------
 * Dashboard, Forecast, and Technical all carry this toggle and default to
 * "aqi" -- this app is for non-technical people, so every pollutant reads on
 * the one comparable 0-500 scale (and drops anything with no AQI, e.g. NH3)
 * unless someone opts into "units" for the underlying concentrations. Indoor
 * has no outside pollutants, so it doesn't show the toggle. Lives here (not
 * per-page like the temperature toggle) because every page that has it reads/
 * renders it identically; each page just re-renders its own pollutant views
 * on the readoutchange event below. */
function readoutMode() {
  return localStorage.getItem("apollo-air1-readout") || "aqi";
}
function renderReadoutToggle() {
  document.querySelectorAll(".readout-toggle button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.getAttribute("data-readout") === readoutMode()));
  });
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".readout-toggle button");
  if (!btn) return;
  localStorage.setItem("apollo-air1-readout", btn.getAttribute("data-readout"));
  renderReadoutToggle();
  document.dispatchEvent(new CustomEvent("readoutchange"));
});

/* ---------- settings panel (self-initializing on every page) ----------
 * openSettingsPanel is exposed on window so the mode-rail (below) can pop it
 * open when Away is tapped with no location saved yet. */
(function initSettingsPanel() {
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  if (!settingsToggle || !settingsPanel || !settingsBackdrop) return;

  function positionSettingsPanel() {
    // Below 560px the panel is a fixed bottom sheet (CSS handles placement) --
    // clear any inline position so that isn't fought.
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
  window.openSettingsPanel = openSettings;
})();

/* ---------- location mode: Home / Away (self-initializing on every page) ----------
 * A third piece of shared, per-browser client state alongside theme/readout --
 * which location the whole app (dashboard, Technical, Forecast) currently
 * shows. Persisted so a wall display and a phone can independently sit in
 * different modes. The provider choice itself (apollo-air1-provider, see
 * dashboard.js) is deliberately *not* split per mode -- it used to be, but a
 * provider silently changing underneath you when you flip modes turned out
 * to be more confusing than useful. */
function currentMode() {
  return localStorage.getItem("apollo-air1-mode") || "home";
}

// undefined = not fetched yet; null = fetched, no away location saved.
let _awayLoc;

async function fetchAwayLoc(force) {
  if (_awayLoc !== undefined && !force) return _awayLoc;
  try {
    const res = await fetch("/api/away");
    _awayLoc = res.ok ? await res.json() : null;
  } catch (e) {
    _awayLoc = null;
  }
  if (_awayLoc && _awayLoc.lat == null) _awayLoc = null; // stored but unresolved
  return _awayLoc;
}

// Synchronous read of the last fetch -- callers that just need "is there one
// / what's its zip" (e.g. building a Forecast link) use this; callers driving
// the mode-rail/settings row itself await fetchAwayLoc() directly.
function getAwayLoc() {
  return _awayLoc === undefined ? null : _awayLoc;
}

function renderModeRail() {
  const mode = currentMode();
  document.querySelectorAll(".mode-rail button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.getAttribute("data-mode") === mode));
  });
}

function setMode(mode) {
  localStorage.setItem("apollo-air1-mode", mode);
  renderModeRail();
  document.dispatchEvent(new CustomEvent("modechange", { detail: { mode } }));
}

function renderAwayLocationRow() {
  const el = document.getElementById("away-location-current");
  if (!el) return;
  const loc = getAwayLoc();
  el.textContent = loc ? (loc.reporting_area || loc.zip) : "Not set — pick a ZIP below";
}

/* ---------- tab bar's Forecast link ---------- */
// One shared handler for every page's bottom tab bar: in Away mode the tab
// points at the away location's forecast, and it hides entirely for
// providers that publish no forecast (PurpleAir). Pages that can change the
// inputs (dashboard's provider chips, the mode rail) call this again on top
// of the init below.
function updateForecastLink() {
  const link = document.getElementById("forecast-link");
  if (!link) return;
  link.hidden = PROVIDERS_WITHOUT_FORECAST.has(localStorage.getItem("apollo-air1-provider") || "airnow");
  const awayLoc = currentMode() === "away" ? getAwayLoc() : null;
  link.href = awayLoc ? `/forecast?zip=${encodeURIComponent(awayLoc.zip)}` : "/forecast";
}
(function initForecastLink() {
  updateForecastLink();
  fetchAwayLoc().then(updateForecastLink);
  document.addEventListener("modechange", updateForecastLink);
})();

(function initModeRail() {
  if (!document.querySelector(".mode-rail")) return;

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".mode-rail button");
    if (!btn) return;
    const mode = btn.getAttribute("data-mode");
    if (mode === "away" && !(await fetchAwayLoc())) {
      // Nothing to flip to yet -- open the settings panel's Away location
      // row instead of switching to an empty view.
      if (window.openSettingsPanel) window.openSettingsPanel();
      return;
    }
    setMode(mode);
  });

  const form = document.getElementById("away-location-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("away-location-zip");
      const zip = input.value;
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        const res = await fetch("/api/away", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zip }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || "request failed");
        _awayLoc = d;
        renderAwayLocationRow();
        input.value = "";
        // Away is now configured -- if the rail is already sitting on Away
        // (e.g. editing to change it), refresh the app for the new location.
        if (currentMode() === "away") setMode("away");
      } catch (err) {
        // The settings panel has no toast stack on every page -- a plain
        // alert-free inline message would need its own element; keeping this
        // minimal for now matches the panel's other rows (no error states).
        document.getElementById("away-location-current").textContent = "Couldn't save that ZIP";
      }
      btn.disabled = false;
    });
  }

  fetchAwayLoc().then(renderAwayLocationRow);
  renderModeRail();
})();

/* ---------- footer clock (self-initializing on every page) ---------- */
(function initClock() {
  const el = document.getElementById("footer-clock");
  if (!el) return;
  function tick() {
    el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tick();
  setInterval(tick, 1000);
})();

/* ---------- visibility-aware polling ----------
 * Like setInterval(fn, ms) but skips ticks while the tab is hidden (a
 * backgrounded phone/wall display shouldn't keep hammering the API), and fires
 * fn once immediately when the tab becomes visible again so stale data is
 * refreshed on return. Callers still do their own initial load at init. */
function pollInterval(fn, ms) {
  setInterval(() => { if (!document.hidden) fn(); }, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) fn(); });
}

/* ---------- service worker (installability is a nice-to-have) ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Every page calls this in its own init too, but do it here so the toggle
// reflects the saved theme even before the page script runs.
renderThemeToggle();
// Reflect the saved readout choice on the pages that show the toggle.
renderReadoutToggle();

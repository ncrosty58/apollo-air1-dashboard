(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function bandVar(band) {
    return band ? `var(--${band})` : "var(--ink-dim)";
  }

  function dayLabel(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }

  function toast(msg) {
    const stack = document.getElementById("toast-stack");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  let currentProvider = localStorage.getItem("apollo-air1-provider") || "airnow";

  function renderProviderToggles() {
    document.querySelectorAll(".provider-toggle").forEach((wrap) => {
      wrap.querySelectorAll("button").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-provider") === currentProvider));
      });
    });
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-toggle button");
    if (!btn) return;
    currentProvider = btn.getAttribute("data-provider");
    localStorage.setItem("apollo-air1-provider", currentProvider);
    renderProviderToggles();
    loadForecast();
  });

  let savedLocations = [];
  let selectedZip = null; // null = home (AIRNOW_ZIP)

  async function loadLocations() {
    try {
      const res = await fetch("/api/locations");
      savedLocations = res.ok ? await res.json() : [];
    } catch (e) {
      savedLocations = [];
    }
    renderLocationSwitch();
  }

  function renderLocationSwitch() {
    const wrap = document.getElementById("location-switch");
    const homeBtn = `<button type="button" class="location-chip" data-zip="" aria-pressed="${selectedZip === null}">Home</button>`;
    const chips = savedLocations.map((loc) => `
      <span class="location-chip-wrap">
        <button type="button" class="location-chip" data-zip="${loc.zip}" aria-pressed="${selectedZip === loc.zip}">${escapeHtml(loc.label)}</button>
        <button type="button" class="location-chip-remove" data-zip="${loc.zip}" aria-label="Remove ${escapeHtml(loc.label)}">×</button>
      </span>`).join("");
    const addBtn = `<button type="button" class="location-chip location-chip-add" id="add-location-toggle">+ Add</button>`;
    wrap.innerHTML = homeBtn + chips + addBtn;

    wrap.querySelectorAll(".location-chip[data-zip]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedZip = btn.getAttribute("data-zip") || null;
        renderLocationSwitch();
        loadForecast();
      });
    });
    wrap.querySelectorAll(".location-chip-remove").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const zip = btn.getAttribute("data-zip");
        try {
          const res = await fetch(`/api/locations/${zip}`, { method: "DELETE" });
          const result = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(result.error || "request failed");
          savedLocations = result;
          if (selectedZip === zip) {
            selectedZip = null;
            loadForecast();
          }
          renderLocationSwitch();
          toast("Removed");
        } catch (err) {
          toast("Couldn't remove that — " + err.message);
        }
      });
    });
    document.getElementById("add-location-toggle").addEventListener("click", () => {
      document.getElementById("add-location-form").hidden = false;
    });
  }

  async function loadForecast() {
    const daysEl = document.getElementById("forecast-days");
    const areaEl = document.getElementById("forecast-area");
    const discussionWrap = document.getElementById("forecast-discussion");
    const discussionText = document.getElementById("discussion-text");
    const discussionToggle = document.getElementById("discussion-toggle");

    const zipParam = selectedZip ? `zip=${encodeURIComponent(selectedZip)}&` : "";
    const url = `/api/forecast?${zipParam}provider=${currentProvider}`;
    try {
      const res = await fetch(url);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "request failed");

      areaEl.textContent = d.reporting_area || "—";
      daysEl.innerHTML = (d.days && d.days.length ? d.days.map((day) => {
        const aqiText = day.aqi != null ? `AQI ${day.aqi}` : "AQI —";
        return `<div class="forecast-day">
          <div class="fd-label">${dayLabel(day.date)}</div>
          <div class="fd-badge" style="--band-color: ${bandVar(day.band)}">${escapeHtml(day.category)}</div>
          <div class="fd-aqi">${aqiText}</div>
          <div class="fd-pollutant">${escapeHtml(day.dominant_pollutant)}</div>
        </div>`;
      }).join("") : '<div class="empty-state">No forecast published for this location right now.</div>');

      if (d.discussion) {
        discussionWrap.hidden = false;
        discussionText.textContent = d.discussion;
        discussionToggle.setAttribute("aria-expanded", "false");
        discussionText.hidden = true;
      } else {
        discussionWrap.hidden = true;
      }
    } catch (e) {
      const providerName = currentProvider === "google" ? "Google Air Quality" : "AirNow";
      areaEl.textContent = "—";
      daysEl.innerHTML = `<div class="empty-state">Couldn't reach ${providerName} — ${escapeHtml(e.message)}</div>`;
      discussionWrap.hidden = true;
    }
  }

  document.getElementById("discussion-toggle").addEventListener("click", () => {
    const btn = document.getElementById("discussion-toggle");
    const p = document.getElementById("discussion-text");
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    p.hidden = expanded;
  });

  document.getElementById("add-location-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = document.getElementById("new-location-label").value;
    const zip = document.getElementById("new-location-zip").value;
    try {
      const res = await fetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, zip }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "request failed");
      savedLocations = result;
      document.getElementById("new-location-label").value = "";
      document.getElementById("new-location-zip").value = "";
      document.getElementById("add-location-form").hidden = true;
      renderLocationSwitch();
      toast("Saved");
    } catch (err) {
      toast("Couldn't save that — " + err.message);
    }
  });
  document.getElementById("cancel-location-btn").addEventListener("click", () => {
    document.getElementById("add-location-form").hidden = true;
  });

  function tickClock() {
    document.getElementById("footer-clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000);

  renderProviderToggles();
  loadLocations();
  loadForecast();
  setInterval(loadForecast, 15 * 60000);
})();

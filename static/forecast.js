(function () {
  "use strict";

  // escapeHtml / bandVar / formatConcentrationUnits come from common.js;
  // bandFromAqi / aqiFromConcentration / bandForConcentration from aqi.js (both
  // loaded first). Theme toggle, settings panel, and clock self-init in
  // common.js.

  // AirNow's category names collapse onto the same 4-band scale as its AQI
  // numbers -- useful for the rows where AQI is -1 (not computed) and
  // category text is all that's available.
  const CATEGORY_TO_BAND = {
    "Good": "good",
    "Moderate": "fair",
    "Unhealthy for Sensitive Groups": "poor",
    "Unhealthy": "bad",
    "Very Unhealthy": "bad",
    "Hazardous": "bad",
  };

  function pollutantsHtml(pollutants) {
    // AirNow sometimes doesn't compute a per-pollutant AQI for forecast rows
    // (AQI: -1, common during an active alert, like the "Air Quality Alert"
    // discussion text that comes with it) -- it still gives a category
    // ("Moderate", "Unhealthy for Sensitive Groups") for that pollutant, so
    // fall back to that instead of a bare dash.
    return (pollutants || []).map((p) => {
      let valueHtml;
      let band;
      if (typeof p.aqi === "number") {
        valueHtml = String(p.aqi);
        band = bandFromAqi(p.aqi);
      } else if (typeof p.concentration_value === "number") {
        valueHtml = `${p.concentration_value} ${formatConcentrationUnits(p.concentration_units)}`;
        band = bandForConcentration(p.parameter, p.concentration_value, p.concentration_units);
      } else {
        valueHtml = escapeHtml(p.category || "—");
        band = CATEGORY_TO_BAND[p.category] || null;
      }
      const colorStyle = band ? ` style="color: ${bandVar(band)}"` : "";
      return `<span class="fd-pollutant-item"><span class="fp-label">${escapeHtml(p.parameter)}</span><span class="fp-value"${colorStyle}>${valueHtml}</span></span>`;
    }).join("");
  }

  // Google's per-population-group guidance -- more specific than AirNow's
  // one paragraph for everyone. General population and children always
  // show (kids react differently to air quality, and it's the group most
  // likely to matter for this household); everyone else (elderly, lung
  // disease, heart disease, athletes, pregnant) sits behind a toggle.
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

  const PROVIDER_LABELS = { google: "Google Air Quality", openweathermap: "OpenWeatherMap", airnow: "AirNow" };
  function providerLabel(provider) {
    return PROVIDER_LABELS[provider || currentProvider] || "AirNow";
  }

  function renderProviderToggles() {
    document.querySelectorAll(".provider-toggle").forEach((wrap) => {
      wrap.querySelectorAll("button").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-provider") === currentProvider));
      });
    });
    document.getElementById("forecast-source").textContent = `via ${providerLabel()}`;
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

  async function loadForecast(force) {
    const daysEl = document.getElementById("forecast-days");
    const areaEl = document.getElementById("forecast-area");
    const sourceEl = document.getElementById("forecast-source");
    const discussionWrap = document.getElementById("forecast-discussion");
    const discussionText = document.getElementById("discussion-text");
    const discussionToggle = document.getElementById("discussion-toggle");

    const zipParam = selectedZip ? `zip=${encodeURIComponent(selectedZip)}&` : "";
    const refreshParam = force ? "&refresh=1" : "";
    const url = `/api/forecast?${zipParam}provider=${currentProvider}${refreshParam}`;
    try {
      const res = await fetch(url);
      let d;
      try {
        d = await res.json();
      } catch (parseErr) {
        // A non-JSON body (a proxy/timeout error page, e.g.) would otherwise
        // surface as a raw "Unexpected token '<'..." parser error.
        throw new Error(`unexpected response (${res.status})`);
      }
      if (!res.ok) throw new Error(d.error || "request failed");

      // The response's own "provider" field is the source of truth for what
      // actually served this data (not just currentProvider, which could
      // theoretically be stale across tabs) -- always show which agency/
      // model the forecast on screen came from, same principle as the main
      // dashboard's provider chips.
      sourceEl.textContent = `via ${providerLabel(d.provider)}`;
      areaEl.textContent = d.reporting_area || "—";
      daysEl.innerHTML = (d.days && d.days.length ? d.days.map((day) => {
        const aqiText = day.aqi != null ? `AQI ${day.aqi}` : "AQI —";
        const hasPollutantsList = day.pollutants && day.pollutants.length;
        const pollutantsBlock = hasPollutantsList
          ? `<div class="fd-pollutants">${pollutantsHtml(day.pollutants)}</div>`
          : `<div class="fd-pollutant">${escapeHtml(day.dominant_pollutant)}</div>`;
        // Only add a separate "driven by" line when the full breakdown is
        // also shown below -- otherwise it'd just repeat the fallback text.
        const dominantHtml = hasPollutantsList && day.dominant_pollutant
          ? `<div class="fd-dominant">Driven by ${escapeHtml(day.dominant_pollutant)}</div>`
          : "";
        const actionBadge = day.action_day ? '<div class="fd-action-badge">Action Day</div>' : "";
        return `<div class="forecast-day">
          <div class="fd-label">${dayLabel(day.date)}</div>
          ${actionBadge}
          <div class="fd-badge" style="--band-color: ${bandVar(day.band)}">${escapeHtml(day.category)}</div>
          <div class="fd-aqi">${aqiText}</div>
          ${dominantHtml}
          ${pollutantsBlock}
          ${healthRecommendationsHtml(day.health_recommendations)}
        </div>`;
      }).join("") : '<div class="empty-state">No forecast for this location.</div>');

      if (d.discussion) {
        discussionWrap.hidden = false;
        discussionText.textContent = d.discussion;
        discussionToggle.setAttribute("aria-expanded", "false");
        discussionText.hidden = true;
      } else {
        discussionWrap.hidden = true;
      }
    } catch (e) {
      sourceEl.textContent = `via ${providerLabel()}`;
      areaEl.textContent = "—";
      daysEl.innerHTML = `<div class="empty-state">Couldn't reach ${providerLabel()} — ${escapeHtml(e.message)}</div>`;
      discussionWrap.hidden = true;
    }
  }

  document.getElementById("forecast-refresh").addEventListener("click", async () => {
    const btn = document.getElementById("forecast-refresh");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    await loadForecast(true);
    btn.disabled = false;
    btn.textContent = "Refresh";
    toast("Forecast refreshed");
  });

  document.getElementById("discussion-toggle").addEventListener("click", () => {
    const btn = document.getElementById("discussion-toggle");
    const p = document.getElementById("discussion-text");
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    p.hidden = expanded;
  });

  // Day cards are rebuilt on every loadForecast(), so this is delegated
  // rather than bound to specific elements that won't exist yet.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".health-guidance-toggle");
    if (!btn) return;
    const groups = btn.nextElementSibling;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    groups.hidden = expanded;
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
      const result = await res.json().catch(() => ({}));
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

  renderProviderToggles();
  loadLocations();
  loadForecast();
  pollInterval(loadForecast, 15 * 60000);
})();

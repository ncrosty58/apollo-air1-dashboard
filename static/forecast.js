(function () {
  "use strict";

  // escapeHtml / bandVar / formatConcentrationUnits / readoutMode come from
  // common.js; bandFromAqi / aqiFromConcentration / bandForConcentration from
  // aqi.js (both loaded first). Theme toggle, readout toggle, settings panel,
  // and clock self-init in common.js.

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

  function pollutantItemHtml(parameter, valueHtml, band) {
    const colorStyle = band ? ` style="color: ${bandVar(band)}"` : "";
    return `<span class="fd-pollutant-item"><span class="fp-label">${escapeHtml(parameter)}</span><span class="fp-value"${colorStyle}>${valueHtml}</span></span>`;
  }

  function pollutantsHtml(pollutants) {
    const units = readoutMode() === "units";
    return (pollutants || []).map((p) => {
      if (units) {
        // Engineering read: the provider's own AQI if it has one, else the raw
        // concentration, else the category text. AirNow sometimes doesn't
        // compute a per-pollutant AQI for forecast rows (AQI: -1, common during
        // an active alert) but still gives a category -- fall back to that
        // rather than a bare dash.
        if (typeof p.aqi === "number") return pollutantItemHtml(p.parameter, String(p.aqi), bandFromAqi(p.aqi));
        if (typeof p.concentration_value === "number") {
          return pollutantItemHtml(p.parameter,
            `${p.concentration_value} ${formatConcentrationUnits(p.concentration_units)}`,
            bandForConcentration(p.parameter, p.concentration_value, p.concentration_units));
        }
        return pollutantItemHtml(p.parameter, escapeHtml(p.category || "—"), CATEGORY_TO_BAND[p.category] || null);
      }
      // AQI read (the default): normalize every pollutant onto the 0-500 scale,
      // computing it from the concentration when the provider gave only that
      // (Google/OWM forecasts). Anything that can't be converted -- NH3 (no EPA
      // breakpoint), or an alert row with neither an AQI nor a concentration --
      // is hidden, so the family view stays to the one comparable number.
      const aqi = typeof p.aqi === "number" ? p.aqi
        : (typeof p.concentration_value === "number" ? aqiFromConcentration(p.parameter, p.concentration_value, p.concentration_units) : null);
      return typeof aqi === "number" ? pollutantItemHtml(p.parameter, String(aqi), bandFromAqi(aqi)) : null;
    }).filter(Boolean).join("");
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

  // The active provider is chosen on the dashboard (the AQI chips) and shared
  // via localStorage; the Forecast page just follows it and shows which agency
  // served the data (forecast-source), rather than carrying its own switcher.
  // Home and Away each remember their own provider choice under separate keys
  // (see dashboard.js/technical.js) so this has to read whichever one matches
  // the current mode, not always the Home key.
  function providerStorageKey() {
    return currentMode() === "away" ? "apollo-air1-away-provider" : "apollo-air1-provider";
  }
  function defaultProvider() {
    return currentMode() === "away" ? "google" : "airnow";
  }
  let currentProvider = localStorage.getItem(providerStorageKey()) || defaultProvider();

  const PROVIDER_LABELS = { google: "Google Air Quality", openweathermap: "OpenWeatherMap", airnow: "AirNow" };
  function providerLabel(provider) {
    return PROVIDER_LABELS[provider || currentProvider] || "AirNow";
  }

  // null = home; a zip when Away is active. Driven entirely by the header's
  // Home/Away rail -- Forecast has no location picker of its own (currentMode/
  // getAwayLoc/fetchAwayLoc come from common.js).
  let selectedZip = null;

  async function applyMode() {
    currentProvider = localStorage.getItem(providerStorageKey()) || defaultProvider();
    const awayLoc = currentMode() === "away" ? await fetchAwayLoc() : null;
    selectedZip = awayLoc ? awayLoc.zip : null;
  }

  // Held so the AQI/Units readout toggle re-renders the day cards in place,
  // without a refetch (which for forecasts could hit the upstream API).
  let lastForecast = null;

  function renderForecastDays(d) {
    const daysEl = document.getElementById("forecast-days");
    if (!d.days || !d.days.length) {
      daysEl.innerHTML = '<div class="empty-state">No forecast for this location.</div>';
      return;
    }
    daysEl.innerHTML = d.days.map((day) => {
      // The day headline is always the AQI number (there's no single
      // concentration for a whole day); the readout toggle only affects the
      // per-pollutant breakdown below.
      const aqiText = day.aqi != null ? `AQI ${day.aqi}` : "AQI —";
      // Render the breakdown first: in AQI mode it can come back empty (every
      // pollutant filtered out as non-convertible), in which case fall back to
      // just naming the dominant pollutant.
      const pollutantsInner = pollutantsHtml(day.pollutants);
      const pollutantsBlock = pollutantsInner
        ? `<div class="fd-pollutants">${pollutantsInner}</div>`
        : `<div class="fd-pollutant">${escapeHtml(day.dominant_pollutant || "—")}</div>`;
      // Only add a separate "driven by" line when the full breakdown is also
      // shown -- otherwise it'd just repeat the fallback text above.
      const dominantHtml = pollutantsInner && day.dominant_pollutant
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
    }).join("");
  }

  // Re-render the day cards when AQI/Units is toggled (common.js persists it
  // and fires this); no refetch needed.
  document.addEventListener("readoutchange", () => {
    if (lastForecast) renderForecastDays(lastForecast);
  });

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
      lastForecast = d;
      renderForecastDays(d);

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

  // The header's Home/Away rail (common.js) jumps this page to the other
  // location too, same as the dashboard and Technical.
  document.addEventListener("modechange", async () => {
    await applyMode();
    loadForecast();
  });

  document.getElementById("forecast-source").textContent = `via ${providerLabel()}`;
  applyMode().then(loadForecast);
  pollInterval(loadForecast, 15 * 60000);
})();

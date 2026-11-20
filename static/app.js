/* Shobots Pool client */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    mode: "pool",
    bodies: { pool: { temp: null, setpoint: 84, heating: false }, spa: { temp: null, setpoint: 102, heating: false } },
    pumps: { main: { on: false, rpm: 2200 }, features: { on: false, rpm: 2800 } },
    deck_jets: {},
    firebaskets: {},
    blower: { on: false },
    lights: {},
    heater: { on: false, setpoint: 84 },
    chemistry: { salt: 3200 },
    schedule: { enabled: true, runs: [] }
  };
  var config = null;
  var scheduleDraft = null;
  var scheduleKey = null;
  var scheduleDirty = false;
  var talkTimer = null;
  var lastAiAt = 0;
  var recorder = null;
  var recChunks = [];
  var recStream = null;
  var polling = null;
  var assistantCfg = {};
  var localAudio = null;
  var lastAssistantAt = 0;
  var audioPlayer = null;
  var voiceList = [];
  var cameraStream = null;
  var localCameraStatus = null;

  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  var DEFAULT_EFFECTS = {
    SAMMOD: "SAm", PARTY: "Party Mode", CARIB: "Caribbean", SSET: "Sunset",
    ROMAN: "Romance", AMERCA: "American", ROYAL: "Royal", WHITER: "White",
    REDR: "Red", BLUER: "Blue", GREENR: "Green", MAGNTAR: "Magenta"
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(message, kind) {
    var el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast show " + (kind || "");
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.className = "toast " + (kind || ""); }, 4200);
  }

  async function api(path, options) {
    var opts = options || {};
    var response = await fetch(path, opts);
    var text = await response.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = { error: text }; }
    if (response.status === 401 && data && data.login_required) {
      applyAuth({ configured: authState.configured, logged_in: false });
      openLogin();
    }
    if (!response.ok) {
      throw new Error((data && (data.error || data.message)) || ("HTTP " + response.status));
    }
    return data;
  }

  // ------------------------------------------------------------------
  // Login: status is public; the camera and every control need a login.
  // ------------------------------------------------------------------
  var authState = { configured: true, logged_in: false, username: null, role: null };

  // Guests can control the pool; only the admin account sees the camera.
  function canSeeCamera() {
    return !!authState.logged_in && authState.role === "admin";
  }

  function applyAuth(next) {
    var was = canSeeCamera();
    authState = Object.assign({}, authState, next || {});
    if (!authState.logged_in) authState.role = null;
    document.body.classList.toggle("logged-out", !authState.logged_in);
    document.body.classList.toggle("no-camera", !!authState.logged_in && !canSeeCamera());
    document.querySelectorAll(".camera-lock-text").forEach(function (el) {
      el.textContent = authState.logged_in
        ? "\uD83D\uDD12 Live video is available to the admin account only"
        : "\uD83D\uDD12 Log in as admin to view the camera";
    });
    var btn = $("authBtn");
    if (btn) {
      btn.textContent = authState.logged_in
        ? "Log out" + (authState.username ? " (" + authState.username + ")" : "")
        : "Log in";
      btn.classList.toggle("logged-in", !!authState.logged_in);
    }
    if (!canSeeCamera()) {
      ["poolLiveVideo", "localCameraPreview", "liveVideo"].forEach(function (id) {
        var img = $(id);
        if (img) img.removeAttribute("src");
      });
      if ($("camStatusText")) $("camStatusText").textContent = "LOCKED";
    } else if (!was) {
      if ($("camStatusText")) $("camStatusText").textContent = "CONNECTING";
      refreshLocalSnapshot();
    }
    updateLiveVideo();
  }

  async function checkAuth() {
    try {
      applyAuth(await api("/api/auth"));
    } catch (e) {
      applyAuth({ logged_in: false });
    }
  }

  function openLogin() {
    var modal = $("loginModal");
    if (!modal || modal.style.display === "grid") return;
    $("loginError").textContent = authState.configured ? ""
      : "No login is set up yet. On the Pi, run: .venv/bin/python auth.py";
    modal.style.display = "grid";
    setTimeout(function () { if ($("loginUser")) $("loginUser").focus(); }, 30);
  }

  function closeLogin() {
    if ($("loginModal")) $("loginModal").style.display = "none";
    if ($("loginPass")) $("loginPass").value = "";
  }

  function bindAuth() {
    $("authBtn").addEventListener("click", async function () {
      if (!authState.logged_in) { openLogin(); return; }
      try { await api("/api/logout", { method: "POST" }); } catch (e) {}
      applyAuth({ logged_in: false, username: null, role: null });
      toast("Logged out", "good");
    });
    $("closeLoginModal").addEventListener("click", closeLogin);
    $("cancelLogin").addEventListener("click", closeLogin);
    $("loginForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      $("loginError").textContent = "";
      try {
        var res = await api("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: $("loginUser").value, password: $("loginPass").value })
        });
        closeLogin();
        applyAuth({ configured: true, logged_in: true, username: res.username, role: res.role });
        toast("Logged in", "good");
      } catch (err) {
        $("loginError").textContent = err.message;
      }
    });
  }

  function askBurnerPassword() {
    return new Promise(function (resolve) {
      var modal = $("burnerPasswordModal");
      var input = $("burnerPasswordInput");
      if (!modal || !input) { resolve(window.prompt("Burner password") || null); return; }
      input.value = "";
      modal.style.display = "grid";
      setTimeout(function () { input.focus(); }, 30);
      function done(value) {
        modal.style.display = "none";
        $("burnerPasswordForm").onsubmit = null;
        $("burnerPasswordCancel").onclick = null;
        $("burnerPasswordCancelX").onclick = null;
        resolve(value);
      }
      $("burnerPasswordForm").onsubmit = function (e) { e.preventDefault(); done(input.value || null); };
      $("burnerPasswordCancel").onclick = function () { done(null); };
      $("burnerPasswordCancelX").onclick = function () { done(null); };
    });
  }

  async function command(action, payload) {
    try {
      var result = await api("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action, payload: payload || {} })
      });
      if (result && result.password_required && !(payload && payload.password)) {
        if (result.state) { state = result.state; render(); }
        if (result.ok) toast(result.message, "good");
        var password = await askBurnerPassword();
        if (!password) return result;
        // "All on" already started everything else; just light the burners.
        if (action === "set_all_features") {
          return command("set_firebasket", { id: "east", on: true, password: password });
        }
        return command(action, Object.assign({}, payload, { password: password }));
      }
      if (result && result.state) {
        state = result.state;
        render();
      } else {
        await refresh();
      }
      if (result && result.message) {
        toast(result.message, result.ok ? "good" : "error");
      }
      return result;
    } catch (err) {
      toast("Command failed: " + err.message, "error");
      return null;
    }
  }

  async function refresh() {
    try {
      var next = await api("/api/state");
      state = next;
      render();
      var badge = $("statusBadge");
      if (badge) badge.classList.remove("offline");
    } catch (err) {
      var badge = $("statusBadge");
      if (badge) { badge.classList.add("offline"); badge.classList.remove("online", "simulation"); }
      $("statusText").textContent = "OFFLINE";
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render() {
    if (!state) return;
    var mode = state.mode || "pool";
    var conn = state.connection || {};
    var isOnline = !!conn.connected;
    var badge = $("statusBadge");
    var statusText = $("statusText");
    if (badge) {
      badge.classList.remove("online", "offline", "simulation");
      badge.classList.add(isOnline ? "online" : "simulation");
    }
    if (statusText) {
      statusText.textContent = isOnline ? "PANEL ONLINE" : "SIMULATION MODE";
      statusText.title = conn.last_error || (isOnline ? "IntelliCenter connected & responding" : "Running in simulation mode (no live panel)");
    }
    var vizChip = $("vizConnChip");
    if (vizChip) {
      vizChip.textContent = isOnline ? "PANEL ONLINE" : "SIMULATION";
      vizChip.className = "chip " + (isOnline ? "live" : "simulation");
      vizChip.title = isOnline ? "IntelliCenter connected & responding" : "App running in simulation mode";
    }
    var animBanner = $("animConnBanner");
    var animText = $("animConnText");
    if (animBanner) {
      animBanner.className = "viz-status-banner " + (isOnline ? "online" : "simulation");
    }
    if (animText) {
      animText.textContent = isOnline ? "INTELLICENTER ONLINE" : "SIMULATION MODE";
    }
    var pill = $("modePill");
    if (pill) {
      pill.textContent = mode === "spa" ? "SPA MODE" : "POOL MODE";
      pill.className = "mode-pill" + (mode === "spa" ? " spa" : "");
    }

    var bodies = state.bodies || {};
    var pool = bodies.pool || {};
    var spa = bodies.spa || {};
    $("poolTemp").textContent = temp(pool.temp);
    $("spaTemp").textContent = temp(spa.temp);
    var salt = state.chemistry && state.chemistry.salt;
    $("saltLevel").textContent = salt !== null && salt !== undefined ? salt + " ppm" : "--";
    $("saltLevel").title = state.chemistry && state.chemistry.source === "panel"
      ? "Salt cell reading" : "Configured salt level (no panel reading)";
    $("valveText").textContent = (state.valves && state.valves.label) || "--";

    $("modePool").classList.toggle("active", mode === "pool");
    $("modeSpa").classList.toggle("active", mode === "spa");
    $("modeSpa").classList.toggle("spa-active", mode === "spa");

    var pumps = state.pumps || {};
    renderPump("main", pumps.main || {});
    renderPump("features", pumps.features || {});

    renderDeckJets();
    renderFirebaskets();
    renderBlower();
    renderLights();
    renderHeater();
    renderSchedule();
    renderViz();
    handleRemoteAssistant();
    renderVoiceBubble();

    if (icData && $("view-intellicenter") && $("view-intellicenter").classList.contains("active")) {
      var activeEl = document.activeElement;
      var isTyping = activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "SELECT");
      if (!isTyping) {
        icData.inventory = state.inventory;
        icData.resolved = state.resolved;
        icData.connection = state.connection;
        renderIntelliCenter();
      }
    }

    if (window.panel3d) {
      window.panel3d.update(state, icData ? icData.inventory : state.inventory);
    }
    if ($("view-panel") && $("view-panel").classList.contains("active")) {
      loadIntelliCenter3D();
    }
    if ($("view-logic") && $("view-logic").classList.contains("active")) {
      renderPoolLogic();
    }
  }

  function temp(value) {
    return value === null || value === undefined || isNaN(value) ? "--" : Math.round(value) + "\u00B0F";
  }

  function renderPump(key, pump) {
    var cap = key.charAt(0).toUpperCase() + key.slice(1);
    var toggle = $(key + "PumpToggle");
    var rpm = $(key + "Rpm");
    var rpmVal = $(key + "RpmVal");
    var stateEl = $(key + "PumpState");
    var card = $(key + "PumpCard");
    if (toggle && toggle.checked !== !!pump.on) toggle.checked = !!pump.on;
    if (rpm && document.activeElement !== rpm && pump.rpm) rpm.value = pump.rpm;
    if (rpmVal) rpmVal.textContent = (pump.rpm || "--") + " RPM";
    if (stateEl) stateEl.textContent = (pump.on ? "Running" : "Off") +
      (pump.on ? " \u00B7 " + (pump.rpm || "--") + " RPM" : "");
    if (card) card.classList.toggle("on", !!pump.on);
    var metrics = $(key + "PumpMetrics");
    if (metrics) {
      var inv = findPump(key);
      if (inv && inv.attrs) {
        metrics.textContent = (inv.attrs.GPM || "--") + " GPM \u00B7 " +
          (inv.attrs.PWR || "--") + " W";
      } else {
        metrics.textContent = pump.on ? "Panel metric unavailable" : "-- GPM / -- W";
      }
    }
    if (cap && key === "features" && pump.on) {
      // state text already covers it
    }
  }

  function findPump(kind) {
    var inv = (state && state.inventory) || {};
    var resolved = (state && state.resolved) || {};
    var objnam = resolved.pumps && resolved.pumps[kind];
    if (!objnam) return null;
    return (inv.pumps || []).find(function (p) { return p.objnam === objnam; }) || null;
  }

  function renderDeckJets() {
    var box = $("deckJets");
    if (!box) return;
    var jets = state.deck_jets || {};
    var labels = (state.labels && state.labels.deck_jets) || {};
    Object.keys(jets).forEach(function (key) {
      var jet = jets[key] || {};
      var card = box.querySelector('[data-jet="' + key + '"]');
      if (!card) return;
      card.classList.toggle("on", !!jet.on);
      var toggle = card.querySelector('input[data-toggle="jet"]');
      if (toggle) toggle.checked = !!jet.on;
      var sub = card.querySelector(".feature-sub");
      if (sub) {
        sub.textContent = jet.on
          ? "Running"
          : (labels[key] || key.toUpperCase() + " laminar floor jet");
      }
    });
  }

  function renderFirebaskets() {
    var box = $("firebaskets");
    if (!box) return;
    var baskets = state.firebaskets || {};
    Object.keys(baskets).forEach(function (key) {
      var basket = baskets[key] || {};
      var card = box.querySelector('[data-basket="' + key + '"]');
      if (!card) return;
      card.classList.toggle("on", !!(basket.on || basket.water || basket.spa_water || basket.burner_light));

      var flameToggle = card.querySelector('input[data-toggle="flame"]');
      if (flameToggle) flameToggle.checked = !!basket.on;

      var poolToggle = card.querySelector('input[data-spillway="pool"]');
      if (poolToggle) poolToggle.checked = !!basket.water;

      var spaToggle = card.querySelector('input[data-spillway="spa"]');
      if (spaToggle) spaToggle.checked = !!basket.spa_water;

      var lightToggle = card.querySelector('input[data-toggle="burner-light"]');
      if (lightToggle) lightToggle.checked = !!basket.burner_light;

      var sub = card.querySelector('[data-sub="firebasket"]') || card.querySelector(".feature-sub");
      if (sub) {
        var parts = [];
        if (basket.water) parts.push("Pool");
        if (basket.spa_water) parts.push("Spa");
        var fire = [];
        if (basket.on) fire.push("Flame on");
        if (basket.burner_light) fire.push("Lights on");
        sub.textContent = parts.length
          ? parts.join(" & ") + " spillway flowing" + (fire.length ? " \u00B7 " + fire.join(" \u00B7 ") : "")
          : (fire.length ? fire.join(" \u00B7 ") + " \u00B7 spillways off" : "Spillways & flame off");
      }
    });
  }

  function renderBlower() {
    var toggle = $("blowerToggle");
    if (!toggle) return;
    var blower = (state && state.blower) || {};
    toggle.checked = !!blower.on;
    var card = $("blowerCard");
    if (card) card.classList.toggle("on", !!blower.on);
    var sub = $("blowerState");
    if (sub) sub.textContent = blower.on ? "Blowing" : "Off";
    if (window.pool3d && window.pool3d.setBlower) window.pool3d.setBlower(!!blower.on);
  }

  function effectOptions(selected) {
    var effects = (state && state.light_effects) || DEFAULT_EFFECTS;
    return Object.keys(effects).map(function (code) {
      return '<option value="' + escapeHtml(code) + '"' +
        (code === selected ? " selected" : "") + ">" + escapeHtml(effects[code]) + "</option>";
    }).join("");
  }

  function renderLights() {
    var lights = state.lights || {};
    ["pool", "spa"].forEach(function (body) {
      var light = lights[body] || {};
      var cap = body.charAt(0).toUpperCase() + body.slice(1);
      var toggle = $(body + "LightToggle");
      var select = $(body + "Effect");
      var stateEl = $(body + "LightState");
      if (toggle) toggle.checked = !!light.on;
      if (select && document.activeElement !== select) {
        var wanted = effectOptions(light.effect || "BLUER");
        if (select.innerHTML !== wanted) select.innerHTML = wanted;
      }
      if (stateEl) {
        stateEl.textContent = light.on
          ? "On \u00B7 " + (((state.light_effects || DEFAULT_EFFECTS)[light.effect]) || light.effect || "")
          : "Off \u00B7 blue default";
      }
      var card = document.querySelector('.light-card[data-body="' + body + '"]');
      if (card) card.classList.toggle("on", !!light.on);
    });
  }

  function renderHeater() {
    var heater = state.heater || {};
    var toggle = $("heaterToggle");
    if (toggle) toggle.checked = !!heater.on;
    if ($("heaterStatus")) {
      $("heaterStatus").textContent = heater.on ? "ON" : "OFF";
      $("heaterStatus").className = "chip " + (heater.on ? "hot" : "");
    }
    if ($("heaterBodyText")) {
      $("heaterBodyText").textContent = heater.on
        ? "Heating the " + (state.active_body || "active body") + " (On)"
        : "Heats the active body of water (Off)";
    }
  }

  function renderSchedule() {
    var schedule = state.schedule || {};
    var enabled = $("scheduleEnabled");
    if (enabled) enabled.checked = !!schedule.enabled;
    $("scheduleNext").textContent = schedule.enabled
      ? ("Next run: " + (schedule.next || "none scheduled") +
        (schedule.active ? " \u00B7 RUNNING: " + schedule.active_run : ""))
      : "Schedule disabled";
    var key = JSON.stringify(schedule.runs || []);
    if (!scheduleDirty && key !== scheduleKey) {
      scheduleKey = key;
      scheduleDraft = JSON.parse(JSON.stringify(schedule.runs || []));
      renderScheduleRows();
    } else if (!scheduleDraft) {
      scheduleDraft = JSON.parse(JSON.stringify(schedule.runs || []));
      renderScheduleRows();
    }
  }

  function renderScheduleRows() {
    var box = $("scheduleRuns");
    if (!box) return;
    if (!scheduleDraft || !scheduleDraft.length) {
      box.innerHTML = '<div class="muted">No runs yet. Add a run to keep the main VSR on schedule.</div>';
      return;
    }
    box.innerHTML = scheduleDraft.map(function (run, idx) {
      var days = run.days || DAYS;
      var dayHtml = DAYS.map(function (day) {
        return '<span class="day-chip' + (days.indexOf(day) >= 0 ? " on" : "") +
          '" data-day="' + day + '" data-index="' + idx + '">' + DAY_LABELS[day] + "</span>";
      }).join("");
      return '<div class="schedule-run" data-index="' + idx + '">' +
        '<label>Name<input type="text" data-field="name" value="' + escapeHtml(run.name || "Main VSR run") + '"></label>' +
        '<label>Start<input type="time" data-field="start" value="' + escapeHtml(run.start || "08:00") + '"></label>' +
        '<label>End<input type="time" data-field="end" value="' + escapeHtml(run.end || "18:00") + '"></label>' +
        '<label>RPM<input type="number" min="450" max="3450" step="25" data-field="rpm" value="' +
          escapeHtml(run.rpm || 2200) + '"></label>' +
        '<div><label>Days</label><div class="days">' + dayHtml + "</div></div>" +
        '<button class="btn small danger" data-remove="' + idx + '">Remove</button>' +
        "</div>";
    }).join("");
  }

  function collectSchedule() {
    var runs = [];
    var rows = document.querySelectorAll("#scheduleRuns .schedule-run");
    rows.forEach(function (row) {
      var idx = parseInt(row.getAttribute("data-index"), 10);
      var base = scheduleDraft[idx] || {};
      var name = row.querySelector('[data-field="name"]').value.trim() || "Main VSR run";
      var start = row.querySelector('[data-field="start"]').value || "08:00";
      var end = row.querySelector('[data-field="end"]').value || "18:00";
      var rpm = parseInt(row.querySelector('[data-field="rpm"]').value, 10) || 2200;
      var days = [];
      row.querySelectorAll(".day-chip.on").forEach(function (chip) {
        days.push(chip.getAttribute("data-day"));
      });
      runs.push({ name: name, start: start, end: end, rpm: rpm, days: days.length ? days : DAYS.slice() });
    });
    return runs;
  }

  function renderViz() {
    var mode = state.mode || "pool";
    var bodies = state.bodies || {};
    var pumps = state.pumps || {};
    var lights = state.lights || {};
    var jets = state.deck_jets || {};
    var baskets = state.firebaskets || {};
    var heater = state.heater || {};
    var salt = state.chemistry && state.chemistry.salt;

    $("vizMode").textContent = mode === "spa" ? "SPA" : "POOL";
    $("vizMode").className = "chip live" + (mode === "spa" ? " spa" : "");
    $("vizPool").textContent = temp(bodies.pool && bodies.pool.temp);
    $("vizSpa").textContent = temp(bodies.spa && bodies.spa.temp);
    $("vizMain").textContent = pumps.main && pumps.main.on ? pumps.main.rpm + " RPM" : "Off";
    $("vizFeatures").textContent = pumps.features && pumps.features.on ? pumps.features.rpm + " RPM" : "Off";

    $("infoMode").textContent = mode === "spa" ? "Spa" : "Pool";
    $("infoTemps").textContent = temp(bodies.pool && bodies.pool.temp) + " / " +
      temp(bodies.spa && bodies.spa.temp);
    $("infoSalt").textContent = salt !== null && salt !== undefined ? salt + " ppm" : "--";
    $("infoMain").textContent = pumps.main && pumps.main.on ? pumps.main.rpm + " RPM" : "Off";
    $("infoMain").className = pumps.main && pumps.main.on ? "on" : "";
    $("infoFeatures").textContent = pumps.features && pumps.features.on ? pumps.features.rpm + " RPM" : "Off";
    $("infoFeatures").className = pumps.features && pumps.features.on ? "on" : "";
    $("infoLights").textContent = "Pool " + (lights.pool && lights.pool.on ? "on" : "off") +
      " / Spa " + (lights.spa && lights.spa.on ? "on" : "off");
    $("infoHeater").textContent = heater.on ? "On" : "Off";
    $("infoHeater").className = heater.on ? "hot" : "";
    var activeJets = Object.keys(jets).filter(function (k) { return jets[k].on; }).length;
    var activeFb = Object.keys(baskets).filter(function (k) { return baskets[k].on; }).length;
    $("infoWater").textContent = activeJets + " jets \u00B7 " + activeFb + " baskets";
    $("infoValves").textContent = (state.valves && state.valves.label) || "--";

    if (window.pool3d) window.pool3d.update(state);
  }

  function renderVoiceBubble() {
    if (Date.now() - lastAiAt < 20000) return;
    var bodies = state.bodies || {};
    var salt = state.chemistry && state.chemistry.salt;
    var line = "Pool " + temp(bodies.pool && bodies.pool.temp) + ", spa " +
      temp(bodies.spa && bodies.spa.temp) + ", salt " + (salt || "--") +
      " ppm. I\u2019m keeping one eye on the fountains.";
    $("iguanaLine").textContent = line;
  }

  // ------------------------------------------------------------------
  // Iguana speech
  // ------------------------------------------------------------------
  function setTalking(on) {
    var bubble = $("iguanaBubble");
    if (bubble) bubble.classList.toggle("talking", !!on);
    if (window.pool3d) window.pool3d.setTalking(!!on);
    var mic = $("micBtn");
    if (mic) mic.classList.toggle("iguana-talking", !!on);
  }

  function iguanaSay(text, holdMs) {
    lastAiAt = Date.now();
    var clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (clean.length > 210) clean = clean.slice(0, 207) + "\u2026";
    $("iguanaLine").textContent = clean;
    setTalking(true);
    clearTimeout(talkTimer);
    talkTimer = setTimeout(function () { setTalking(false); }, holdMs || Math.max(2600, clean.length * 55));
  }

  function speakWithBrowser(text) {
    if (!("speechSynthesis" in window)) {
      iguanaSay(text, Math.max(2800, text.length * 55));
      return;
    }
    try {
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(text);
      var wanted = (($("browserVoice") && $("browserVoice").value) || "").trim();
      if (wanted) {
        var voices = window.speechSynthesis.getVoices();
        for (var i = 0; i < voices.length; i++) {
          if (voices[i].name === wanted) { utter.voice = voices[i]; break; }
        }
      }
      utter.rate = parseFloat(($("speakRate") && $("speakRate").value) || "1.02") || 1.02;
      utter.pitch = parseFloat(($("speakPitch") && $("speakPitch").value) || "1.06") || 1.06;
      utter.onstart = function () { setTalking(true); };
      utter.onend = function () { setTalking(false); };
      utter.onerror = function () { setTalking(false); };
      window.speechSynthesis.speak(utter);
      iguanaSay(text, Math.max(2800, text.length * 70));
    } catch (err) {
      iguanaSay(text);
    }
  }

  function playServerAudio(text, b64, mime) {
    var sink = localStorage.getItem("pool.speakerDevice") || "";
    var audio = new Audio("data:" + (mime || "audio/mpeg") + ";base64," + b64);
    audioPlayer = audio;
    audio.onstart = function () { setTalking(true); };
    audio.onplay = function () { setTalking(true); };
    audio.onended = function () { setTalking(false); };
    audio.onerror = function () { setTalking(false); };
    var start = function () {
      audio.play().catch(function () {
        speakWithBrowser(text);
      });
    };
    if (sink && typeof audio.setSinkId === "function") {
      audio.setSinkId(sink).then(start).catch(function () { speakWithBrowser(text); });
    } else {
      start();
    }
    iguanaSay(text, Math.max(2800, text.length * 70));
  }

  // One speaker plays replies: the Pi's or this browser's (Hardware tab).
  function browserSpeakerEnabled() {
    var radio = $("destBrowserSpeaker");
    if (radio) return radio.checked;
    var cfg = (config && config.audio && config.audio.browser) || {};
    return (cfg.speaker_dest || "local") === "browser";
  }

  function speak(text, audioB64, audioMime) {
    var tts = $("ttsToggle");
    if (!tts || !tts.checked || !browserSpeakerEnabled()) {
      iguanaSay(text, Math.max(2800, text.length * 55));
      return;
    }
    var source = ($("voiceSource") && $("voiceSource").value) || "server";
    if (source === "server" && audioB64) {
      playServerAudio(text, audioB64, audioMime);
      return;
    }
    speakWithBrowser(text);
  }

  function handleRemoteAssistant() {
    var a = (state && state.assistant) || {};
    if (!a.text || !a.at || a.at <= lastAssistantAt) return;
    lastAssistantAt = a.at;
    var transcript = a.transcription ? "You: " + a.transcription : "";
    if (transcript && $("voiceTranscript")) $("voiceTranscript").textContent = transcript;
    if ($("voiceResponse")) $("voiceResponse").textContent = a.text;
    if ($("voiceStatus")) {
      $("voiceStatus").textContent = a.source === "local-microphone"
        ? "Iggy heard you on the local microphone"
        : "Iggy answered";
    }
    speak(a.text, null, null);
  }

  // ------------------------------------------------------------------
  // Voice input
  // ------------------------------------------------------------------
  function geminiKey() {
    return localStorage.getItem("pool.geminiKey") || "";
  }

  async function askPool(prompt) {
    if (!prompt) return;
    $("voiceStatus").textContent = "Iggy is listening...";
    $("voiceResponse").textContent = "";
    try {
      var result = await api("/api/gemini/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt, api_key: geminiKey() })
      });
      handleAiResult(result);
    } catch (err) {
      $("voiceStatus").textContent = "Voice error";
      $("voiceResponse").textContent = err.message;
      toast("Iggy could not answer: " + err.message, "error");
    }
  }

  function handleAiResult(result) {
    var transcribed = (result && (result.transcription || result.text) || "").trim();
    var hasTrigger = window.AudioHardware ? window.AudioHardware.containsTriggerName(transcribed) : true;
    var projName = window.AudioHardware ? window.AudioHardware.getProjectName() : "pool";
    if (!hasTrigger && transcribed.length > 0) {
      console.log("[Pool Voice] Ignored input without trigger name:", transcribed);
      if ($("voiceStatus")) $("voiceStatus").textContent = 'Heard: "' + transcribed + '" — waiting for "' + projName + '" anywhere in sentence.';
      return;
    }
    state = result.state || state;
    render();
    var transcript = result.transcription;
    if (transcript) {
      $("voiceTranscript").textContent = "You: " + transcript;
    }
    $("voiceResponse").textContent = result.text || "Done.";
    $("voiceStatus").textContent = result.applied
      ? (result.applied.ok ? "Applied: " + (result.applied.message || "done") : "Applied in simulation")
      : "Iggy answered";
    if (result.at) lastAssistantAt = result.at;
    if (result.action && result.action.action === "open_host_page") {
      openIntelliCenterHost();
    }
    speak(result.text || "Done.", result.audio_b64, result.audio_mime);
  }

  var vuAudioCtx = null;
  var vuAnalyser = null;
  var vuSourceNode = null;
  var vuAnimId = null;
  var vuPollTimer = null;
  var micSensitivityPercent = parseInt(localStorage.getItem("pool.micSensitivity") || "70", 10);

  function micSource() {
    return ($("sourceBrowserMic") && $("sourceBrowserMic").checked) ? "browser" : "local";
  }

  function releaseBrowserMic() {
    stopBrowserVu();
    if (browserMicStream) {
      browserMicStream.getTracks().forEach(function (t) { t.stop(); });
      browserMicStream = null;
    }
  }

  // Only one mic is live: release the browser mic when the Pi mic is chosen.
  function applyMicSource() {
    var browser = micSource() === "browser";
    if (!browser) releaseBrowserMic();
    var btn = $("micBtn");
    if (btn) {
      btn.classList.toggle("disabled", !browser);
      btn.title = browser ? "Hold to talk" : "The Pi webcam mic is selected (Hardware tab)";
    }
    if ($("voiceStatus") && !(recorder && recorder.state === "recording")) {
      $("voiceStatus").textContent = browser ? "Press and hold, then speak"
        : "Listening on the Pi webcam mic. Say \u201cIggy\u201d. (Switch to this browser\u2019s mic in the Hardware tab.)";
    }
    if (browser) {
      var chip = $("micStateChip");
      if (chip) { chip.textContent = "BROWSER MIC"; chip.className = "mic-state-chip listening"; }
    }
  }

  async function saveAudioChoice(browserFields, message) {
    try {
      var result = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: { browser: browserFields } })
      });
      if (result && result.config) config = result.config;
      toast(message, "good");
    } catch (err) {
      toast("Could not save: " + err.message, "error");
    }
  }

  // Meter and threshold share one scale: 16-bit RMS in dBFS, -60 dB = 0%.
  function rmsToPct(rms) {
    if (!rms || rms <= 0) return 0;
    var db = 20 * Math.log10(rms / 32768);
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  }

  function sensitivityToRms(percent) {
    return Math.round(1000 - (percent / 100) * 800);
  }

  function setVuThreshold(rms) {
    var pos = Math.round(rmsToPct(rms));
    ["voiceVuThresh", "hwVuThresh", "cockpitVuThresh"].forEach(function (id) {
      var th = document.getElementById(id);
      if (th) th.style.left = pos + "%";
    });
  }

  function updateVuMeter(level) {
    var val = Math.max(0, Math.min(100, Math.round(level)));
    var fills = ["voiceVuFill", "hwVuFill", "cockpitVuFill"].map(function (id) { return document.getElementById(id); });
    var texts = ["voiceVuVal", "hwVuVal", "cockpitVuVal"].map(function (id) { return document.getElementById(id); });
    fills.forEach(function (f) { if (f) f.style.width = val + "%"; });
    texts.forEach(function (t) { if (t) t.textContent = val + "%"; });
  }

  function setMicSensitivity(percent, sendServer) {
    micSensitivityPercent = Math.max(10, Math.min(100, parseInt(percent, 10) || 70));
    localStorage.setItem("pool.micSensitivity", micSensitivityPercent);
    ["micSensitivity", "hwMicSensitivity", "cockpitMicSensitivity"].forEach(function (id) {
      var s = document.getElementById(id);
      if (s) s.value = micSensitivityPercent;
    });
    ["micSensitivityVal", "hwMicSensitivityVal", "cockpitMicSensitivityVal"].forEach(function (id) {
      var v = document.getElementById(id);
      if (v) v.textContent = micSensitivityPercent + "%";
    });

    setVuThreshold(sensitivityToRms(micSensitivityPercent));

    if (sendServer) {
      var rms = sensitivityToRms(micSensitivityPercent);
      api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: { local: { speech_rms: rms } } })
      }).catch(function () {});
    }
  }

  function startBrowserVu(stream) {
    try {
      if (!vuAudioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        vuAudioCtx = new AC();
      }
      if (vuAudioCtx.state === "suspended") vuAudioCtx.resume();
      if (vuSourceNode) { vuSourceNode.disconnect(); vuSourceNode = null; }
      vuAnalyser = vuAudioCtx.createAnalyser();
      vuAnalyser.fftSize = 256;
      vuSourceNode = vuAudioCtx.createMediaStreamSource(stream);
      vuSourceNode.connect(vuAnalyser);
      var timeData = new Uint8Array(vuAnalyser.fftSize);

      function loop() {
        if (!vuAnalyser) return;
        vuAnalyser.getByteTimeDomainData(timeData);
        var sum = 0;
        for (var i = 0; i < timeData.length; i++) {
          var dev = (timeData[i] - 128) / 128.0;
          sum += dev * dev;
        }
        var rms = Math.sqrt(sum / timeData.length);
        if (micSource() === "browser" || (recorder && recorder.state === "recording")) {
          updateVuMeter(rmsToPct(rms * 32768));
        }
        vuAnimId = requestAnimationFrame(loop);
      }
      if (vuAnimId) cancelAnimationFrame(vuAnimId);
      loop();
    } catch (e) {}
  }

  var browserMicStream = null;

  async function ensureBrowserMicMonitor() {
    if (micSource() !== "browser") return;
    if (browserMicStream) {
      if (vuAudioCtx && vuAudioCtx.state === "suspended") vuAudioCtx.resume();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      var micId = ($("browserMic") && $("browserMic").value) || "";
      var constraints = { audio: micId ? { deviceId: { exact: micId } } : true };
      browserMicStream = await navigator.mediaDevices.getUserMedia(constraints);
      startBrowserVu(browserMicStream);
    } catch (e) {}
  }

  function stopBrowserVu() {
    if (vuAnimId) { cancelAnimationFrame(vuAnimId); vuAnimId = null; }
    if (vuSourceNode) { vuSourceNode.disconnect(); vuSourceNode = null; }
    updateVuMeter(0);
  }

  function updateMicChip(stat) {
    var chip = $("micStateChip");
    if (!chip) return;
    var label = "LISTENING", cls = "listening";
    chip.title = stat.ai_error || "";
    if (stat.ai_ok === false) {
      label = /allowance|rate limit/i.test(stat.ai_error || "") ? "AI RATE LIMITED" : "AI KEY PROBLEM";
      cls = "off";
      if ($("voiceStatus") && !(recorder && recorder.state === "recording")) {
        $("voiceStatus").textContent = "Iggy can't understand speech right now: " + stat.ai_error;
      }
    } else if (!stat.mic_running || /stream ended|open failed/i.test(stat.last_error || "")) {
      label = "MIC OFF"; cls = "off";
    } else if (stat.in_speech) {
      label = "HEARING YOU"; cls = "hearing";
    } else if (!stat.auto_transcribe) {
      label = "LEVEL ONLY"; cls = "";
    }
    chip.textContent = label;
    chip.className = "mic-state-chip" + (cls ? " " + cls : "");
  }

  function setSilenceDelay(seconds, sendServer) {
    var sec = Math.max(0.5, Math.min(5, Math.round((parseFloat(seconds) || 1) * 10) / 10));
    if ($("silenceDelay")) $("silenceDelay").value = sec;
    if ($("silenceDelayVal")) $("silenceDelayVal").textContent = sec.toFixed(1) + " s";
    if (sendServer) {
      api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: { local: { silence_ms: Math.round(sec * 1000) } } })
      }).then(function () {
        toast("Silence delay set to " + sec.toFixed(1) + " s", "good");
      }).catch(function () {});
    }
  }

  async function pollLocalAudioStatus() {
    if (micSource() === "browser" || document.hidden) return;
    // Only poll while a mic meter is on screen; over the Cloudflare tunnel
    // these frequent requests otherwise compete with video and controls.
    var meterShown = ["cockpitVuFill", "voiceVuFill", "hwVuFill"].some(function (id) {
      var el = document.getElementById(id);
      return el && el.offsetParent !== null;
    });
    if (!meterShown) return;
    if (recorder && recorder.state === "recording") return;
    try {
      var stat = await api("/api/audio/status");
      if (stat && stat.rms !== undefined) {
        updateVuMeter(rmsToPct(stat.rms));
        updateMicChip(stat);
      }
    } catch (e) {}
  }

  function base64FromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result || "";
        resolve(String(dataUrl).split(",")[1] || "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function startRecording(event) {
    if (event) event.preventDefault();
    if (recorder) return;
    if (micSource() !== "browser") {
      $("voiceStatus").textContent = "The Pi webcam mic is selected. Say \u201cIggy\u201d near the Pi, or switch to this browser\u2019s mic in the Hardware tab.";
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      $("voiceStatus").textContent = "Microphone recording is not available in this browser. Type instead.";
      return;
    }
    try {
      if (!browserMicStream) {
        var micId = ($("browserMic") && $("browserMic").value) || "";
        var constraints = { audio: micId ? { deviceId: { exact: micId } } : true };
        try {
          browserMicStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (micErr) {
          browserMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        startBrowserVu(browserMicStream);
      }
      recStream = browserMicStream;
      recorder = new MediaRecorder(recStream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "" });
      recChunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = async function () {
        var blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
        cleanupRecording();
        try {
          var b64 = await base64FromBlob(blob);
          $("voiceStatus").textContent = "Sending to Iggy...";
          var result = await api("/api/gemini/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audio_b64: b64,
              mime_type: blob.type || "audio/webm",
              api_key: geminiKey()
            })
          });
          handleAiResult(result);
        } catch (err) {
          $("voiceStatus").textContent = "Voice error";
          $("voiceResponse").textContent = err.message;
          toast("Voice request failed: " + err.message, "error");
        }
      };
      recorder.start();
      $("micBtn").classList.add("recording");
      $("voiceStatus").textContent = "Recording... release to send";
    } catch (err) {
      cleanupRecording();
      $("voiceStatus").textContent = "Microphone permission denied";
      toast("Microphone unavailable: " + err.message, "error");
    }
  }

  function stopRecording(event) {
    if (event) event.preventDefault();
    if (recorder && recorder.state === "recording") {
      $("micBtn").classList.remove("recording");
      $("voiceStatus").textContent = "Processing...";
      recorder.stop();
    }
  }

  function cleanupRecording() {
    if (recStream && recStream !== browserMicStream) {
      recStream.getTracks().forEach(function (t) { t.stop(); });
      recStream = null;
    }
    recorder = null;
    recChunks = [];
    var mic = $("micBtn");
    if (mic) mic.classList.remove("recording");
  }

  // ------------------------------------------------------------------
  // Scenes
  // ------------------------------------------------------------------
  async function runScene(scene) {
    if (scene === "off") {
      await command("system_off", {});
      return;
    }
    if (scene === "evening") {
      await command("set_mode", { mode: "pool" });
      await command("set_light", { body: "pool", on: true, effect: "BLUER" });
      await command("set_light", { body: "spa", on: false });
      await command("set_all_features", { on: false });
      toast("Evening pool scene applied", "good");
      return;
    }
    if (scene === "spa") {
      await command("set_mode", { mode: "spa" });
      await command("set_light", { body: "spa", on: true, effect: "BLUER" });
      await command("set_heater", { on: true, setpoint: 102 });
      await command("set_all_features", { on: false });
      toast("Spa escape scene applied", "good");
      return;
    }
    if (scene === "show") {
      await command("set_mode", { mode: "pool" });
      await command("set_all_features", { on: true });
      await command("set_light", { body: "pool", on: true, effect: "BLUER" });
      await command("set_light", { body: "spa", on: true, effect: "BLUER" });
      toast("Water and fire show running", "good");
    }
  }

  // ------------------------------------------------------------------
  // Assistant personality, voice, mic and speaker settings
  // ------------------------------------------------------------------
  function loadAssistantConfig(a) {
    assistantCfg = a || {};
    var personality = localStorage.getItem("pool.personality") || assistantCfg.personality || "classic";
    var custom = localStorage.getItem("pool.customPersonality") || assistantCfg.personality_custom || "";
    var source = localStorage.getItem("pool.voiceSource") || "server";
    var rate = localStorage.getItem("pool.rate") || assistantCfg.rate || 1.02;
    var pitch = localStorage.getItem("pool.pitch") || assistantCfg.pitch || 1.06;
    if ($("personalitySelect")) $("personalitySelect").value = personality;
    if ($("personalityCustom")) $("personalityCustom").value = custom;
    if ($("voiceSource")) $("voiceSource").value = source;
    if ($("speakRate")) $("speakRate").value = rate;
    if ($("speakPitch")) $("speakPitch").value = pitch;
    updatePersonaVisibility();
    updateRateReadouts();
  }

  function updatePersonaVisibility() {
    var custom = $("personalitySelect") && $("personalitySelect").value === "custom";
    if ($("customPersonaWrap")) $("customPersonaWrap").classList.toggle("hidden", !custom);
  }

  function updateRateReadouts() {
    if ($("rateVal") && $("speakRate")) $("rateVal").textContent = $("speakRate").value;
    if ($("pitchVal") && $("speakPitch")) $("pitchVal").textContent = $("speakPitch").value;
  }

  function populateBrowserVoices() {
    var select = $("browserVoice");
    if (!select) return;
    voiceList = ("speechSynthesis" in window) ? window.speechSynthesis.getVoices() : [];
    var saved = localStorage.getItem("pool.browserVoice") || (config && config.assistant && config.assistant.browser_voice) || "";
    // Each device offers its own voices; group them by language/region
    // (English first) and default to a British male voice when available.
    var sorted = voiceList.slice().sort(function (a, b) {
      var ae = /^en/i.test(a.lang) ? 0 : 1, be = /^en/i.test(b.lang) ? 0 : 1;
      return ae - be || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    var items = sorted.map(function (voice) {
      var region = voice.lang;
      try {
        var names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
        region = names.of(voice.lang) || voice.lang;
      } catch (e) {}
      var gender = /\bfemale\b|woman/i.test(voice.name) ? " \u2014 female"
        : (/\bmale\b|\bman\b/i.test(voice.name) ? " \u2014 male" : "");
      return { id: voice.name, name: voice.name + gender, group: region };
    });
    fillSelect(select, items, "Default browser voice", saved);
    if (!saved || !select.value) {
      var british = sorted.filter(function (v) { return /^en[-_]GB/i.test(v.lang); });
      var male = british.filter(function (v) {
        return !/female/i.test(v.name) &&
          /\bmale\b|ryan|george|daniel|arthur|thomas|oliver|alfie|elliot|noah|ethan|harry|lewis/i.test(v.name);
      })[0] || british[0];
      if (male) select.value = male.name;
    }
  }

  function fillSelect(select, items, defaultLabel, saved) {
    if (!select) return;
    var html = defaultLabel === null ? "" : '<option value="">' + escapeHtml(defaultLabel) + "</option>";
    var group = null;
    (items || []).forEach(function (item) {
      // Items with a "group" (e.g. voices by country) are shown in optgroups.
      if (item.group && item.group !== group) {
        if (group !== null) html += "</optgroup>";
        group = item.group;
        html += '<optgroup label="' + escapeHtml(group) + '">';
      }
      html += '<option value="' + escapeHtml(item.id || item.name || "") + '">' +
        escapeHtml(item.name || item.id || "") + "</option>";
    });
    if (group !== null) html += "</optgroup>";
    select.innerHTML = html;
    if (saved) {
      select.value = saved;
      if (!select.value) select.value = "";
    }
  }

  // Friendly name for a Pi audio device id ("pw:<node>" or ALSA).
  function deviceLabel(list, id) {
    if (!id || id === "pw:" || id === "default") return "the system default";
    var hit = (list || []).filter(function (d) { return d.id === id; })[0];
    return hit ? hit.name : String(id).replace(/^pw:/, "");
  }

  async function refreshAudioDevices(askPermission) {
    if (askPermission && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (err) {
        toast("Browser microphone permission was not granted", "error");
      }
    }
    var inputs = [];
    var outputs = [];
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        var devices = await navigator.mediaDevices.enumerateDevices();
        devices.forEach(function (device) {
          if (device.kind === "audioinput") {
            inputs.push({ id: device.deviceId, name: device.label || "Microphone " + (inputs.length + 1) });
          } else if (device.kind === "audiooutput") {
            outputs.push({ id: device.deviceId, name: device.label || "Speaker " + (outputs.length + 1) });
          }
        });
      } catch (err) {
        toast("Could not list browser audio devices", "error");
      }
    }
    fillSelect($("browserMic"), inputs, "Browser default microphone",
      localStorage.getItem("pool.micDevice") || "");
    fillSelect($("browserSpeaker"), outputs, "Browser default speaker",
      localStorage.getItem("pool.speakerDevice") || "");
    try {
      localAudio = await api("/api/audio/devices");
      var localCfg = (config && config.audio && config.audio.local) || {};
      var browserCfg = (config && config.audio && config.audio.browser) || {};
      var localMic = localCfg.input_device || "default";
      var localSpk = localCfg.output_device || "default";
      fillSelect($("localMic"), localAudio.inputs, "System default microphone", localMic);
      fillSelect($("localSpeaker"), localAudio.outputs, "System default speaker", localSpk);

      // The mic and speaker choices are stored on the Pi: there is one Pi mic,
      // so every browser must agree which mic and speaker are in use.
      var savedVoiceSource = browserCfg.voice_source === "browser" ? "browser" : "local";
      var savedSpeakerDest = browserCfg.speaker_dest === "browser" ? "browser" : "local";
      if ($("sourceLocalMic")) $("sourceLocalMic").checked = (savedVoiceSource === "local");
      if ($("sourceBrowserMic")) $("sourceBrowserMic").checked = (savedVoiceSource === "browser");
      if ($("destLocalSpeaker")) $("destLocalSpeaker").checked = (savedSpeakerDest === "local");
      if ($("destBrowserSpeaker")) $("destBrowserSpeaker").checked = (savedSpeakerDest === "browser");
      applyMicSource();

      setSilenceDelay((localCfg.silence_ms || 1000) / 1000, false);
      if (localCfg.speech_rms) {
        var pct = Math.round(((1000 - localCfg.speech_rms) / 800) * 100);
        setMicSensitivity(Math.max(10, Math.min(100, pct)), false);
      } else {
        setMicSensitivity(micSensitivityPercent, false);
      }

      // The Pi voice is a shared setting, so the Pi's saved choice wins.
      var savedVoice = (config && config.assistant && config.assistant.server_voice) ||
        localStorage.getItem("pool.serverVoice") || localAudio.default_voice || "gb-male";
      fillSelect($("serverVoice"), localAudio.voices, null, savedVoice);
      var status = localAudio.local || {};
      var speakerRoute = ("setSinkId" in HTMLMediaElement.prototype)
        ? "Browser speaker routing supported" : "Browser speaker routing not supported by this browser";
      $("localAudioStatus").textContent =
        "Pi microphone: " + (status.mic_running ? "always listening on " + deviceLabel(localAudio.inputs, status.input_device) : "not running") +
        "\nPi speaker: " + (status.speaker_available ? "always on, playing to " + deviceLabel(localAudio.outputs, status.output_device) : "not available") +
        "\n" + speakerRoute + ". Local mic and speaker stay active even when browser devices are selected." +
        (status.last_error ? "\nLast audio error: " + status.last_error : "");
    } catch (err) {
      if ($("localAudioStatus")) $("localAudioStatus").textContent = "Local audio status unavailable: " + err.message;
    }
  }

  async function saveAssistantSettings() {
    var payload = {
      assistant: {
        personality: $("personalitySelect").value,
        personality_custom: $("personalityCustom").value.trim(),
        browser_voice: $("browserVoice").value,
        server_voice: $("serverVoice").value || "gb-male",
        rate: parseFloat($("speakRate").value) || 1.02,
        pitch: parseFloat($("speakPitch").value) || 1.06
      }
    };
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      localStorage.setItem("pool.personality", payload.assistant.personality);
      localStorage.setItem("pool.customPersonality", payload.assistant.personality_custom);
      localStorage.setItem("pool.browserVoice", payload.assistant.browser_voice);
      localStorage.setItem("pool.serverVoice", payload.assistant.server_voice);
      localStorage.setItem("pool.rate", payload.assistant.rate);
      localStorage.setItem("pool.pitch", payload.assistant.pitch);
      toast("Iggy personality and voice saved", "good");
    } catch (err) {
      toast("Could not save personality: " + err.message, "error");
    }
  }

  async function saveAudioSettings() {
    var voiceSource = ($("sourceBrowserMic") && $("sourceBrowserMic").checked) ? "browser" : "local";
    var speakerDest = browserSpeakerEnabled() ? "browser" : "local";
    var rms = sensitivityToRms(micSensitivityPercent);

    var payload = {
      audio: {
        local: {
          input_device: ($("localMic") && $("localMic").value) || "default",
          output_device: ($("localSpeaker") && $("localSpeaker").value) || "default",
          speech_rms: rms
        },
        browser: {
          mic_device: ($("browserMic") && $("browserMic").value) || "",
          speaker_device: ($("browserSpeaker") && $("browserSpeaker").value) || "",
          voice_source: voiceSource,
          speaker_dest: speakerDest
        }
      }
    };
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      localStorage.setItem("pool.micDevice", payload.audio.browser.mic_device);
      localStorage.setItem("pool.speakerDevice", payload.audio.browser.speaker_device);
      localStorage.setItem("pool.micSource", voiceSource);
      localStorage.setItem("pool.speakerDest", speakerDest);
      localStorage.setItem("pool.micSensitivity", micSensitivityPercent);
      if (config) {
        config.audio = config.audio || {};
        config.audio.local = payload.audio.local;
        config.audio.browser = payload.audio.browser;
      }
      toast("Audio hardware settings saved", "good");
    } catch (err) {
      toast("Could not save audio devices: " + err.message, "error");
    }
  }

  async function saveServerKey() {
    var key = $("voiceKey").value.trim();
    if (!key) { toast("Enter an API key first", "error"); return; }
    try {
      var result = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_api_key: key,
          ai_provider: $("aiProvider").value
        })
      });
      localStorage.setItem("pool.geminiKey", key);
      $("voiceKey").value = "";
      if (result.config) config = result.config;
      loadConfig();
      toast("AI key saved on the server", "good");
    } catch (err) {
      toast("Could not save OpenCode key: " + err.message, "error");
    }
  }


  // ------------------------------------------------------------------
  // Iggy's eyes: local and browser cameras
  // ------------------------------------------------------------------
  function updateCameraStatus(extra) {
    var el = $("cameraStatus");
    if (!el) return;
    var parts = [];
    if (localCameraStatus) {
      parts.push("Local camera: " + (localCameraStatus.available
        ? (localCameraStatus.device || "auto")
        : "none found"));
      if (localCameraStatus.last_error) parts.push(localCameraStatus.last_error);
    }
    if (cameraStream) {
      var track = cameraStream.getVideoTracks()[0];
      parts.push("Browser camera: " + (track ? (track.label || "streaming") : "streaming"));
    } else {
      parts.push("Browser camera: not started");
    }
    if (extra) parts.push(extra);
    el.textContent = parts.join("\n");
  }

  async function refreshCameraDevices(askPermission) {
    if (askPermission && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (err) {
        toast("Browser camera permission was not granted", "error");
      }
    }
    var inputs = [];
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        var devices = await navigator.mediaDevices.enumerateDevices();
        devices.forEach(function (device) {
          if (device.kind === "videoinput") {
            inputs.push({ id: device.deviceId, name: device.label || "Camera " + (inputs.length + 1) });
          }
        });
      } catch (err) {
        toast("Could not list browser cameras", "error");
      }
    }
    fillSelect($("browserCamera"), inputs, "Browser default camera",
      localStorage.getItem("pool.browserCamera") || "");
    try {
      var data = await api("/api/camera/devices");
      localCameraStatus = data.status || null;
      var cameras = data.cameras || [];
      var cameraCfg = (config && config.camera && config.camera.local) || {};
      fillSelect($("localCamera"), cameras, "Auto - first available", cameraCfg.device || "auto");
      if ($("localCameraWidth")) $("localCameraWidth").value = String(cameraCfg.width || 1280);
      if ($("visionOnVoice")) $("visionOnVoice").checked = cameraCfg.vision_on_voice !== false;
      updateCameraStatus();
    } catch (err) {
      if ($("cameraStatus")) $("cameraStatus").textContent = "Camera status unavailable: " + err.message;
    }
  }

  async function startBrowserCamera() {
    if (cameraStream) return cameraStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Browser camera is not available");
    }
    var cameraId = ($("browserCamera") && $("browserCamera").value) || "";
    var video = $("browserVideo");
    var constraints = { video: cameraId ? { deviceId: { exact: cameraId } } : true };
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    }
    if (video) {
      video.srcObject = cameraStream;
      try { await video.play(); } catch (err) { /* autoplay muted */ }
    }
    updateCameraStatus();
    return cameraStream;
  }

  function waitForVideo(video) {
    return new Promise(function (resolve) {
      if (!video) return resolve();
      if (video.readyState >= 2 && video.videoWidth) return resolve();
      var done = function () { resolve(); };
      video.addEventListener("loadeddata", done, { once: true });
      setTimeout(done, 3000);
    });
  }

  async function captureBrowserFrame() {
    if (!cameraStream) await startBrowserCamera();
    var video = $("browserVideo");
    await waitForVideo(video);
    if (!video || !video.videoWidth) throw new Error("No browser camera frame yet");
    var canvas = $("browserCanvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] || "";
  }

  function refreshLocalSnapshot() {
    var img = $("localCameraPreview");
    if (!img || !canSeeCamera()) return;
    img.onerror = function () { img.removeAttribute("src"); };
    img.src = "/api/camera/snapshot?t=" + Date.now();
  }

  async function lookWithLocalCamera() {
    var prompt = ($("voiceText") && $("voiceText").value.trim()) ||
      "Look at what is being shown to you and tell me what you see.";
    if ($("voiceText")) $("voiceText").value = "";
    $("voiceStatus").textContent = "Iggy is looking through the local camera...";
    try {
      var result = await api("/api/camera/look", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt, api_key: geminiKey() })
      });
      handleAiResult(result);
      refreshLocalSnapshot();
    } catch (err) {
      $("voiceStatus").textContent = "Camera error";
      $("voiceResponse").textContent = err.message;
      toast("Local camera failed: " + err.message, "error");
    }
  }

  async function lookWithBrowserCamera() {
    var prompt = ($("voiceText") && $("voiceText").value.trim()) ||
      "Look at what I am showing you and tell me what you see.";
    if ($("voiceText")) $("voiceText").value = "";
    $("voiceStatus").textContent = "Iggy is looking through the browser camera...";
    try {
      var b64 = await captureBrowserFrame();
      if (!b64) throw new Error("No frame captured");
      var result = await api("/api/gemini/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_b64: b64,
          mime_type: "image/jpeg",
          prompt: prompt,
          api_key: geminiKey()
        })
      });
      handleAiResult(result);
    } catch (err) {
      $("voiceStatus").textContent = "Camera error";
      $("voiceResponse").textContent = err.message;
      toast("Browser camera failed: " + err.message, "error");
    }
  }

  async function saveCameraSettings() {
    var cameraId = ($("browserCamera") && $("browserCamera").value) || "";
    var payload = {
      camera: {
        local: {
          device: ($("localCamera") && $("localCamera").value) || "auto",
          width: parseInt(($("localCameraWidth") && $("localCameraWidth").value) || "1280", 10),
          vision_on_voice: !!($("visionOnVoice") && $("visionOnVoice").checked)
        },
        browser: { device: cameraId }
      }
    };
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      localStorage.setItem("pool.browserCamera", cameraId);
      if (config) {
        config.camera = config.camera || {};
        config.camera.local = payload.camera.local;
      }
      toast("Camera settings saved", "good");
      updateCameraStatus();
    } catch (err) {
      toast("Could not save cameras: " + err.message, "error");
    }
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  async function loadConfig() {
    try {
      config = await api("/api/config");
      var ic = config.intellicenter || {};
      $("icHost").value = ic.host || "";
      $("icPort").value = ic.port || 6681;
      $("icTransport").value = ic.transport || "tcp";
      $("icDiscovery").checked = ic.discovery !== false;
      $("icApplyPool").checked = ic.apply_pool_mode_on_start !== false;
      $("timezone").value = config.timezone || "";
      $("icAddress").textContent = "Panel: " +
        (ic.host ? ic.host + ":" + (ic.port || 6681) : "mDNS discovery / port " + (ic.port || 6681));

      var pi = config.pi || {};
      var piParts = [];
      if (pi.hostname) piParts.push(pi.hostname);
      if (pi.local_ip) piParts.push(pi.local_ip + ":" + (pi.port || 2490));
      if (pi.public_url) piParts.push(pi.public_url);
      $("piAddress").textContent = piParts.length ? "Raspberry Pi: " + piParts.join(" \u00B7 ") : "Raspberry Pi address unavailable";

      var ai = config.ai || {};
      $("aiProvider").value = ai.provider || "auto";
      $("aiKeyHint").textContent = ai.configured
        ? "AI key loaded (" + (ai.key_hint || "hidden") + ")" + (ai.source ? " from " + ai.source : "") + " \u00B7 model " + (ai.model || "")
        : "No AI key configured";
      $("voiceKey").placeholder = ai.configured
        ? "Default key in use (" + (ai.key_hint || "hidden") + ") - paste a new key to replace"
        : "Paste an API key";
      var curType = localStorage.getItem("pool.apiKeyType") || (geminiKey().startsWith("AQ.") ? "opencode-go" : "google");
      if ($("selectApiKeyType")) $("selectApiKeyType").value = curType;

      var alexa = config.alexa || {};
      $("alexaEnabled").checked = alexa.enabled !== false;
      $("alexaSkillName").value = alexa.skill_name || "";
      $("alexaEndpoint").textContent = "Endpoint: " +
        ((pi.public_url || location.origin) + "/alexa");
      if ($("alexaSkillId")) $("alexaSkillId").value = alexa.skill_id || "";
      if ($("alexaCustomChip")) {
        $("alexaCustomChip").textContent = alexa.skill_id ? "SKILL ID SET" : "NOT LINKED";
        $("alexaCustomChip").className = "chip" + (alexa.skill_id ? " on" : " hot");
      }
      $("alexaSkillInfo").textContent = "Skill: " + (alexa.skill_name || "Lighthouse Pool") +
        " \u00B7 " + (alexa.enabled !== false ? "enabled" : "disabled") +
        " \u00B7 token " + (alexa.token_set ? "set" : "not set");

      loadAssistantConfig(config.assistant || {});
      populateBrowserVoices();
    } catch (err) {
      toast("Could not load config: " + err.message, "error");
    }
  }

  async function saveSettings() {
    try {
      var payload = {
        intellicenter_host: $("icHost").value.trim(),
        intellicenter_port: parseInt($("icPort").value, 10) || 6681,
        transport: $("icTransport").value,
        discovery: $("icDiscovery").checked,
        apply_pool_mode_on_start: $("icApplyPool").checked,
        timezone: $("timezone").value.trim(),
        ai_provider: $("aiProvider").value
      };
      var key = $("voiceKey").value.trim();
      if (key) payload.gemini_api_key = key;
      var result = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (key) {
        localStorage.setItem("pool.geminiKey", key);
        $("voiceKey").value = "";
      }
      toast(result.message || "Settings saved", "good");
      var conn = result.connection || {};
      $("connChip").textContent = conn.connected ? "PANEL ONLINE" : "SIMULATION";
      $("connChip").className = "chip " + (conn.connected ? "on" : "hot");
      if (result.config) {
        config = result.config;
        loadConfig();
      }
      setTimeout(refreshInventory, 1200);
    } catch (err) {
      toast("Settings failed: " + err.message, "error");
    }
  }

  async function saveAlexaSkillId() {
    var id = $("alexaSkillId").value.trim();
    if (id && !/^amzn1\.ask\.skill\.[0-9a-f-]{36}$/i.test(id)) {
      toast("That doesn't look like a Skill ID (amzn1.ask.skill.\u2026)", "error");
      return;
    }
    try {
      var result = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alexa_skill_id: id })
      });
      toast(id ? "Skill ID saved: Alexa can now control the pool" : "Skill ID cleared", "good");
      if (result.config) config = result.config;
      loadConfig();
    } catch (err) {
      toast("Could not save Skill ID: " + err.message, "error");
    }
  }

  async function downloadAlexaModel() {
    try {
      var model = await api("/api/alexa/interaction-model");
      var blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lighthouse-pool-interaction-model.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (err) {
      toast("Could not download the interaction model: " + err.message, "error");
    }
  }

  async function saveAlexaSettings() {
    try {
      var payload = {
        alexa_enabled: $("alexaEnabled").checked,
        alexa_skill_name: $("alexaSkillName").value.trim()
      };
      var token = $("alexaToken").value.trim();
      if (token) payload.alexa_token = token;
      var result = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      $("alexaToken").value = "";
      toast(result.message || "Alexa settings saved", "good");
      if (result.config) config = result.config;
      loadConfig();
      loadAlexa();
    } catch (err) {
      toast("Could not save Alexa settings: " + err.message, "error");
    }
  }

  async function refreshInventory() {
    try {
      var result = await api("/api/inventory");
      var inv = result.inventory || {};
      var conn = result.connection || {};
      $("connChip").textContent = conn.connected ? "PANEL ONLINE" : "SIMULATION";
      $("connChip").className = "chip " + (conn.connected ? "on" : "hot");
      $("icAddress").textContent = "Panel: " +
        (conn.host ? conn.host + ":" + (conn.port || 6681) : "mDNS discovery / port " + (conn.port || 6681)) +
        (conn.connected ? " (online)" : " (simulation)");
      $("connStatus").textContent =
        "Mode: " + (conn.mode || "simulation") +
        "\nHost: " + (conn.host || "(mDNS discovery)") + ":" + (conn.port || 6681) +
        "\nTransport: " + (conn.transport || "tcp") +
        "\nResolved mappings: " + (conn.resolved_count || 0) +
        (conn.last_error ? "\nLast error: " + conn.last_error : "") +
        "\nObjects: " + ((inv.objects || []).length);
      renderMappings(result.resolved || {}, inv);
      toast("Inventory refreshed", "good");
    } catch (err) {
      toast("Inventory failed: " + err.message, "error");
    }
  }

  function nameFor(objnam, inv) {
    var groups = ["circuits", "pumps", "pump_circuits", "bodies", "heaters", "valves", "chemistry"];
    for (var g = 0; g < groups.length; g++) {
      var list = inv[groups[g]] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].objnam === objnam) return list[i].name || objnam;
      }
    }
    return objnam;
  }

  function renderMappings(resolved, inv) {
    var box = $("mappingList");
    if (!box) return;
    var rows = [];
    function add(label, value) {
      var missing = !value;
      rows.push('<div class="mapping-row' + (missing ? " missing" : "") + '"><span>' +
        escapeHtml(label) + "</span><b>" +
        escapeHtml(missing ? "not mapped" : nameFor(value, inv) + " (" + value + ")") + "</b></div>");
    }
    ["pool", "spa"].forEach(function (k) {
      add("Mode / body circuit: " + k, resolved.modes && resolved.modes[k]);
    });
    ["pool", "spa"].forEach(function (k) {
      add("Body: " + k, resolved.bodies && resolved.bodies[k]);
    });
    ["main", "features"].forEach(function (k) {
      add("Pump: " + k, resolved.pumps && resolved.pumps[k]);
      add("Pump program: " + k, resolved.pump_programs && resolved.pump_programs[k]);
    });
    Object.keys(resolved.deck_jets || {}).forEach(function (jet) {
      var spec = resolved.deck_jets[jet] || {};
      add("Floor jet " + jet.toUpperCase(), spec.water);
    });
    Object.keys(resolved.firebaskets || {}).forEach(function (basket) {
      var spec = resolved.firebaskets[basket] || {};
      add("Firebasket " + basket + " pool fountain", spec.water);
      add("Firebasket " + basket + " spa fountain", spec.spa_water);
      add("Firebasket " + basket + " burner", spec.burner);
      add("Firebasket " + basket + " burner lights", spec.burner_light);
    });
    add("Blower", resolved.blower && resolved.blower.circuit);
    ["pool", "spa"].forEach(function (body) {
      add("Light: " + body, resolved.lights && resolved.lights[body]);
    });
    add("Heater body", resolved.heater && resolved.heater.body);
    add("Heater device", resolved.heater && resolved.heater.device);
    box.innerHTML = rows.join("");
  }

  // ------------------------------------------------------------------
  // IntelliCenter Equipment Management & Animation Mapping
  // ------------------------------------------------------------------
  var icData = null;
  var icCurrentFilter = "all";
  var icSearchQuery = "";

  var ANIMATION_SLOTS = [
    {
      group: "Water Body Modes & Shells",
      icon: "🌊",
      items: [
        { path: "modes.pool", label: "Pool Mode Circuit", hint: "Toggles Pool drain & return", type: "CIRCUIT" },
        { path: "modes.spa", label: "Spa Mode Circuit", hint: "Toggles Spa drain & return", type: "CIRCUIT" },
        { path: "bodies.pool", label: "Pool Water Body", hint: "Temperature & pool water basin", type: "BODY" },
        { path: "bodies.spa", label: "Spa Water Body", hint: "Temperature & spa water basin", type: "BODY" }
      ]
    },
    {
      group: "Circulation & Feature Pumps",
      icon: "⚙️",
      items: [
        { path: "pumps.main", label: "Main Circulation Pump", hint: "Pad pump model & filtration", type: "PUMP" },
        { path: "pump_programs.main", label: "Main VSR Speed Program", hint: "Main pump RPM control", type: "PMPCIRC" },
        { path: "pumps.features", label: "Features VSR Pump", hint: "Secondary pump for water features", type: "PUMP" },
        { path: "pump_programs.features", label: "Features VSR Speed Program", hint: "Features pump RPM control", type: "PMPCIRC" }
      ]
    },
    {
      group: "Deck Laminar Floor Jets",
      icon: "💦",
      items: [
        { path: "deck_jets.ne.water", label: "NE Floor Jet (Water Stream)", hint: "Northeast deck arc water stream", type: "CIRCUIT" },
        { path: "deck_jets.ne.light", label: "NE Floor Jet (Light)", hint: "Northeast deck jet colored LED", type: "CIRCUIT" },
        { path: "deck_jets.ne.thumper", label: "NE Floor Jet (Thumper)", hint: "Northeast laminar pulse effect", type: "CIRCUIT" },
        { path: "deck_jets.nw.water", label: "NW Floor Jet (Water Stream)", hint: "Northwest deck arc water stream", type: "CIRCUIT" },
        { path: "deck_jets.nw.light", label: "NW Floor Jet (Light)", hint: "Northwest deck jet colored LED", type: "CIRCUIT" },
        { path: "deck_jets.nw.thumper", label: "NW Floor Jet (Thumper)", hint: "Northwest laminar pulse effect", type: "CIRCUIT" },
        { path: "deck_jets.se.water", label: "SE Floor Jet (Water Stream)", hint: "Southeast deck arc water stream", type: "CIRCUIT" },
        { path: "deck_jets.se.light", label: "SE Floor Jet (Light)", hint: "Southeast deck jet colored LED", type: "CIRCUIT" },
        { path: "deck_jets.se.thumper", label: "SE Floor Jet (Thumper)", hint: "Southeast laminar pulse effect", type: "CIRCUIT" },
        { path: "deck_jets.sw.water", label: "SW Floor Jet (Water Stream)", hint: "Southwest deck arc water stream", type: "CIRCUIT" },
        { path: "deck_jets.sw.light", label: "SW Floor Jet (Light)", hint: "Southwest deck jet colored LED", type: "CIRCUIT" },
        { path: "deck_jets.sw.thumper", label: "SW Floor Jet (Thumper)", hint: "Southwest laminar pulse effect", type: "CIRCUIT" }
      ]
    },
    {
      group: "Firepits & Spillways",
      icon: "🔥",
      items: [
        { path: "firebaskets.east.burner", label: "East Firepit Burner", hint: "East firepit animated flame & ember", type: "CIRCUIT" },
        { path: "firebaskets.east.burner_light", label: "East Burner Lights", hint: "LED strip under the east burner", type: "CIRCUIT" },
        { path: "firebaskets.east.water", label: "East Firepit Pool Spillway", hint: "East spillway flowing into pool", type: "CIRCUIT" },
        { path: "firebaskets.east.spa_water", label: "East Firepit Spa Spillway", hint: "East spillway flowing into spa", type: "CIRCUIT" },
        { path: "firebaskets.east.spillway_pool_led", label: "East Pool Spillway Light", hint: "Light on the east pool spillway", type: "CIRCUIT" },
        { path: "firebaskets.east.spillway_spa_led", label: "East Spa Spillway Light", hint: "Light on the east spa spillway", type: "CIRCUIT" },
        { path: "firebaskets.west.burner", label: "West Firepit Burner", hint: "West firepit animated flame & ember", type: "CIRCUIT" },
        { path: "firebaskets.west.burner_light", label: "West Burner Lights", hint: "LED strip under the west burner", type: "CIRCUIT" },
        { path: "firebaskets.west.water", label: "West Firepit Pool Spillway", hint: "West spillway flowing into pool", type: "CIRCUIT" },
        { path: "firebaskets.west.spa_water", label: "West Firepit Spa Spillway", hint: "West spillway flowing into spa", type: "CIRCUIT" },
        { path: "firebaskets.west.spillway_pool_led", label: "West Pool Spillway Light", hint: "Light on the west pool spillway", type: "CIRCUIT" },
        { path: "firebaskets.west.spillway_spa_led", label: "West Spa Spillway Light", hint: "Light on the west spa spillway", type: "CIRCUIT" }
      ]
    },
    {
      group: "Spa Air Blower",
      icon: "💨",
      items: [
        { path: "blower.circuit", label: "Spa Air Blower Circuit", hint: "Bubbles & foam churn in spa", type: "CIRCUIT" }
      ]
    },
    {
      group: "Underwater Color LEDs",
      icon: "💡",
      items: [
        { path: "lights.pool", label: "Pool Underwater Color Light", hint: "Pool interior basin illumination", type: "CIRCUIT" },
        { path: "lights.spa", label: "Spa Underwater Color Light", hint: "Spa interior basin illumination", type: "CIRCUIT" }
      ]
    },
    {
      group: "Motorized 3-Way Valves",
      icon: "🔀",
      items: [
        { path: "valves.drain", label: "Pool/Spa Drain Valve Actuator", hint: "Rotates drain valve on pad", type: "VALVE" },
        { path: "valves.return", label: "Pool/Spa Return Valve Actuator", hint: "Rotates return valve on pad", type: "VALVE" }
      ]
    },
    {
      group: "Heater & Temperature",
      icon: "🌡️",
      items: [
        { path: "heater.device", label: "Pool Gas Heater Device", hint: "Pad heater indicator & firing state", type: "HEATER" },
        { path: "heater.body", label: "Heated Water Body Target", hint: "Water body heated by thermostat", type: "BODY" }
      ]
    }
  ];

  function getMappingValue(mapping, path) {
    if (!mapping) return "";
    var parts = path.split(".");
    var cur = mapping;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== "object") return "";
      cur = cur[parts[i]];
    }
    if (typeof cur === "string") return cur;
    if (cur && typeof cur === "object") return cur.objnam || cur.name || "";
    return "";
  }

  function setMappingValue(mapping, path, value) {
    var parts = path.split(".");
    var cur = mapping;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") {
        cur[parts[i]] = {};
      }
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function isDeviceInCategory(obj, cat) {
    if (cat === "all") return true;
    var name = (obj.name || "").toLowerCase();
    var objtype = (obj.objtype || "").toUpperCase();
    var subtype = (obj.subtype || "").toUpperCase();

    if (cat === "valves") {
      return objtype === "VALVE" || subtype === "VALVE" || name.indexOf("valve") !== -1;
    }
    if (cat === "circuits") {
      return objtype === "CIRCUIT";
    }
    if (cat === "relays") {
      return objtype === "CIRCUIT" && (name.indexOf("aux") !== -1 || name.indexOf("relay") !== -1 || subtype === "GENERIC");
    }
    if (cat === "pumps") {
      return objtype === "PUMP" || objtype === "PMPCIRC" || name.indexOf("pump") !== -1;
    }
    if (cat === "lights") {
      return subtype === "LIGHT" || subtype === "INTELLI" || subtype === "GLOW" || subtype === "GLOWT" ||
        subtype === "DIMMER" || name.indexOf("light") !== -1 || name.indexOf("led") !== -1 || name.indexOf("lamp") !== -1;
    }
    if (cat === "jets") {
      return subtype === "MAGIC2" || name.indexOf("jet") !== -1 || name.indexOf("laminar") !== -1 ||
        name.indexOf("fountain") !== -1 || name.indexOf("spillway") !== -1;
    }
    if (cat === "heaters") {
      return objtype === "HEATER" || objtype === "CHEM" || objtype === "BODY" ||
        name.indexOf("heater") !== -1 || name.indexOf("temp") !== -1 || name.indexOf("salt") !== -1 || name.indexOf("chlor") !== -1;
    }
    return true;
  }

  function getDeviceAnimationRole(objnam, name, resolved) {
    if (!resolved) return null;
    var n = (name || "").toUpperCase().trim();
    function match(target) {
      if (!target) return false;
      return target === objnam || (typeof target === "string" && target.toUpperCase().trim() === n);
    }

    if (match(resolved.modes && resolved.modes.pool)) return "Mode: Pool";
    if (match(resolved.modes && resolved.modes.spa)) return "Mode: Spa";
    if (match(resolved.bodies && resolved.bodies.pool)) return "Body: Pool";
    if (match(resolved.bodies && resolved.bodies.spa)) return "Body: Spa";

    if (match(resolved.pumps && resolved.pumps.main)) return "Main Circulation Pump";
    if (match(resolved.pumps && resolved.pumps.features)) return "Water Features Pump";
    if (match(resolved.pump_programs && resolved.pump_programs.main)) return "Main Pump Program";
    if (match(resolved.pump_programs && resolved.pump_programs.features)) return "Features Pump Program";

    if (resolved.deck_jets) {
      for (var jet in resolved.deck_jets) {
        var spec = resolved.deck_jets[jet] || {};
        if (match(spec.water)) return jet.toUpperCase() + " Floor Jet (Water)";
        if (match(spec.light)) return jet.toUpperCase() + " Floor Jet (Light)";
        if (match(spec.thumper)) return jet.toUpperCase() + " Floor Jet (Thumper)";
      }
    }

    if (resolved.firebaskets) {
      for (var b in resolved.firebaskets) {
        var fspec = resolved.firebaskets[b] || {};
        var bName = b === "east" ? "East Firepit" : "West Firepit";
        if (match(fspec.water)) return bName + " Pool Spillway";
        if (match(fspec.spa_water)) return bName + " Spa Spillway";
        if (match(fspec.burner)) return bName + " Burner";
        if (match(fspec.burner_light)) return bName + " Burner Lights";
        if (match(fspec.spillway_pool_led)) return bName + " Pool LED";
        if (match(fspec.spillway_spa_led)) return bName + " Spa LED";
      }
    }

    if (match(resolved.blower && resolved.blower.circuit)) return "Spa Blower";

    if (resolved.lights) {
      if (match(resolved.lights.pool)) return "Pool LED Light";
      if (match(resolved.lights.spa)) return "Spa LED Light";
    }

    if (resolved.valves) {
      if (match(resolved.valves.drain)) return "Drain 3-Way Valve";
      if (match(resolved.valves.return)) return "Return 3-Way Valve";
    }

    if (resolved.heater) {
      if (match(resolved.heater.device)) return "Pool Heater Device";
      if (match(resolved.heater.body)) return "Heated Body Target";
    }

    return null;
  }

  async function controlDevice(objnam, on, speed, effect, setpoint, password) {
    try {
      var payload = { objnam: objnam };
      if (password) payload.password = password;
      if (on !== undefined && on !== null) payload.on = on;
      if (speed !== undefined && speed !== null) payload.speed = speed;
      if (effect !== undefined && effect !== null) payload.effect = effect;
      if (setpoint !== undefined && setpoint !== null) payload.setpoint = setpoint;

      var result = await api("/api/intellicenter/device/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (result && result.password_required && !password) {
        var pw = await askBurnerPassword();
        if (pw) return controlDevice(objnam, on, speed, effect, setpoint, pw);
      }
      if (result && result.state) {
        state = result.state;
        render();
      }
      toast(result.message || ("Device " + objnam + " updated"), result.ok ? "good" : "error");
      await loadIntelliCenter();
    } catch (err) {
      toast("Device control failed: " + err.message, "error");
    }
  }

  window.controlDevice = controlDevice;

  function loadIntelliCenter3D() {
    if (!state) return;
    var conn = state.connection || {};
    var isOnline = !!conn.connected;
    var inv = (icData && icData.inventory) || state.inventory || {};
    var objects = inv.objects || [];
    var bodies = state.bodies || {};

    if ($("p3dNetChip")) {
      $("p3dNetChip").textContent = isOnline ? "ONLINE" : "SIMULATION";
      $("p3dNetChip").className = "chip " + (isOnline ? "live" : "simulation");
    }
    if ($("p3dTransport")) {
      $("p3dTransport").textContent = (conn.transport ? conn.transport.toUpperCase() : "TCP") + " (Port " + (conn.port || 6681) + ")";
    }
    if ($("p3dHost")) {
      $("p3dHost").textContent = conn.host ? conn.host : "127.0.0.1 (Local)";
    }
    var p3dUrl = getIntelliCenterWebUrl();
    if ($("p3dHostLink")) {
      if (p3dUrl) {
        $("p3dHostLink").href = p3dUrl;
        $("p3dHostLink").style.display = "inline-flex";
      } else {
        $("p3dHostLink").style.display = "none";
      }
    }
    if ($("p3dConnMsg")) {
      $("p3dConnMsg").textContent = isOnline ? "Connected & Synchronized" : "Local Digital Twin Active";
    }
    if ($("p3dPoolTemp")) {
      $("p3dPoolTemp").textContent = temp(bodies.pool && bodies.pool.temp);
    }
    if ($("p3dSpaTemp")) {
      $("p3dSpaTemp").textContent = temp(bodies.spa && bodies.spa.temp);
    }
    var salt = state.chemistry && state.chemistry.salt;
    if ($("p3dSaltLevel")) {
      $("p3dSaltLevel").textContent = salt ? salt + " ppm (Normal)" : "3200 ppm (Configured)";
    }

    if ($("p3dMatrixCount")) {
      $("p3dMatrixCount").textContent = objects.length + " Devices";
    }

    var matrixBody = $("p3dMatrixBody");
    if (matrixBody) {
      matrixBody.innerHTML = objects.map(function (obj, idx) {
        var isOn = (obj.status === "ON" || obj.status === "10" || obj.status === "HEAT" || obj.status === "2");
        var objtype = obj.objtype || "CIRCUIT";
        var isPump = (objtype === "PUMP" || objtype === "PMPCIRC");
        var portLabel = "RELAY " + (idx + 1);
        if (objtype === "VALVE") portLabel = "VALVE " + String.fromCharCode(65 + (idx % 4));
        else if (isPump) portLabel = "COM1 (PUMP)";
        else if (objtype === "HEATER") portLabel = "FIREMAN SW";
        else if (objtype === "BODY") portLabel = "BODY SENSOR";

        var stateDisplay = isOn ? "ON" : "OFF";
        if (isPump && isOn) {
          stateDisplay = ((obj.attrs && (obj.attrs.SPEED || obj.attrs.RPM)) || "Running") + " RPM";
        }

        return '<tr>' +
          '<td><span class="relay-tag">' + escapeHtml(portLabel) + '</span></td>' +
          '<td><strong>' + escapeHtml(obj.name) + '</strong></td>' +
          '<td><span class="muted">' + escapeHtml(obj.objtype) + ' / ' + escapeHtml(obj.subtype || 'GENERIC') + '</span></td>' +
          '<td><code>' + escapeHtml(obj.objnam) + '</code></td>' +
          '<td><span class="status-indicator ' + (isOn ? 'on' : 'off') + '">' +
          '<span class="status-dot ' + (isOn ? '' : 'off') + '"></span> ' + escapeHtml(stateDisplay) +
          '</span></td>' +
          '<td><button class="btn small ' + (isOn ? 'danger' : 'primary') + ' p3d-matrix-toggle" data-objnam="' + escapeHtml(obj.objnam) + '" data-on="' + (isOn ? '0' : '1') + '">' +
          (isOn ? 'Turn Off' : 'Turn On') + '</button></td>' +
          '</tr>';
      }).join("");
    }

    if (window.panel3d) {
      window.panel3d.update(state, inv);
    }
  }

  function getIntelliCenterWebUrl() {
    if (icData && icData.connection && icData.connection.web_url) {
      return icData.connection.web_url;
    }
    if (state && state.connection && state.connection.web_url) {
      return state.connection.web_url;
    }
    var host = "";
    if (icData && icData.connection && icData.connection.host) {
      host = icData.connection.host;
    } else if (state && state.connection && state.connection.host) {
      host = state.connection.host;
    } else if (config && config.intellicenter && config.intellicenter.host) {
      host = config.intellicenter.host;
    } else if ($("icHost") && $("icHost").value.trim()) {
      host = $("icHost").value.trim();
    }
    if (!host) return "";
    if (/^https?:\/\//i.test(host)) return host;
    return "http://" + host;
  }

  async function openIntelliCenterHost() {
    var url = getIntelliCenterWebUrl();
    if (!url) {
      try {
        var res = await api("/api/intellicenter/open");
        if (res && res.url) {
          url = res.url;
        }
      } catch (err) {}
    }

    if (!url) {
      var custom = prompt(
        "No IntelliCenter host IP is currently configured or detected via mDNS.\n" +
        "Enter the Pentair IntelliCenter IP address or hostname to open:",
        "192.168.1.50"
      );
      if (custom && custom.trim()) {
        var clean = custom.trim();
        url = /^https?:\/\//i.test(clean) ? clean : "http://" + clean;
        if ($("icHost")) $("icHost").value = clean;
      } else {
        toast("IntelliCenter host address unknown. Configure host in Hardware tab.", "error");
        return;
      }
    }

    toast("Opening IntelliCenter host page: " + url, "good");
    try {
      api("/api/intellicenter/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launch: false })
      }).catch(function () {});
    } catch (e) {}

    window.open(url, "_blank", "noopener,noreferrer");
  }

  function setVizInfoPosition(pos) {
    var valid = ["below", "above", "side"];
    if (valid.indexOf(pos) === -1) pos = "below";
    var info = $("vizInfo");
    var layout = $("vizBodyLayout");
    if (!info) return;

    var targetSlot = $("vizInfoSlotBelow");
    if (pos === "above") targetSlot = $("vizInfoSlotAbove");
    else if (pos === "side") targetSlot = $("vizInfoSlotSide");

    if (targetSlot && info.parentElement !== targetSlot) {
      targetSlot.appendChild(info);
    }

    if (layout) {
      layout.classList.toggle("side", pos === "side");
    }

    document.querySelectorAll(".pos-pill").forEach(function (pill) {
      pill.classList.toggle("active", pill.getAttribute("data-pos") === pos);
    });

    localStorage.setItem("pool.vizInfoPos", pos);

    if (window.pool3d && typeof window.pool3d.resize === "function") {
      setTimeout(window.pool3d.resize, 50);
    } else {
      window.dispatchEvent(new Event("resize"));
    }
  }

  async function loadIntelliCenter() {
    try {
      var data = await api("/api/intellicenter/devices");
      icData = data;
      renderIntelliCenter();
    } catch (err) {
      toast("Error loading IntelliCenter equipment: " + err.message, "error");
    }
  }

  function renderIntelliCenter() {
    if (!icData) return;
    var inv = icData.inventory || {};
    var objects = inv.objects || [];
    var conn = icData.connection || {};
    var resolved = icData.resolved || {};

    // 1. Header status bar
    var isOnline = !!conn.connected;
    if ($("icLinkChip")) {
      $("icLinkChip").textContent = isOnline ? "PANEL ONLINE" : "SIMULATION MODE";
      $("icLinkChip").className = "chip " + (isOnline ? "live" : "simulation");
    }
    if ($("icEndpointText")) {
      $("icEndpointText").textContent = conn.host ? (conn.host + ":" + (conn.port || 6681) + " (" + (conn.transport || "tcp") + ")") : "Simulation (local baseline)";
    }
    var webUrl = getIntelliCenterWebUrl();
    if ($("icEndpointLink")) {
      if (webUrl) {
        $("icEndpointLink").href = webUrl;
        $("icEndpointLink").style.display = "inline-flex";
      } else {
        $("icEndpointLink").style.display = "none";
      }
    }
    if ($("icDeviceCount")) {
      $("icDeviceCount").textContent = objects.length;
    }
    var activeCount = 0;
    objects.forEach(function (o) {
      if (o.status === "ON" || o.status === "10" || o.status === "HEAT" || o.status === "2") {
        activeCount++;
      }
    });
    if ($("icActiveCount")) {
      $("icActiveCount").textContent = activeCount;
    }

    // Render scan report banner if present
    var scan = (icData && icData.last_scan) || (lastState && lastState.last_scan);
    if (scan && scan.scanned && $("icScanCard")) {
      $("icScanCard").style.display = "block";
      if ($("icScanSummaryText")) $("icScanSummaryText").textContent = scan.summary || "Scan complete";
      if ($("icScanTimestamp")) {
        var dtStr = scan.scanned_at ? new Date(scan.scanned_at * 1000).toLocaleTimeString() : "--";
        $("icScanTimestamp").textContent = "Scanned at " + dtStr + " (" + (scan.mode || "mode") + ")";
      }
      if ($("icScanBadges")) {
        var sc = scan.counts || {};
        var badgesHtml = '';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(0,240,255,0.15); color:var(--cyan); border:1px solid rgba(0,240,255,0.3);">🔧 ' + (sc.valves || 0) + ' Valves</span>';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3);">⚡ ' + (sc.pumps || 0) + ' Pumps</span>';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);">🔌 ' + (sc.circuits || 0) + ' Circuits</span>';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(168,85,247,0.15); color:#a855f7; border:1px solid rgba(168,85,247,0.3);">🎛️ ' + (sc.aux_relays || 0) + ' Aux Relays</span>';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3);">🔥 ' + (sc.heaters || 0) + ' Heaters</span>';
        badgesHtml += '<span class="chip" style="font-size:0.7rem; padding:2px 8px; background:rgba(236,72,153,0.15); color:#ec4899; border:1px solid rgba(236,72,153,0.3);">🧪 ' + (sc.chemistry || 0) + ' Chem</span>';
        $("icScanBadges").innerHTML = badgesHtml;
      }
      if ($("icScanAdjustmentsList")) {
        var adjList = scan.adjustments || [];
        if (adjList.length === 0) {
          $("icScanAdjustmentsList").innerHTML = "<li>Hardware aligned with current state & schedule. No adjustments needed.</li>";
        } else {
          $("icScanAdjustmentsList").innerHTML = adjList.map(function (a) {
            return "<li><strong>" + (a.target || a.category || "Adjustment") + ":</strong> " + (a.action || "") + " &mdash; <em>" + (a.result || "applied") + "</em></li>";
          }).join("");
        }
      }
    }

    // 2. Counts in category filter pills
    var counts = { all: objects.length, valves: 0, circuits: 0, relays: 0, pumps: 0, lights: 0, jets: 0, heaters: 0 };
    objects.forEach(function (o) {
      if (isDeviceInCategory(o, "valves")) counts.valves++;
      if (isDeviceInCategory(o, "circuits")) counts.circuits++;
      if (isDeviceInCategory(o, "relays")) counts.relays++;
      if (isDeviceInCategory(o, "pumps")) counts.pumps++;
      if (isDeviceInCategory(o, "lights")) counts.lights++;
      if (isDeviceInCategory(o, "jets")) counts.jets++;
      if (isDeviceInCategory(o, "heaters")) counts.heaters++;
    });
    if ($("countAll")) $("countAll").textContent = counts.all;
    if ($("countValves")) $("countValves").textContent = counts.valves;
    if ($("countCircuits")) $("countCircuits").textContent = counts.circuits;
    if ($("countRelays")) $("countRelays").textContent = counts.relays;
    if ($("countPumps")) $("countPumps").textContent = counts.pumps;
    if ($("countLights")) $("countLights").textContent = counts.lights;
    if ($("countJets")) $("countJets").textContent = counts.jets;
    if ($("countHeaters")) $("countHeaters").textContent = counts.heaters;

    // 3. Filter and render grid
    var grid = $("icDeviceGrid");
    if (grid) {
      var query = (icSearchQuery || "").toLowerCase().trim();
      var filtered = objects.filter(function (o) {
        if (!isDeviceInCategory(o, icCurrentFilter)) return false;
        if (query) {
          var name = (o.name || "").toLowerCase();
          var objnam = (o.objnam || "").toLowerCase();
          var subtype = (o.subtype || "").toLowerCase();
          var objtype = (o.objtype || "").toLowerCase();
          if (name.indexOf(query) === -1 && objnam.indexOf(query) === -1 &&
              subtype.indexOf(query) === -1 && objtype.indexOf(query) === -1) {
            return false;
          }
        }
        return true;
      });

      if (!filtered.length) {
        grid.innerHTML = '<div class="conn-detail" style="grid-column: 1 / -1; text-align: center; padding: 24px;">No equipment found matching criteria.</div>';
      } else {
        grid.innerHTML = filtered.map(function (obj) {
          var isOn = (obj.status === "ON" || obj.status === "10" || obj.status === "HEAT" || obj.status === "2");
          var objtype = obj.objtype || "CIRCUIT";
          var subtype = obj.subtype || "GENERIC";
          var isPump = (objtype === "PUMP" || objtype === "PMPCIRC");
          var isLight = (subtype === "LIGHT" || subtype === "INTELLI" || subtype === "GLOW" || subtype === "GLOWT" || subtype === "DIMMER");
          var isHeater = (objtype === "HEATER");
          var isValve = (objtype === "VALVE");
          var animRole = getDeviceAnimationRole(obj.objnam, obj.name, resolved);

          var typeClass = "type-circuit";
          if (isValve) typeClass = "type-valve";
          else if (isPump) typeClass = "type-pump";
          else if (isLight) typeClass = "type-light";
          else if (isHeater) typeClass = "type-heater";

          var statusLabel = isOn ? "ON" : "OFF";
          if (isPump && isOn) {
            var rpmVal = (obj.attrs && (obj.attrs.SPEED || obj.attrs.RPM)) || "Running";
            statusLabel = rpmVal + " RPM";
          }

          var extraHtml = "";
          if (isPump) {
            var curRpm = parseInt((obj.attrs && (obj.attrs.SPEED || obj.attrs.RPM)) || 2200, 10);
            extraHtml = '<div class="ic-extra-controls">' +
              '<div class="ic-speed-row">' +
              '<input type="range" class="ic-rpm-slider" min="450" max="3450" step="25" value="' + curRpm + '" data-objnam="' + escapeHtml(obj.objnam) + '">' +
              '<span class="ic-speed-val">' + curRpm + ' RPM</span>' +
              '<button class="btn small primary ic-apply-rpm" data-objnam="' + escapeHtml(obj.objnam) + '" style="padding: 4px 8px;">Set</button>' +
              '</div></div>';
          } else if (isLight) {
            var curAct = (obj.attrs && (obj.attrs.ACT || obj.attrs.USE)) || "BLUER";
            extraHtml = '<div class="ic-extra-controls">' +
              '<div style="display:flex; align-items:center; gap:8px;">' +
              '<select class="select ic-light-effect" data-objnam="' + escapeHtml(obj.objnam) + '" style="flex:1; padding:6px 8px; font-size:0.75rem;">' +
              Object.keys(DEFAULT_EFFECTS).map(function (k) {
                return '<option value="' + k + '"' + (k === curAct ? ' selected' : '') + '>' + DEFAULT_EFFECTS[k] + '</option>';
              }).join("") +
              '</select>' +
              '</div></div>';
          } else if (isHeater) {
            var curTemp = parseInt((obj.attrs && (obj.attrs.LOTMP || obj.attrs.SETTMP)) || 84, 10);
            extraHtml = '<div class="ic-extra-controls">' +
              '<div class="ic-speed-row">' +
              '<input type="range" class="ic-temp-slider" min="50" max="104" step="1" value="' + curTemp + '" data-objnam="' + escapeHtml(obj.objnam) + '">' +
              '<span class="ic-speed-val">' + curTemp + '°F</span>' +
              '<button class="btn small primary ic-apply-temp" data-objnam="' + escapeHtml(obj.objnam) + '" style="padding: 4px 8px;">Set</button>' +
              '</div></div>';
          } else if (isValve) {
            var pos = (obj.attrs && (obj.attrs.POSIT || obj.attrs.CIRCUIT)) || (isOn ? "Open" : "Closed");
            extraHtml = '<div class="ic-extra-controls"><span class="muted" style="font-size:0.72rem;">Valve Position: <b>' + escapeHtml(pos) + '</b></span></div>';
          }

          var deleteBtnHtml = '<button class="btn small danger ic-delete-btn" data-objnam="' + escapeHtml(obj.objnam) + '" data-name="' + escapeHtml(obj.name) + '">Delete</button>';

          return '<div class="ic-card' + (isOn ? ' is-on' : '') + '">' +
            '<div class="ic-card-head">' +
            '<div class="ic-card-title-group">' +
            '<div class="ic-card-name" title="' + escapeHtml(obj.name) + '">' + escapeHtml(obj.name) + '</div>' +
            '<div class="ic-card-badges">' +
            '<span class="ic-badge ' + typeClass + '">' + escapeHtml(objtype) + ' / ' + escapeHtml(subtype) + '</span>' +
            '<span class="ic-badge">ID: ' + escapeHtml(obj.objnam) + '</span>' +
            '</div></div>' +
            '</div>' +
            '<div>' +
            (animRole ? '<span class="ic-mapping-tag">🎯 ' + escapeHtml(animRole) + '</span>'
                      : '<span class="ic-mapping-tag unmapped">Unmapped to 3D scene</span>') +
            '</div>' +
            '<div class="ic-controls-row">' +
            '<div class="ic-status-indicator ' + (isOn ? 'on' : 'off') + '">' +
            '<span class="status-dot ' + (isOn ? '' : 'off') + '"></span>' +
            '<span>' + escapeHtml(statusLabel) + '</span>' +
            '</div>' +
            '<label class="switch">' +
            '<input type="checkbox" class="ic-power-toggle" data-objnam="' + escapeHtml(obj.objnam) + '"' + (isOn ? ' checked' : '') + '>' +
            '<span class="slider"></span>' +
            '</label>' +
            '</div>' +
            extraHtml +
            '<div class="ic-card-actions">' +
            deleteBtnHtml +
            '<button class="btn small ghost ic-edit-btn" data-objnam="' + escapeHtml(obj.objnam) + '" data-name="' + escapeHtml(obj.name) + '" data-subtype="' + escapeHtml(subtype) + '" data-objtype="' + escapeHtml(objtype) + '">Edit</button>' +
            '</div>' +
            '</div>';
        }).join("");
      }
    }

    // 4. Update manager dropdowns if active
    if (window.refreshIntelliCenterManager) window.refreshIntelliCenterManager();

    // 5. Render animation mapping section
    renderAnimationMappingForm(icData);
  }

  function renderAnimationMappingForm(data) {
    var container = $("icMappingFormGrid");
    if (!container) return;
    var inv = data.inventory || {};
    var objects = inv.objects || [];
    var mapping = data.mapping || {};

    container.innerHTML = ANIMATION_SLOTS.map(function (grp) {
      return '<div class="ic-map-group">' +
        '<div class="ic-map-group-title"><span>' + grp.icon + '</span> ' + escapeHtml(grp.group) + '</div>' +
        grp.items.map(function (item) {
          var curVal = getMappingValue(mapping, item.path);
          return '<div class="ic-map-row">' +
            '<label><span>' + escapeHtml(item.label) + '</span><small class="muted">' + escapeHtml(item.hint) + '</small></label>' +
            '<select class="select ic-map-select" data-slot="' + escapeHtml(item.path) + '">' +
            '<option value="">(None / Unmapped)</option>' +
            objects.map(function (obj) {
              var isSelected = (curVal && (curVal === obj.objnam || curVal === obj.name));
              return '<option value="' + escapeHtml(obj.name || obj.objnam) + '"' + (isSelected ? ' selected' : '') + '>' +
                '[' + escapeHtml(obj.objnam) + '] ' + escapeHtml(obj.name) + ' (' + escapeHtml(obj.objtype) + (obj.subtype ? '/' + escapeHtml(obj.subtype) : '') + ')' +
                '</option>';
            }).join("") +
            '</select></div>';
        }).join("") +
        '</div>';
    }).join("");
  }

  function autoDetectAnimationMapping() {
    if (!icData || !icData.inventory) return;
    var objects = icData.inventory.objects || [];
    var selects = document.querySelectorAll(".ic-map-select");
    var matchedCount = 0;

    function findMatchingObj(tokens, preferredTypes) {
      var scored = [];
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var name = (obj.name || "").toLowerCase();
        var type = (obj.objtype || "").toUpperCase();
        var sub = (obj.subtype || "").toUpperCase();
        var score = 0;

        if (preferredTypes && preferredTypes.indexOf(type) !== -1) {
          score += 2;
        }
        var allMatch = true;
        for (var t = 0; t < tokens.length; t++) {
          if (name.indexOf(tokens[t]) !== -1) {
            score += 3;
          } else {
            allMatch = false;
          }
        }
        if (allMatch) score += 5;
        if (score > 3) scored.push({ score: score, obj: obj });
      }
      if (!scored.length) return null;
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored[0].obj;
    }

    selects.forEach(function (sel) {
      var slot = sel.getAttribute("data-slot");
      var matched = null;

      if (slot === "modes.pool") matched = findMatchingObj(["pool"], ["CIRCUIT"]);
      else if (slot === "modes.spa") matched = findMatchingObj(["spa"], ["CIRCUIT"]);
      else if (slot === "bodies.pool") matched = findMatchingObj(["pool"], ["BODY"]);
      else if (slot === "bodies.spa") matched = findMatchingObj(["spa"], ["BODY"]);
      else if (slot === "pumps.main") matched = findMatchingObj(["main"], ["PUMP"]);
      else if (slot === "pumps.features") matched = findMatchingObj(["feature"], ["PUMP"]);
      else if (slot === "pump_programs.main") matched = findMatchingObj(["main"], ["PMPCIRC", "CIRCUIT"]);
      else if (slot === "pump_programs.features") matched = findMatchingObj(["feature"], ["PMPCIRC", "CIRCUIT"]);
      else if (slot === "deck_jets.ne.water") matched = findMatchingObj(["ne", "jet"], ["CIRCUIT"]);
      else if (slot === "deck_jets.ne.light") matched = findMatchingObj(["deck", "light"], ["CIRCUIT"]);
      else if (slot === "deck_jets.ne.thumper") matched = findMatchingObj(["thump"], ["CIRCUIT"]);
      else if (slot === "deck_jets.nw.water") matched = findMatchingObj(["nw", "jet"], ["CIRCUIT"]);
      else if (slot === "deck_jets.nw.light") matched = findMatchingObj(["deck", "light"], ["CIRCUIT"]);
      else if (slot === "deck_jets.nw.thumper") matched = findMatchingObj(["thump"], ["CIRCUIT"]);
      else if (slot === "deck_jets.se.water") matched = findMatchingObj(["se", "jet"], ["CIRCUIT"]);
      else if (slot === "deck_jets.se.light") matched = findMatchingObj(["deck", "light"], ["CIRCUIT"]);
      else if (slot === "deck_jets.se.thumper") matched = findMatchingObj(["thump"], ["CIRCUIT"]);
      else if (slot === "deck_jets.sw.water") matched = findMatchingObj(["sw", "jet"], ["CIRCUIT"]);
      else if (slot === "deck_jets.sw.light") matched = findMatchingObj(["deck", "light"], ["CIRCUIT"]);
      else if (slot === "deck_jets.sw.thumper") matched = findMatchingObj(["thump"], ["CIRCUIT"]);
      else if (slot === "firebaskets.east.burner") matched = findMatchingObj(["east", "burner"], ["CIRCUIT"]);
      else if (slot === "firebaskets.east.water") matched = findMatchingObj(["pool", "fountain", "e"], ["CIRCUIT"]);
      else if (slot === "firebaskets.east.spa_water") matched = findMatchingObj(["spa", "fountain", "e"], ["CIRCUIT"]);
      else if (slot === "firebaskets.east.burner_light" || slot === "firebaskets.west.burner_light") matched = findMatchingObj(["burner", "light"], ["CIRCUIT"]);
      else if (slot === "firebaskets.west.burner") matched = findMatchingObj(["west", "burner"], ["CIRCUIT"]);
      else if (slot === "firebaskets.west.water") matched = findMatchingObj(["pool", "fountain", "w"], ["CIRCUIT"]);
      else if (slot === "firebaskets.west.spa_water") matched = findMatchingObj(["spa", "fountain", "w"], ["CIRCUIT"]);
      else if (slot === "blower.circuit") matched = findMatchingObj(["blower"], ["CIRCUIT"]);
      else if (slot === "lights.pool") matched = findMatchingObj(["pool", "light"], ["CIRCUIT"]);
      else if (slot === "lights.spa") matched = findMatchingObj(["spa", "light"], ["CIRCUIT"]);
      else if (slot === "valves.drain") matched = findMatchingObj(["drain"], ["VALVE", "CIRCUIT"]);
      else if (slot === "valves.return") matched = findMatchingObj(["return"], ["VALVE", "CIRCUIT"]);
      else if (slot === "heater.device") matched = findMatchingObj(["heater"], ["HEATER", "CIRCUIT"]);
      else if (slot === "heater.body") matched = findMatchingObj(["pool"], ["BODY"]);

      if (matched) {
        sel.value = matched.name || matched.objnam;
        matchedCount++;
      }
    });

    toast("Auto-detected and mapped " + matchedCount + " equipment slots! Click Save Animation Mappings to apply.", "good");
  }

  async function saveAnimationMappingFromUI() {
    var selects = document.querySelectorAll(".ic-map-select");
    var mapping = {
      bodies: {},
      modes: {},
      pumps: {},
      pump_programs: {},
      deck_jets: { ne: {}, nw: {}, se: {}, sw: {} },
      firebaskets: { east: {}, west: {} },
      blower: {},
      lights: {},
      valves: {},
      heater: {}
    };

    selects.forEach(function (sel) {
      var slot = sel.getAttribute("data-slot");
      var val = sel.value.trim();
      setMappingValue(mapping, slot, val);
    });

    try {
      var result = await api("/api/intellicenter/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devices: mapping })
      });
      if (result && result.state) {
        state = result.state;
        render();
      }
      toast(result.message || "Animation mapping saved!", "good");
      await loadIntelliCenter();
    } catch (err) {
      toast("Error saving animation mapping: " + err.message, "error");
    }
  }

  async function loadAlexa() {
    try {
      var data = await api("/api/alexa");
      var devices = data.devices || [];
      if ($("alexaCount")) $("alexaCount").textContent = devices.length;
      var grid = $("alexaCardGrid");
      if (grid) {
        grid.innerHTML = devices.map(function (d) {
          var isPowerOn = d.state === "ON" || d.state === "HEAT";
          var utterance = '“Alexa, turn ' + (isPowerOn ? 'off ' : 'on ') + d.friendlyName + '”';
          return '<div class="alexa-card">' +
            '<div class="alexa-card-head">' +
            '<div class="alexa-card-name">' + escapeHtml(d.friendlyName) + '</div>' +
            '<span class="alexa-cat-pill">' + escapeHtml(d.category) + '</span>' +
            '</div>' +
            '<div class="alexa-card-utterance">' + escapeHtml(utterance) + '</div>' +
            '<div class="alexa-card-state ' + (isPowerOn ? 'on' : 'off') + '">' +
            '<span class="status-dot ' + (isPowerOn ? '' : 'off') + '"></span>' +
            '<span>State: ' + escapeHtml(d.state || 'OFF') + '</span>' +
            '</div>' +
            '</div>';
        }).join("");
      }
      if ($("alexaDirectUrl") && data.endpoint) {
        $("alexaDirectUrl").textContent = location.origin + data.endpoint;
      }
    } catch (err) {
      if ($("alexaCardGrid")) $("alexaCardGrid").textContent = "Alexa preview unavailable: " + err.message;
    }
  }

  // ------------------------------------------------------------------
  // Bind
  // ------------------------------------------------------------------
  function buildFeatureCards() {
    var jets = $("deckJets");
    if (jets) {
      jets.innerHTML = ["ne", "nw", "se", "sw"].map(function (key) {
        return '<div class="feature-card" data-jet="' + key + '">' +
          '<div class="feature-head"><div><div class="feature-title">' + key.toUpperCase() +
          ' Floor Jet</div><div class="feature-sub">' + key.toUpperCase() + ' laminar floor jet</div></div>' +
          '<label class="switch"><input type="checkbox" data-toggle="jet"><span class="slider"></span></label></div>' +
          '</div>';
      }).join("");
    }
    var baskets = $("firebaskets");
    if (baskets) {
      baskets.innerHTML = ["east", "west"].map(function (key) {
        var title = key === "east" ? "East Firepit" : "West Firepit";
        return '<div class="feature-card fire" data-basket="' + key + '">' +
          '<div class="feature-head"><div><div class="feature-title">' + title +
          '</div><div class="feature-sub" data-sub="firebasket">Spillways &amp; flame off</div></div>' +
          '<div class="fire-flame-toggle" title="Firepit Flame">' +
          '<label class="switch mini"><input type="checkbox" data-toggle="flame"><span class="slider"></span></label>' +
          '<span class="flame-label">Flame</span>' +
          '</div></div>' +
          '<div class="spillway-controls">' +
          '<div class="spillway-toggle-row">' +
          '<span>Pool Spillway</span>' +
          '<label class="switch"><input type="checkbox" data-spillway="pool"><span class="slider"></span></label>' +
          '</div>' +
          '<div class="spillway-toggle-row">' +
          '<span>Spa Spillway</span>' +
          '<label class="switch"><input type="checkbox" data-spillway="spa"><span class="slider"></span></label>' +
          '</div>' +
          '<div class="spillway-toggle-row" title="AUX 1 lights the LED strips under both burners together">' +
          '<span>Burner Lights</span>' +
          '<label class="switch"><input type="checkbox" data-toggle="burner-light"><span class="slider"></span></label>' +
          '</div>' +
          '</div></div>';
      }).join("");
    }
  }

  async function loadWiring() {
    var body = $("icWiringBody");
    if (!body) return;
    try {
      var data = await api("/api/intellicenter/wiring");
      var r = data.report || {};
      body.innerHTML = data.html || "No equipment reported.";
      if ($("icWiringSummary")) {
        $("icWiringSummary").textContent = (r.total || 0) + " devices on " + (r.panel || "IntelliCenter") +
          (r.host ? " at " + r.host : "") + (r.connected ? "" : " \u00B7 panel offline, showing last known data") +
          " \u00B7 updated " + (r.generated || "");
      }
    } catch (err) {
      body.textContent = "Could not load the equipment list: " + err.message;
    }
  }

  // Camera views: the Live tab's full-size video and the Control tab's
  // webcam card. Each uses the shared MJPEG stream first (over the Cloudflare
  // tunnel each separate request costs a full round trip, so polling single
  // frames manages only ~2 fps) and falls back to fetching frames one at a
  // time. A view only runs while it is on screen, so at most one is active.
  function makeCameraView(imgId, wanted, onStatus) {
    var v = { running: false, mode: null, timer: null, url: null };
    function el() { return $(imgId); }
    function status(text) { if (onStatus) onStatus(text); }
    function frames() {
      if (!wanted()) { stop(); return; }
      var started = Date.now();
      fetch("/api/camera/frame?t=" + started, { cache: "no-store" }).then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.blob();
      }).then(function (blob) {
        var img = el();
        if (img && wanted()) {
          var url = URL.createObjectURL(blob);
          img.onload = function () {
            if (v.url && v.url !== url) URL.revokeObjectURL(v.url);
            v.url = url;
            status("LIVE");
          };
          img.src = url;
        }
        v.timer = setTimeout(frames, Math.max(0, 100 - (Date.now() - started)));
      }).catch(function () {
        status("STANDBY");
        v.timer = setTimeout(frames, 2000);
      });
    }
    function startStream() {
      var img = el();
      if (!img) return;
      v.mode = "stream";
      status("LIVE");
      img.onload = null;
      img.onerror = function () {
        if (!wanted() || v.mode !== "stream") return;
        v.mode = "frames";
        img.onerror = null;
        img.removeAttribute("src");
        frames();
      };
      img.src = "/api/camera/stream?t=" + Date.now();
    }
    function stop() {
      clearTimeout(v.timer);
      v.running = false;
      v.mode = null;
      var img = el();
      if (img) { img.onerror = null; img.onload = null; img.removeAttribute("src"); }  // closes the stream
      if (v.url) { URL.revokeObjectURL(v.url); v.url = null; }
    }
    return {
      update: function () {
        if (wanted()) {
          if (!v.running) { v.running = true; startStream(); }
        } else if (v.running) {
          stop();
        }
      }
    };
  }

  function controlViewShown() {
    var view = $("view-control");
    return !!view && view.classList.contains("active") && !document.hidden && canSeeCamera();
  }
  var liveView = makeCameraView("liveVideo", function () {
    return controlViewShown() && document.body.classList.contains("live-mode");
  });
  var cardView = makeCameraView("poolLiveVideo", function () {
    return controlViewShown() && !document.body.classList.contains("live-mode");
  }, function (text) {
    if ($("camStatusText")) $("camStatusText").textContent = text;
  });

  function updateLiveVideo() {
    liveView.update();
    cardView.update();
  }

  function activateTab(name) {
    var wanted = name || "control";
    var view = wanted === "live" ? "control" : wanted;
    var found = null;
    document.querySelectorAll(".tab").forEach(function (tab) {
      var isActive = tab.getAttribute("data-tab") === wanted;
      tab.classList.toggle("active", isActive);
      if (isActive) found = tab;
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + view);
    });
    document.body.classList.toggle("live-mode", wanted === "live");
    updateLiveVideo();
    if (window.pool3d && typeof window.pool3d.resize === "function") {
      setTimeout(window.pool3d.resize, 50);
    }
    if (!found) return;
    if (wanted === "intellicenter") {
      loadIntelliCenter();
      loadWiring();
    } else if (wanted === "panel") {
      loadIntelliCenter3D();
      if (window.panel3d) {
        setTimeout(function () {
          window.panel3d.init();
          window.panel3d.update(state, icData ? icData.inventory : null);
        }, 50);
      }
    } else if (wanted === "logic") {
      renderPoolLogic();
    } else if (wanted === "alexa") {
      loadAlexa();
    } else if (wanted === "setup") {
      refreshInventory();
      loadAlexa();
    }
  }


  // ------------------------------------------------------------------
  // Pool Logic Visualization & Simulation Engine
  // ------------------------------------------------------------------
  var logicLogs = [];

  function logLogicEvent(rule, message) {
    var ts = new Date().toLocaleTimeString();
    var entry = "[" + ts + "] [" + rule + "] " + message;
    logicLogs.unshift(entry);
    if (logicLogs.length > 50) logicLogs.pop();
    var box = $("logicLogBox");
    if (box) {
      box.innerHTML = logicLogs.map(function (l) { return "<div>" + escapeHtml(l) + "</div>"; }).join("");
    }
  }

  function renderPoolLogic() {
    var mode = (state && state.mode) || "pool";
    var isSpa = mode === "spa";
    var bodies = (state && state.bodies) || {};
    var pumps = (state && state.pumps) || {};
    var mainP = pumps.main || {};
    var featP = pumps.features || {};
    var heater = (state && state.heater) || {};
    var blower = (state && state.blower) || {};
    var jets = (state && state.deck_jets) || {};
    var baskets = (state && state.firebaskets) || {};
    var chem = (state && state.chemistry) || {};

    var poolTemp = bodies.pool && bodies.pool.temp;
    var spaTemp = bodies.spa && bodies.spa.temp;
    var mainOn = !!mainP.on;
    var mainRpm = parseInt(mainP.rpm || 2200, 10);
    var featOn = !!featP.on;
    var featRpm = parseInt(featP.rpm || 2050, 10);
    var heaterOn = !!heater.on;
    var blowerOn = !!blower.on;
    var anyFeaturesOn = Object.values(jets).some(function (j) { return j.on; }) || Object.values(baskets).some(function (b) { return b.water || b.spa_water; });

    // Update Status Bar
    if ($("logicModeBadge")) {
      $("logicModeBadge").textContent = (isSpa ? "SPA MODE (HYDROTHERAPY)" : "POOL MODE (FILTRATION)");
      $("logicModeBadge").className = "chip live" + (isSpa ? " spa" : "");
    }
    if ($("logicStatMode")) {
      $("logicStatMode").textContent = isSpa ? "SPA (100% ISOLATED)" : "POOL (80/20 SPILLOVER)";
      $("logicStatMode").style.color = isSpa ? "#f59e0b" : "var(--cyan)";
    }
    if ($("logicStatMainPump")) {
      $("logicStatMainPump").textContent = mainRpm + " RPM (" + (mainOn ? "RUNNING" : "STOPPED") + ")";
      $("logicStatMainPump").style.color = mainOn ? "#10b981" : "var(--muted)";
    }
    if ($("logicStatFeatPump")) {
      $("logicStatFeatPump").textContent = featOn ? featRpm + " RPM (ACTIVE)" : "OFF (IDLE)";
      $("logicStatFeatPump").style.color = featOn ? "#10b981" : "var(--muted)";
    }

    // Gate 1: Mode Switch
    if ($("pillGateMode")) {
      $("pillGateMode").textContent = isSpa ? "SPA 100% ISOLATED" : "POOL 80/20 SPILLWAY";
      $("pillGateMode").style.background = isSpa ? "rgba(245,158,11,0.2)" : "rgba(0,240,255,0.15)";
      $("pillGateMode").style.color = isSpa ? "#f59e0b" : "var(--cyan)";
    }
    if ($("descGateMode")) {
      $("descGateMode").textContent = isSpa
        ? "Suction drawn 100% from spa bottom drain, discharge returning 100% to spa hydrotherapy jets."
        : "Suction drawn 80% from pool skimmer/drain, discharge returning 80% to spa with overflow cascade spillway.";
    }

    // Gate 2: Heater Flow Interlock
    var flowOk = mainOn && mainRpm >= 1500;
    if ($("logicStatHeaterFlow")) {
      $("logicStatHeaterFlow").textContent = flowOk ? "CLOSED (FLOW OK)" : "OPEN (NO FLOW)";
      $("logicStatHeaterFlow").style.color = flowOk ? "#10b981" : "#ef4444";
    }
    if ($("pillGateHeater")) {
      if (heaterOn && !flowOk) {
        $("pillGateHeater").textContent = "TRIPPED (LOW FLOW)";
        $("pillGateHeater").style.background = "rgba(239,68,68,0.2)";
        $("pillGateHeater").style.color = "#ef4444";
      } else if (heaterOn && flowOk) {
        $("pillGateHeater").textContent = "HEATING";
        $("pillGateHeater").style.background = "rgba(245,158,11,0.25)";
        $("pillGateHeater").style.color = "#f59e0b";
      } else {
        $("pillGateHeater").textContent = "SAFE (READY)";
        $("pillGateHeater").style.background = "rgba(16,185,129,0.15)";
        $("pillGateHeater").style.color = "#10b981";
      }
    }

    // Gate 3: Blower Lockout
    if ($("logicStatBlowerLock")) {
      $("logicStatBlowerLock").textContent = isSpa ? (blowerOn ? "ENERGIZED (ON)" : "UNLOCKED (STANDBY)") : "LOCKED (POOL MODE)";
      $("logicStatBlowerLock").style.color = isSpa ? "#10b981" : "#8ab";
    }
    if ($("pillGateBlower")) {
      $("pillGateBlower").textContent = isSpa ? (blowerOn ? "ACTIVE" : "STANDBY") : "LOCKED OUT";
      $("pillGateBlower").style.background = isSpa ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.15)";
      $("pillGateBlower").style.color = isSpa ? "#10b981" : "#fca5a5";
    }

    // Gate 4: Features Pump Interlock
    if ($("pillGateFeatures")) {
      $("pillGateFeatures").textContent = anyFeaturesOn ? ("ACTIVE (" + featRpm + " RPM)") : "IDLE (0 ON)";
      $("pillGateFeatures").style.background = anyFeaturesOn ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.06)";
      $("pillGateFeatures").style.color = anyFeaturesOn ? "#10b981" : "#8ab";
    }

    // Sensor node values
    if ($("valLogicPoolTemp")) $("valLogicPoolTemp").textContent = poolTemp ? (poolTemp + "°F") : "84°F (Set: 84°F)";
    if ($("valLogicSpaTemp")) $("valLogicSpaTemp").textContent = spaTemp ? (spaTemp + "°F") : "102°F (Set: 102°F)";
    if ($("valLogicFlow")) $("valLogicFlow").textContent = flowOk ? ("FLOW OK (" + mainRpm + " RPM >= 1500)") : "FLOW LOW (< 1500 RPM)";
    if ($("valLogicSalt")) $("valLogicSalt").textContent = chem.salt ? (chem.salt + " PPM (target 3200)") : "--";
    var activeRunName = (state && state.schedule && state.schedule.active_run) || "Main VSR daytime";
    if ($("valLogicSchedule")) $("valLogicSchedule").textContent = "Active: " + activeRunName;

    // Actuators
    if ($("valActuatorSuction")) $("valActuatorSuction").textContent = isSpa ? "100% Spa Drain" : "80% Pool / 20% Spa";
    if ($("valActuatorReturn")) $("valActuatorReturn").textContent = isSpa ? "100% Spa Return Jets" : "80% Spa (Spillway) / 20% Pool";
    if ($("valActuatorMainPump")) $("valActuatorMainPump").textContent = mainOn ? (mainRpm + " RPM • RUNNING") : "STOPPED (0 RPM)";
    if ($("valActuatorFeatPump")) $("valActuatorFeatPump").textContent = featOn ? (featRpm + " RPM • ACTIVE") : "OFF (0 RPM)";
    if ($("valActuatorHeater")) $("valActuatorHeater").textContent = heaterOn ? "ON" : "OFF";
    if ($("valActuatorChlor")) $("valActuatorChlor").textContent = mainOn ? "Running with pump flow" : "Standby (no pump flow)";
  }

  function initPoolLogicVisualization() {
    document.querySelectorAll(".logic-scenario-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var scenario = btn.getAttribute("data-scenario");
        btn.disabled = true;
        try {
          if (scenario === "pool_day") {
            logLogicEvent("SCENARIO", "Executing Daytime Pool Filtration: Pool Mode, Main Pump @ 2200 RPM");
            await command("set_mode", { mode: "pool" });
            await command("set_pump", { pump: "main", on: true, rpm: 2200 });
            toast("Daytime filtration scenario applied", "good");
          } else if (scenario === "spa_session") {
            logLogicEvent("SCENARIO", "Executing Spa Hydrotherapy: Spa Mode, Gas Heater ON @ 102°F, Blower ON");
            await command("set_mode", { mode: "spa" });
            await command("set_heater", { on: true, setpoint: 102 });
            await command("set_blower", { on: true });
            toast("Spa hydrotherapy scenario applied", "good");
          } else if (scenario === "water_show") {
            logLogicEvent("SCENARIO", "Executing Water & Light Show: Features Pump 2800 RPM, Laminars ON, Firebaskets ON, Party Lights");
            await command("set_deck_jet", { id: "ne", on: true });
            await command("set_deck_jet", { id: "nw", on: true });
            await command("set_firebasket", { id: "east", on: true });
            await command("set_light", { body: "pool", on: true, effect: "PARTY" });
            toast("Water & light show scenario applied", "good");
          } else if (scenario === "freeze_safety") {
            logLogicEvent("SAFETY", "Simulating Freeze Protection (Ambient 35°F <= 36°F): Circulating all lines at 2400 RPM");
            await command("set_pump", { pump: "main", on: true, rpm: 2400 });
            toast("Freeze safety simulation engaged", "good");
          } else if (scenario === "all_off") {
            logLogicEvent("SAFETY", "Emergency All-Off: Disengaging heater, features, and pumps immediately");
            await command("system_off", {});
            toast("All equipment stopped", "good");
          } else if (scenario === "realign") {
            logLogicEvent("SCAN", "Re-scanning IntelliCenter hardware and re-aligning state");
            await api("/api/intellicenter/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
            toast("Hardware scanned and realigned", "good");
          }
          await refresh();
          renderPoolLogic();
        } catch (err) {
          toast("Scenario failed: " + err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });

    if ($("clearLogicLogBtn")) {
      $("clearLogicLogBtn").addEventListener("click", function () {
        logicLogs = [];
        if ($("logicLogBox")) $("logicLogBox").innerHTML = '<div style="color:var(--muted)">Log cleared. Listening for state transitions...</div>';
      });
    }

    logLogicEvent("SYSTEM", "Pool Logic & Simulation Engine initialized. All safety interlocks monitored.");
    renderPoolLogic();
  }

  // ------------------------------------------------------------------
  // Interactive IntelliCenter Manager (Add, Edit, Delete, Schedules, Valves, Relays, Pumps, Chlorinator, Lights)
  // ------------------------------------------------------------------
  function initIntelliCenterManager() {
    var catSelect = $("icMgrCategory");
    var actSelect = $("icMgrAction");
    var targetSelect = $("icMgrTargetSelect");
    var targetLabel = $("icMgrTargetLabel");
    var formBox = $("icMgrFormContainer");
    var submitBtn = $("icMgrSubmitBtn");
    var resetBtn = $("icMgrResetBtn");

    if (!catSelect || !actSelect || !formBox) return;

    function getItemsForCategory(cat) {
      var inv = (icData && icData.inventory) || {};
      var objects = inv.objects || [];
      if (cat === "valves") {
        return objects.filter(function (o) { return o.objtype === "VALVE" || (o.objnam && o.objnam.indexOf("V") === 0); });
      }
      if (cat === "relays") {
        return objects.filter(function (o) {
          var name = (o.name || "").toLowerCase();
          var sub = (o.subtype || "").toUpperCase();
          return sub === "RELAY" || sub === "AUX" || name.indexOf("aux") !== -1 || name.indexOf("relay") !== -1 || o.objtype === "CIRCUIT";
        });
      }
      if (cat === "pumps") {
        return objects.filter(function (o) { return o.objtype === "PUMP" || (o.objnam && o.objnam.indexOf("P") === 0); });
      }
      if (cat === "lights") {
        return objects.filter(function (o) {
          var sub = (o.subtype || "").toUpperCase();
          var name = (o.name || "").toLowerCase();
          return sub === "INTELLI" || sub === "LIGHT" || sub === "GLOW" || sub === "GLOWT" || name.indexOf("light") !== -1;
        });
      }
      if (cat === "chlorinator") {
        return objects.filter(function (o) { return o.objtype === "CHEM" || (o.objnam && o.objnam.indexOf("CH") === 0); });
      }
      if (cat === "schedules") {
        var runs = (state && state.schedule && state.schedule.runs) || [];
        return runs.map(function (r, idx) {
          return { objnam: "run_" + idx, name: (r.name || "Run " + (idx + 1)) + " (" + (r.start || "08:00") + "-" + (r.end || "18:00") + " @ " + (r.rpm || 2200) + " RPM)", index: idx, run: r };
        });
      }
      return objects;
    }

    function renderManagerForm() {
      var cat = catSelect.value || "valves";
      var act = actSelect.value || "add";
      var items = getItemsForCategory(cat);

      var showTarget = (act !== "add" || cat === "chlorinator");
      if (targetLabel) targetLabel.style.display = showTarget ? "flex" : "none";

      if (targetSelect && showTarget) {
        var prevVal = targetSelect.value;
        targetSelect.innerHTML = items.map(function (item) {
          return '<option value="' + escapeHtml(item.objnam || "") + '">' + escapeHtml(item.name || item.objnam) + '</option>';
        }).join("");
        if (prevVal && items.some(function (i) { return i.objnam === prevVal; })) {
          targetSelect.value = prevVal;
        } else if (items.length) {
          targetSelect.value = items[0].objnam;
        }
      }

      var selectedId = (targetSelect && targetSelect.value) || (items[0] && items[0].objnam);
      var selectedItem = items.find(function (i) { return i.objnam === selectedId; }) || items[0] || {};
      var attrs = selectedItem.attrs || {};

      var formHtml = "";

      if (act === "delete") {
        formHtml = '<div style="color:#ef4444; font-size:0.85rem; padding:8px 0;">' +
          '⚠️ <strong>Delete Confirmation:</strong> Are you sure you want to delete <strong>' +
          escapeHtml(selectedItem.name || selectedItem.objnam || "this item") + '</strong> (' + escapeHtml(selectedId || "") + ') from the IntelliCenter?' +
          '</div>';
      } else if (cat === "schedules") {
        var r = (selectedItem && selectedItem.run) || {};
        var rName = act === "add" ? "New Pump Schedule" : (r.name || "Main VSR Run");
        var rStart = act === "add" ? "08:00" : (r.start || "08:00");
        var rEnd = act === "add" ? "18:00" : (r.end || "18:00");
        var rRpm = act === "add" ? 2200 : (r.rpm || 2200);
        var rDays = (act === "add" ? ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] : (r.days || ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]));

        var daysHtml = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(function (d) {
          var checked = rDays.indexOf(d) >= 0 ? " checked" : "";
          return '<label style="display:inline-flex; align-items:center; gap:4px; font-size:0.75rem; color:#cbd5e1; cursor:pointer;">' +
            '<input type="checkbox" class="ic-mgr-day" value="' + d + '"' + checked + '> ' + d.toUpperCase() +
            '</label>';
        }).join(" ");

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Schedule Name' +
          '<input type="text" id="icMgrSchName" class="form-input" value="' + escapeHtml(rName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Target Equipment' +
          '<select id="icMgrSchTarget" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="main">MAIN PUMP (Filtration VSR)</option>' +
          '<option value="features">FEATURES PUMP (Water Features VSR)</option>' +
          '<option value="aux">AUX RELAY (Cleaner / Feature)</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Start Time' +
          '<input type="time" id="icMgrSchStart" class="form-input" value="' + escapeHtml(rStart) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">End Time' +
          '<input type="time" id="icMgrSchEnd" class="form-input" value="' + escapeHtml(rEnd) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Pump Speed (RPM)' +
          '<input type="number" id="icMgrSchRpm" min="450" max="3450" step="25" class="form-input" value="' + rRpm + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<div style="grid-column: 1 / -1; margin-top:4px;">' +
          '<div style="font-size:0.75rem; color:#cbd5e1; margin-bottom:4px;">Operating Days:</div>' +
          '<div style="display:flex; gap:10px; flex-wrap:wrap;">' + daysHtml + '</div>' +
          '</div>' +
          '</div>';
      } else if (cat === "chlorinator") {
        var saltPpm = (state.chemistry && state.chemistry.salt) || parseInt(attrs.SALT || 3200, 10);
        var chlorPct = parseInt(attrs.CHLOR || attrs.CHLORREQ || 60, 10);
        var isSuper = (attrs.SUPER === "ON");

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Sanitizer Output Level (0% - 100%)' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
          '<input type="range" id="icMgrChlorSlider" min="0" max="100" step="5" value="' + chlorPct + '" style="flex:1;">' +
          '<span id="icMgrChlorVal" style="font-weight:700; color:var(--cyan); width:45px;">' + chlorPct + '%</span>' +
          '</div>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Target Salt Salinity (PPM)' +
          '<input type="number" id="icMgrSaltPpm" min="2000" max="4500" step="50" class="form-input" value="' + saltPpm + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Super Chlorinate (24-Hour Shock)' +
          '<div style="display:flex; align-items:center; gap:8px; margin-top:4px;">' +
          '<label class="switch"><input type="checkbox" id="icMgrSuperChlor"' + (isSuper ? ' checked' : '') + '><span class="slider"></span></label>' +
          '<span style="font-size:0.78rem; color:#f59e0b; font-weight:600;">24-Hr Maximum Chlorine Boost</span>' +
          '</div>' +
          '</label>' +
          '<div style="grid-column:1 / -1; font-size:0.75rem; color:#8ab; background:rgba(0,240,255,0.06); padding:8px; border-radius:6px;">' +
          '📊 <strong>Live IntelliChlor Diagnostics:</strong> Current Salt: <b>' + saltPpm + ' PPM</b> (Optimal: 2800-3600 PPM) &bull; Cell Status: <b>' + (attrs.QUALTY || "GOOD") + '</b> &bull; Flow Switch: <b>' + (attrs.FLOW || "OK") + '</b>' +
          '</div>' +
          '</div>';
      } else if (cat === "valves") {
        var vName = act === "add" ? "Water Feature 3-Way Valve" : (selectedItem.name || "Valve Actuator");
        var curPos = (attrs.POSIT || attrs.CIRCUIT || "POOL").toUpperCase();

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Valve Name' +
          '<input type="text" id="icMgrValveName" class="form-input" value="' + escapeHtml(vName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Valve Port Socket' +
          '<select id="icMgrValvePort" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="V_A">Valve Socket A (Intake/Suction)</option>' +
          '<option value="V_B">Valve Socket B (Return/Discharge)</option>' +
          '<option value="V_SOLAR">Solar Valve Socket</option>' +
          '<option value="V_AUX1">Aux Valve Socket 1</option>' +
          '<option value="V_AUX2">Aux Valve Socket 2</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Target Position' +
          '<select id="icMgrValvePos" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="POOL"' + (curPos === "POOL" ? ' selected' : '') + '>POOL Circulation (80/20 Spillway)</option>' +
          '<option value="SPA"' + (curPos === "SPA" ? ' selected' : '') + '>SPA Hydrotherapy (100% Isolated)</option>' +
          '<option value="SOLAR"' + (curPos === "SOLAR" ? ' selected' : '') + '>Solar Heating Flow</option>' +
          '<option value="OFF"' + (curPos === "OFF" ? ' selected' : '') + '>Closed / Off</option>' +
          '</select>' +
          '</label>' +
          '</div>';
      } else if (cat === "pumps") {
        var pName = act === "add" ? "Secondary VSR Pump" : (selectedItem.name || "MAIN PUMP");
        var curSpeed = parseInt(attrs.SPEED || attrs.RPM || 2200, 10);
        var pOn = (selectedItem.status === "10" || attrs.STATUS === "10");

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Pump Name' +
          '<input type="text" id="icMgrPumpName" class="form-input" value="' + escapeHtml(pName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Pump Model &amp; Type' +
          '<select id="icMgrPumpType" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="VS">Pentair IntelliFlo VSF (Variable Speed &amp; Flow)</option>' +
          '<option value="2SPD">Two-Speed Pump</option>' +
          '<option value="1SPD">Single-Speed Pump</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Speed RPM (450 - 3450)' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
          '<input type="range" id="icMgrPumpSlider" min="450" max="3450" step="25" value="' + curSpeed + '" style="flex:1;">' +
          '<span id="icMgrPumpSpeedVal" style="font-weight:700; color:var(--cyan); width:70px;">' + curSpeed + ' RPM</span>' +
          '</div>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Power State' +
          '<div style="display:flex; align-items:center; gap:8px; margin-top:4px;">' +
          '<label class="switch"><input type="checkbox" id="icMgrPumpPower"' + (pOn ? ' checked' : '') + '><span class="slider"></span></label>' +
          '<span style="font-size:0.78rem; color:#10b981;">Pump Motor Running</span>' +
          '</div>' +
          '</label>' +
          '<div style="grid-column:1 / -1; display:flex; gap:6px; align-items:center; margin-top:4px;">' +
          '<span style="font-size:0.75rem; color:#8ab;">Speed Presets:</span>' +
          '<button type="button" class="btn small ic-mgr-preset" data-rpm="1200" style="padding:2px 8px; font-size:0.7rem;">1200 Eco</button>' +
          '<button type="button" class="btn small ic-mgr-preset" data-rpm="2200" style="padding:2px 8px; font-size:0.7rem;">2200 Clean</button>' +
          '<button type="button" class="btn small ic-mgr-preset" data-rpm="2800" style="padding:2px 8px; font-size:0.7rem;">2800 High</button>' +
          '<button type="button" class="btn small ic-mgr-preset" data-rpm="3450" style="padding:2px 8px; font-size:0.7rem;">3450 Max</button>' +
          '</div>' +
          '</div>';
      } else if (cat === "lights") {
        var lName = act === "add" ? "Landscape Patio Lights" : (selectedItem.name || "POOL LIGHT");
        var lEffect = (attrs.ACT || attrs.USE || "BLUER").toUpperCase();
        var lOn = (selectedItem.status === "ON");

        var effectsOpts = Object.keys(DEFAULT_EFFECTS).map(function (k) {
          return '<option value="' + k + '"' + (k === lEffect ? ' selected' : '') + '>' + DEFAULT_EFFECTS[k] + '</option>';
        }).join("");

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Light Name' +
          '<input type="text" id="icMgrLightName" class="form-input" value="' + escapeHtml(lName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Light Type' +
          '<select id="icMgrLightType" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="INTELLI">Pentair IntelliBrite 5G (Color LED)</option>' +
          '<option value="GLOW">Pentair GloBrite / ColorCascade</option>' +
          '<option value="LIGHT">Standard 120V/12V White Light Relay</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Color Program / Light Effect' +
          '<select id="icMgrLightEffect" class="select" style="padding:6px; font-size:0.8rem;">' + effectsOpts + '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Power Switch' +
          '<div style="display:flex; align-items:center; gap:8px; margin-top:4px;">' +
          '<label class="switch"><input type="checkbox" id="icMgrLightPower"' + (lOn ? ' checked' : '') + '><span class="slider"></span></label>' +
          '<span style="font-size:0.78rem; color:#00f0ff;">Light Illuminated</span>' +
          '</div>' +
          '</label>' +
          '</div>';
      } else if (cat === "relays") {
        var rName = act === "add" ? "Aux Relay 3 (Cleaner)" : (selectedItem.name || "Aux Relay 1");
        var rOn = (selectedItem.status === "ON");
        var rSub = (selectedItem.subtype || "GENERIC").toUpperCase();

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Relay Name' +
          '<input type="text" id="icMgrRelayName" class="form-input" value="' + escapeHtml(rName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Aux Channel / Relay Port' +
          '<select id="icMgrRelayPort" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="AUX1">Aux 1 (High-Voltage Relay 1)</option>' +
          '<option value="AUX2">Aux 2 (High-Voltage Relay 2)</option>' +
          '<option value="AUX3">Aux 3 (High-Voltage Relay 3)</option>' +
          '<option value="AUX4">Aux 4 (High-Voltage Relay 4)</option>' +
          '<option value="AUX5">Aux 5 (High-Voltage Relay 5)</option>' +
          '<option value="AUX6">Aux 6 (High-Voltage Relay 6)</option>' +
          '<option value="AUX7">Aux 7 (High-Voltage Relay 7)</option>' +
          '<option value="AUX8">Aux 8 (High-Voltage Relay 8)</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Circuit Function Type' +
          '<select id="icMgrRelaySub" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="GENERIC"' + (rSub === "GENERIC" ? ' selected' : '') + '>Generic Auxiliary Relay</option>' +
          '<option value="CLEANER"' + (rSub === "CLEANER" ? ' selected' : '') + '>Pool Pressure Cleaner Booster</option>' +
          '<option value="BLOWER"' + (rSub === "BLOWER" ? ' selected' : '') + '>Hydrotherapy Air Blower</option>' +
          '<option value="MAGIC2"' + (rSub === "MAGIC2" ? ' selected' : '') + '>Laminar Deck Jet</option>' +
          '<option value="LIGHT"' + (rSub === "LIGHT" ? ' selected' : '') + '>Landscape / Feature Lighting</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Power State' +
          '<div style="display:flex; align-items:center; gap:8px; margin-top:4px;">' +
          '<label class="switch"><input type="checkbox" id="icMgrRelayPower"' + (rOn ? ' checked' : '') + '><span class="slider"></span></label>' +
          '<span style="font-size:0.78rem; color:#10b981;">Relay Energized (ON)</span>' +
          '</div>' +
          '</label>' +
          '</div>';
      } else {
        var dName = act === "add" ? "Custom Equipment" : (selectedItem.name || "Device");
        var dType = (selectedItem.objtype || "CIRCUIT").toUpperCase();
        var dSub = (selectedItem.subtype || "GENERIC").toUpperCase();
        var dOn = (selectedItem.status === "ON" || selectedItem.status === "10");

        formHtml = '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Device Name' +
          '<input type="text" id="icMgrDevName" class="form-input" value="' + escapeHtml(dName) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Device Type' +
          '<select id="icMgrDevType" class="select" style="padding:6px; font-size:0.8rem;">' +
          '<option value="CIRCUIT"' + (dType === "CIRCUIT" ? ' selected' : '') + '>CIRCUIT (Relay / Load)</option>' +
          '<option value="VALVE"' + (dType === "VALVE" ? ' selected' : '') + '>VALVE (Motorized Actuator)</option>' +
          '<option value="PUMP"' + (dType === "PUMP" ? ' selected' : '') + '>PUMP (Pump Motor)</option>' +
          '<option value="HEATER"' + (dType === "HEATER" ? ' selected' : '') + '>HEATER (Thermostat)</option>' +
          '<option value="CHEM"' + (dType === "CHEM" ? ' selected' : '') + '>CHEM (Chlorination)</option>' +
          '</select>' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">Subtype' +
          '<input type="text" id="icMgrDevSubtype" class="form-input" value="' + escapeHtml(dSub) + '" style="padding:6px; font-size:0.8rem;">' +
          '</label>' +
          '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; color:#cbd5e1;">State' +
          '<div style="display:flex; align-items:center; gap:8px; margin-top:4px;">' +
          '<label class="switch"><input type="checkbox" id="icMgrDevPower"' + (dOn ? ' checked' : '') + '><span class="slider"></span></label>' +
          '<span style="font-size:0.78rem; color:#10b981;">Active</span>' +
          '</div>' +
          '</label>' +
          '</div>';
      }

      formBox.innerHTML = formHtml;

      if ($("icMgrChlorSlider") && $("icMgrChlorVal")) {
        $("icMgrChlorSlider").addEventListener("input", function (e) {
          $("icMgrChlorVal").textContent = e.target.value + "%";
        });
      }
      if ($("icMgrPumpSlider") && $("icMgrPumpSpeedVal")) {
        $("icMgrPumpSlider").addEventListener("input", function (e) {
          $("icMgrPumpSpeedVal").textContent = e.target.value + " RPM";
        });
      }
      formBox.querySelectorAll(".ic-mgr-preset").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var rpm = btn.getAttribute("data-rpm");
          if ($("icMgrPumpSlider")) $("icMgrPumpSlider").value = rpm;
          if ($("icMgrPumpSpeedVal")) $("icMgrPumpSpeedVal").textContent = rpm + " RPM";
        });
      });

      if (submitBtn) {
        if (act === "delete") {
          submitBtn.textContent = "🗑️ Delete from IntelliCenter";
          submitBtn.className = "btn small danger";
        } else if (act === "add") {
          submitBtn.textContent = "➕ Add to IntelliCenter";
          submitBtn.className = "btn small primary";
        } else if (act === "control") {
          submitBtn.textContent = "⚡ Apply Quick Action";
          submitBtn.className = "btn small primary";
        } else {
          submitBtn.textContent = "💾 Save Changes";
          submitBtn.className = "btn small primary";
        }
      }
    }

    catSelect.addEventListener("change", renderManagerForm);
    actSelect.addEventListener("change", renderManagerForm);
    if (targetSelect) targetSelect.addEventListener("change", renderManagerForm);
    if (resetBtn) resetBtn.addEventListener("click", renderManagerForm);

    if (submitBtn) {
      submitBtn.addEventListener("click", async function () {
        var cat = catSelect.value || "valves";
        var act = actSelect.value || "add";
        submitBtn.disabled = true;
        var origText = submitBtn.textContent;
        submitBtn.textContent = "⏳ Processing...";

        try {
          if (cat === "schedules") {
            var runs = (state && state.schedule && state.schedule.runs) ? JSON.parse(JSON.stringify(state.schedule.runs)) : [];
            var selectedIdx = (targetSelect && targetSelect.value) ? parseInt(targetSelect.value.replace("run_", ""), 10) : 0;

            if (act === "delete") {
              if (runs.length > 0) {
                runs.splice(selectedIdx, 1);
                await api("/api/intellicenter/schedule", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled: true, runs: runs })
                });
                toast("Schedule run deleted", "good");
              }
            } else {
              var sName = ($("icMgrSchName") && $("icMgrSchName").value.trim()) || "VSR Run";
              var sStart = ($("icMgrSchStart") && $("icMgrSchStart").value) || "08:00";
              var sEnd = ($("icMgrSchEnd") && $("icMgrSchEnd").value) || "18:00";
              var sRpm = ($("icMgrSchRpm") && parseInt($("icMgrSchRpm").value, 10)) || 2200;
              var sDays = [];
              formBox.querySelectorAll(".ic-mgr-day:checked").forEach(function (cb) { sDays.push(cb.value); });
              if (!sDays.length) sDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

              var runObj = { name: sName, start: sStart, end: sEnd, rpm: sRpm, days: sDays };
              if (act === "add") {
                runs.push(runObj);
              } else {
                runs[selectedIdx] = runObj;
              }

              await api("/api/intellicenter/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: true, runs: runs })
              });
              toast(act === "add" ? "Schedule run added" : "Schedule updated", "good");
            }
            await refresh();
          } else if (cat === "chlorinator") {
            var output = $("icMgrChlorSlider") ? parseInt($("icMgrChlorSlider").value, 10) : 60;
            var salt = $("icMgrSaltPpm") ? parseInt($("icMgrSaltPpm").value, 10) : 3200;
            var superChl = $("icMgrSuperChlor") ? $("icMgrSuperChlor").checked : false;

            var res = await api("/api/intellicenter/chlorinator", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ output_percent: output, salt_ppm: salt, super_chlorinate: superChl })
            });
            toast(res.message || "IntelliChlor settings applied", "good");
            await loadIntelliCenter();
          } else if (cat === "valves") {
            var vObjnam = (targetSelect && targetSelect.value) || "V1001";
            if (act === "add") {
              var vName = ($("icMgrValveName") && $("icMgrValveName").value.trim()) || "New Valve Actuator";
              var vPos = ($("icMgrValvePos") && $("icMgrValvePos").value) || "POOL";
              await api("/api/intellicenter/device/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objtype: "VALVE", name: vName, subtype: "VALVE", params: { POSIT: vPos } })
              });
              toast("Valve added: " + vName, "good");
            } else if (act === "delete") {
              await api("/api/intellicenter/device/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: vObjnam })
              });
              toast("Valve removed", "good");
            } else {
              var vName = $("icMgrValveName") ? $("icMgrValveName").value.trim() : null;
              var vPos = $("icMgrValvePos") ? $("icMgrValvePos").value : null;
              if (vPos) {
                await api("/api/intellicenter/valve", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: vObjnam, position: vPos })
                });
              }
              if (vName && act === "edit") {
                await api("/api/intellicenter/device/edit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: vObjnam, name: vName })
                });
              }
              toast("Valve adjusted", "good");
            }
            await loadIntelliCenter();
          } else if (cat === "pumps") {
            var pObjnam = (targetSelect && targetSelect.value) || "P1001";
            if (act === "add") {
              var pName = ($("icMgrPumpName") && $("icMgrPumpName").value.trim()) || "New VSR Pump";
              var pType = ($("icMgrPumpType") && $("icMgrPumpType").value) || "VS";
              await api("/api/intellicenter/device/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objtype: "PUMP", name: pName, subtype: pType, params: { SPEED: "2200", RPM: "2200" } })
              });
              toast("Pump added: " + pName, "good");
            } else if (act === "delete") {
              await api("/api/intellicenter/device/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: pObjnam })
              });
              toast("Pump removed", "good");
            } else {
              var pName = $("icMgrPumpName") ? $("icMgrPumpName").value.trim() : null;
              var pSpeed = $("icMgrPumpSlider") ? parseInt($("icMgrPumpSlider").value, 10) : null;
              var pOn = $("icMgrPumpPower") ? $("icMgrPumpPower").checked : null;

              if (pSpeed !== null || pOn !== null) {
                await api("/api/intellicenter/device/control", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: pObjnam, speed: pSpeed, on: pOn })
                });
              }
              if (pName && act === "edit") {
                await api("/api/intellicenter/device/edit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: pObjnam, name: pName })
                });
              }
              toast("Pump updated", "good");
            }
            await loadIntelliCenter();
          } else if (cat === "lights") {
            var lObjnam = (targetSelect && targetSelect.value) || "C0012";
            if (act === "add") {
              var lName = ($("icMgrLightName") && $("icMgrLightName").value.trim()) || "Pool Light";
              var lType = ($("icMgrLightType") && $("icMgrLightType").value) || "INTELLI";
              var lEffect = ($("icMgrLightEffect") && $("icMgrLightEffect").value) || "BLUER";
              await api("/api/intellicenter/device/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objtype: "CIRCUIT", name: lName, subtype: lType, params: { ACT: lEffect, USE: lEffect } })
              });
              toast("Light added: " + lName, "good");
            } else if (act === "delete") {
              await api("/api/intellicenter/device/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: lObjnam })
              });
              toast("Light removed", "good");
            } else {
              var lName = $("icMgrLightName") ? $("icMgrLightName").value.trim() : null;
              var lEffect = $("icMgrLightEffect") ? $("icMgrLightEffect").value : null;
              var lOn = $("icMgrLightPower") ? $("icMgrLightPower").checked : null;

              await api("/api/intellicenter/device/control", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: lObjnam, on: lOn, effect: lEffect })
              });
              if (lName && act === "edit") {
                await api("/api/intellicenter/device/edit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: lObjnam, name: lName })
                });
              }
              toast("Light updated", "good");
            }
            await loadIntelliCenter();
          } else if (cat === "relays") {
            var rObjnam = (targetSelect && targetSelect.value) || "C0014";
            if (act === "add") {
              var rName = ($("icMgrRelayName") && $("icMgrRelayName").value.trim()) || "Aux Relay";
              var rSub = ($("icMgrRelaySub") && $("icMgrRelaySub").value) || "GENERIC";
              await api("/api/intellicenter/device/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objtype: "CIRCUIT", name: rName, subtype: rSub })
              });
              toast("Aux relay added: " + rName, "good");
            } else if (act === "delete") {
              await api("/api/intellicenter/device/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: rObjnam })
              });
              toast("Aux relay removed", "good");
            } else {
              var rName = $("icMgrRelayName") ? $("icMgrRelayName").value.trim() : null;
              var rSub = $("icMgrRelaySub") ? $("icMgrRelaySub").value : null;
              var rOn = $("icMgrRelayPower") ? $("icMgrRelayPower").checked : null;

              if (rOn !== null) {
                await api("/api/intellicenter/device/control", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: rObjnam, on: rOn })
                });
              }
              if (rName || rSub) {
                await api("/api/intellicenter/device/edit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: rObjnam, name: rName, subtype: rSub })
                });
              }
              toast("Aux relay updated", "good");
            }
            await loadIntelliCenter();
          } else {
            var dObjnam = (targetSelect && targetSelect.value) || "";
            if (act === "add") {
              var dName = ($("icMgrDevName") && $("icMgrDevName").value.trim()) || "New Device";
              var dType = ($("icMgrDevType") && $("icMgrDevType").value) || "CIRCUIT";
              var dSub = ($("icMgrDevSubtype") && $("icMgrDevSubtype").value) || "GENERIC";
              await api("/api/intellicenter/device/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objtype: dType, name: dName, subtype: dSub })
              });
              toast("Device added: " + dName, "good");
            } else if (act === "delete") {
              await api("/api/intellicenter/device/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objnam: dObjnam })
              });
              toast("Device removed", "good");
            } else {
              var dName = $("icMgrDevName") ? $("icMgrDevName").value.trim() : null;
              var dSub = $("icMgrDevSubtype") ? $("icMgrDevSubtype").value : null;
              var dOn = $("icMgrDevPower") ? $("icMgrDevPower").checked : null;
              if (dOn !== null) {
                await api("/api/intellicenter/device/control", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: dObjnam, on: dOn })
                });
              }
              if (dName || dSub) {
                await api("/api/intellicenter/device/edit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ objnam: dObjnam, name: dName, subtype: dSub })
                });
              }
              toast("Device updated", "good");
            }
            await loadIntelliCenter();
          }
        } catch (err) {
          toast("Operation failed: " + err.message, "error");
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = origText;
          renderManagerForm();
        }
      });
    }

    renderManagerForm();
    window.refreshIntelliCenterManager = renderManagerForm;
  }

  function bind() {
    // 1. BIND TABS FIRST SO NAVIGATION ALWAYS WORKS IMMEDIATELY
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var name = tab.getAttribute("data-tab");
        activateTab(name);
        if (history.replaceState) history.replaceState(null, "", "#" + name);
      });
    });
    document.addEventListener("visibilitychange", updateLiveVideo);
    window.addEventListener("hashchange", function () {
      activateTab((location.hash || "#control").slice(1));
    });
    activateTab((location.hash || "#control").slice(1));

    try { buildFeatureCards(); } catch (err) { console.error("buildFeatureCards error:", err); }
    try { initIntelliCenterManager(); } catch (err) { console.error("initIntelliCenterManager error:", err); }
    try { initPoolLogicVisualization(); } catch (err) { console.error("initPoolLogicVisualization error:", err); }

    document.querySelectorAll(".pos-pill").forEach(function (pill) {
      pill.addEventListener("click", function () {
        setVizInfoPosition(pill.getAttribute("data-pos"));
      });
    });
    setVizInfoPosition(localStorage.getItem("pool.vizInfoPos") || "below");

    $("modePool").addEventListener("click", function () {
      command("set_mode", { mode: "pool" });
      if (window.pool3d) window.pool3d.focus("pool");
    });
    $("modeSpa").addEventListener("click", function () {
      command("set_mode", { mode: "spa" });
      if (window.pool3d) window.pool3d.focus("spa");
    });
    $("allOff").addEventListener("click", function () { command("system_off", {}); });

    ["main", "features"].forEach(function (key) {
      $(key + "PumpToggle").addEventListener("change", function (e) {
        command("set_pump", { pump: key, on: e.target.checked });
      });
      var slider = $(key + "Rpm");
      slider.addEventListener("input", function (e) {
        $(key + "RpmVal").textContent = e.target.value + " RPM";
      });
      slider.addEventListener("change", function (e) {
        command("set_pump", { pump: key, rpm: parseInt(e.target.value, 10) });
      });
    });

    $("deckJets").addEventListener("change", function (e) {
      var input = e.target.closest('input[data-toggle="jet"]');
      if (!input) return;
      var card = input.closest("[data-jet]");
      command("set_deck_jet", { id: card.getAttribute("data-jet"), on: input.checked });
    });
    $("firebaskets").addEventListener("change", function (e) {
      var card = e.target.closest("[data-basket]");
      if (!card) return;
      var key = card.getAttribute("data-basket");
      if (e.target.matches('input[data-spillway="pool"]')) {
        command("set_firebasket", { id: key, water: e.target.checked });
      } else if (e.target.matches('input[data-spillway="spa"]')) {
        command("set_firebasket", { id: key, spa_water: e.target.checked });
      } else if (e.target.matches('input[data-toggle="flame"]')) {
        command("set_firebasket", { id: key, on: e.target.checked });
      } else if (e.target.matches('input[data-toggle="burner-light"]')) {
        command("set_firebasket", { id: key, burner_light: e.target.checked });
      } else if (e.target.matches('input[data-toggle="firebasket"]')) {
        command("set_firebasket", { id: key, on: e.target.checked });
      }
    });
    $("featuresAllOn").addEventListener("click", function () { command("set_all_features", { on: true }); });
    $("featuresAllOff").addEventListener("click", function () { command("set_all_features", { on: false }); });

    ["pool", "spa"].forEach(function (body) {
      $(body + "LightToggle").addEventListener("change", function (e) {
        command("set_light", { body: body, on: e.target.checked });
      });
      $(body + "Effect").addEventListener("change", function (e) {
        var light = (state.lights || {})[body] || {};
        command("set_light", { body: body, on: light.on, effect: e.target.value });
      });
    });
    $("blowerToggle").addEventListener("change", function (e) {
      if (window.pool3d && window.pool3d.setBlower) {
        window.pool3d.setBlower(e.target.checked);
      }
      command("set_blower", { on: e.target.checked });
    });

    $("heaterToggle").addEventListener("change", function (e) {
      command("set_heater", { on: e.target.checked });
    });
    var heatSlider = $("heaterSetpoint");
    if (heatSlider) {
      heatSlider.addEventListener("input", function (e) {
        if ($("heaterSetpointVal")) $("heaterSetpointVal").textContent = e.target.value + "\u00B0F";
      });
      heatSlider.addEventListener("change", function (e) {
        command("set_heater", { setpoint: parseInt(e.target.value, 10) });
      });
    }

    $("addRun").addEventListener("click", function () {
      scheduleDraft = collectSchedule();
      scheduleDraft.push({ name: "Main VSR run", start: "08:00", end: "18:00", rpm: 2200, days: DAYS.slice() });
      scheduleDirty = true;
      renderScheduleRows();
    });
    $("saveSchedule").addEventListener("click", function () {
      var runs = collectSchedule();
      scheduleDraft = runs;
      scheduleDirty = false;
      scheduleKey = null;
      command("set_schedule", { enabled: $("scheduleEnabled").checked, runs: runs });
    });
    $("scheduleRuns").addEventListener("click", function (e) {
      var chip = e.target.closest(".day-chip");
      if (chip) {
        chip.classList.toggle("on");
        return;
      }
      var remove = e.target.closest("[data-remove]");
      if (remove) {
        scheduleDraft = collectSchedule();
        scheduleDraft.splice(parseInt(remove.getAttribute("data-remove"), 10), 1);
        scheduleDirty = true;
        renderScheduleRows();
      }
    });
    $("scheduleRuns").addEventListener("input", function () { scheduleDirty = true; });
    $("scheduleRuns").addEventListener("change", function () { scheduleDirty = true; });
    $("scheduleEnabled").addEventListener("change", function () { scheduleDirty = true; });

    var selApiKeyType = $("selectApiKeyType");
    if (selApiKeyType) {
      selApiKeyType.addEventListener("change", function (e) {
        if (e.target.value === "opencode-go") {
          // Don't auto-insert the built-in default: that account is disabled,
          // so pasting a fresh key is the only way this works. Keep whatever
          // the user has typed and just select the right provider.
          $("aiProvider").value = "opencode-go";
          localStorage.setItem("pool.apiKeyType", "opencode-go");
        } else if (e.target.value === "google") {
          var userKey = localStorage.getItem("pool.userGeminiKey") || "";
          $("voiceKey").value = userKey;
          $("voiceKey").placeholder = "Paste Google Gemini API Key...";
          $("aiProvider").value = "google";
          localStorage.setItem("pool.apiKeyType", "google");
          $("voiceKey").focus();
        }
      });
      var curType = localStorage.getItem("pool.apiKeyType") || (geminiKey().startsWith("AQ.") ? "opencode-go" : "google");
      selApiKeyType.value = curType;
    }

    $("saveSettings").addEventListener("click", saveSettings);
    $("saveAlexa").addEventListener("click", saveAlexaSettings);
    $("saveAlexaSkillId").addEventListener("click", saveAlexaSkillId);
    $("icWiringRefresh").addEventListener("click", loadWiring);
    $("lightsParty").addEventListener("click", function () {
      command("set_all_lights", { on: true, effect: "PARTY" });
    });
    $("lightsAllBlue").addEventListener("click", function () {
      command("set_all_lights", { on: true, effect: "BLUER" });
    });
    $("downloadAlexaModel").addEventListener("click", downloadAlexaModel);
    if ($("refreshAlexaBtn")) $("refreshAlexaBtn").addEventListener("click", loadAlexa);
    $("refreshInventory").addEventListener("click", refreshInventory);
    if ($("setupOpenHostBtn")) $("setupOpenHostBtn").addEventListener("click", openIntelliCenterHost);
    $("saveKey").addEventListener("click", function () {
      var key = $("voiceKey").value.trim();
      if (!key) { toast("Enter an API key first", "error"); return; }
      localStorage.setItem("pool.geminiKey", key);
      if (selApiKeyType && selApiKeyType.value === "google") {
        localStorage.setItem("pool.userGeminiKey", key);
      }
      toast("API key saved in this browser", "good");
    });
    $("saveServerKey").addEventListener("click", saveServerKey);
    $("saveAssistant").addEventListener("click", saveAssistantSettings);
    $("saveAudio").addEventListener("click", saveAudioSettings);
    $("refreshAudio").addEventListener("click", function () { refreshAudioDevices(true); });
    $("personalitySelect").addEventListener("change", updatePersonaVisibility);
    $("speakRate").addEventListener("input", updateRateReadouts);
    $("speakPitch").addEventListener("input", updateRateReadouts);

    var micSens = $("micSensitivity");
    if (micSens) {
      micSens.addEventListener("input", function (e) { setMicSensitivity(e.target.value, false); });
      micSens.addEventListener("change", function (e) { setMicSensitivity(e.target.value, true); });
    }
    var cockpitMicSens = $("cockpitMicSensitivity");
    if (cockpitMicSens) {
      cockpitMicSens.addEventListener("input", function (e) { setMicSensitivity(e.target.value, false); });
      cockpitMicSens.addEventListener("change", function (e) { setMicSensitivity(e.target.value, true); });
    }
    var silenceDelay = $("silenceDelay");
    if (silenceDelay) {
      silenceDelay.addEventListener("input", function (e) { setSilenceDelay(e.target.value, false); });
      silenceDelay.addEventListener("change", function (e) { setSilenceDelay(e.target.value, true); });
    }
    var hwMicSens = $("hwMicSensitivity");
    if (hwMicSens) {
      hwMicSens.addEventListener("input", function (e) { setMicSensitivity(e.target.value, false); });
      hwMicSens.addEventListener("change", function (e) { setMicSensitivity(e.target.value, true); });
    }

    ["sourceLocalMic", "sourceBrowserMic"].forEach(function (id) {
      var r = $(id);
      if (r) {
        r.addEventListener("change", function () {
          var val = micSource();
          applyMicSource();
          saveAudioChoice({ voice_source: val },
            val === "browser" ? "Browser microphone selected; the Pi mic is off"
                              : "Pi microphone selected; the browser mic is off");
        });
      }
    });

    ["destLocalSpeaker", "destBrowserSpeaker"].forEach(function (id) {
      var r = $(id);
      if (r) {
        r.addEventListener("change", function () {
          var browser = browserSpeakerEnabled();
          saveAudioChoice({ speaker_dest: browser ? "browser" : "local" },
            browser ? "Replies will play on this browser" : "Replies will play on the Pi speaker");
        });
      }
    });

    if (!vuPollTimer) {
      vuPollTimer = setInterval(pollLocalAudioStatus, 250);
    }

    var vsElem = $("voiceSource");
    if (vsElem) {
      vsElem.addEventListener("change", function () {
        localStorage.setItem("pool.voiceSource", vsElem.value);
      });
    }
    $("browserVoice").addEventListener("change", function () {
      localStorage.setItem("pool.browserVoice", $("browserVoice").value);
    });
    $("browserMic").addEventListener("change", function () {
      localStorage.setItem("pool.micDevice", $("browserMic").value);
    });
    $("browserSpeaker").addEventListener("change", function () {
      localStorage.setItem("pool.speakerDevice", $("browserSpeaker").value);
    });
    $("saveCamera").addEventListener("click", saveCameraSettings);
    $("refreshCameras").addEventListener("click", function () { refreshCameraDevices(true); });
    $("localSnapshot").addEventListener("click", refreshLocalSnapshot);
    $("lookLocal").addEventListener("click", lookWithLocalCamera);
    $("lookBrowser").addEventListener("click", lookWithBrowserCamera);
    $("browserCamera").addEventListener("change", function () {
      localStorage.setItem("pool.browserCamera", $("browserCamera").value);
      if (cameraStream) {
        cameraStream.getTracks().forEach(function (track) { track.stop(); });
        cameraStream = null;
      }
      startBrowserCamera().catch(function (err) {
        toast("Browser camera unavailable: " + err.message, "error");
      });
    });
    var savedKey = geminiKey();
    if (savedKey) $("voiceKey").value = savedKey;

    $("sendVoiceText").addEventListener("click", function () {
      var prompt = $("voiceText").value.trim();
      if (!prompt) return;
      $("voiceText").value = "";
      askPool(prompt);
    });
    $("voiceText").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("sendVoiceText").click();
    });
    var mic = $("micBtn");
    mic.addEventListener("pointerdown", startRecording);
    mic.addEventListener("pointerup", stopRecording);
    mic.addEventListener("pointerleave", stopRecording);
    mic.addEventListener("pointercancel", stopRecording);
    mic.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    document.querySelectorAll(".scene").forEach(function (btn) {
      btn.addEventListener("click", function () { runScene(btn.getAttribute("data-scene")); });
    });

    // ----------------------------------------------------------------
    // IntelliCenter tab events
    // ----------------------------------------------------------------
    document.querySelectorAll("#icFilterPills .filter-pill").forEach(function (pill) {
      pill.addEventListener("click", function () {
        document.querySelectorAll("#icFilterPills .filter-pill").forEach(function (p) { p.classList.remove("active"); });
        pill.classList.add("active");
        icCurrentFilter = pill.getAttribute("data-filter") || "all";
        renderIntelliCenter();
      });
    });

    if ($("icSearchInput")) {
      $("icSearchInput").addEventListener("input", function (e) {
        icSearchQuery = e.target.value;
        renderIntelliCenter();
      });
    }

    if ($("icOpenHostBtn")) {
      $("icOpenHostBtn").addEventListener("click", openIntelliCenterHost);
    }

    if ($("icScanAdjustBtn")) {
      $("icScanAdjustBtn").addEventListener("click", async function () {
        $("icScanAdjustBtn").textContent = "⏳ Scanning...";
        try {
          var res = await api("/api/intellicenter/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true })
          });
          toast("IntelliCenter scanned: " + (res.summary || "Hardware adjusted"), "good");
          await loadIntelliCenter();
        } catch (err) {
          toast("Scan failed: " + err.message, "error");
        } finally {
          $("icScanAdjustBtn").textContent = "🔍 Scan & Adjust Hardware";
        }
      });
    }

    if ($("icRefreshBtn")) {
      $("icRefreshBtn").addEventListener("click", function () {
        loadIntelliCenter();
        toast("IntelliCenter equipment refreshed", "good");
      });
    }

    if ($("icAutoMapBtn")) {
      $("icAutoMapBtn").addEventListener("click", autoDetectAnimationMapping);
    }

    if ($("icSaveMappingBtn")) {
      $("icSaveMappingBtn").addEventListener("click", saveAnimationMappingFromUI);
    }
    if ($("icSaveMappingBtnBottom")) {
      $("icSaveMappingBtnBottom").addEventListener("click", saveAnimationMappingFromUI);
    }
    if ($("icResetMappingBtn")) {
      $("icResetMappingBtn").addEventListener("click", function () {
        if (confirm("Reset animation mappings by auto-detecting current panel equipment?")) {
          autoDetectAnimationMapping();
        }
      });
    }

    // Add device modal
    if ($("icOpenAddModalBtn")) {
      $("icOpenAddModalBtn").addEventListener("click", function () {
        $("addDeviceModal").style.display = "grid";
      });
    }
    if ($("closeAddDeviceModal")) {
      $("closeAddDeviceModal").addEventListener("click", function () {
        $("addDeviceModal").style.display = "none";
      });
    }
    if ($("cancelAddDevice")) {
      $("cancelAddDevice").addEventListener("click", function () {
        $("addDeviceModal").style.display = "none";
      });
    }
    if ($("confirmAddDevice")) {
      $("confirmAddDevice").addEventListener("click", async function () {
        var type = $("newDevType").value;
        var name = $("newDevName").value.trim();
        var subtype = $("newDevSubtype").value;
        var extra = $("newDevExtra").value.trim();
        if (!name) {
          toast("Please enter a device name", "error");
          return;
        }
        try {
          var result = await api("/api/intellicenter/device/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ objtype: type, name: name, subtype: subtype, params: { CIRCUIT: extra } })
          });
          $("addDeviceModal").style.display = "none";
          $("newDevName").value = "";
          $("newDevExtra").value = "";
          toast(result.message || "Equipment added to IntelliCenter!", "good");
          await loadIntelliCenter();
        } catch (err) {
          toast("Error adding equipment: " + err.message, "error");
        }
      });
    }

    // Edit device modal
    if ($("closeEditDeviceModal")) {
      $("closeEditDeviceModal").addEventListener("click", function () {
        $("editDeviceModal").style.display = "none";
      });
    }
    if ($("cancelEditDevice")) {
      $("cancelEditDevice").addEventListener("click", function () {
        $("editDeviceModal").style.display = "none";
      });
    }
    if ($("confirmEditDevice")) {
      $("confirmEditDevice").addEventListener("click", async function () {
        var objnam = $("editDevObjnam").value;
        var name = $("editDevName").value.trim();
        var subtype = $("editDevSubtype").value;
        if (!name) {
          toast("Name cannot be empty", "error");
          return;
        }
        try {
          var result = await api("/api/intellicenter/device/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ objnam: objnam, name: name, subtype: subtype })
          });
          $("editDeviceModal").style.display = "none";
          toast(result.message || "Equipment updated!", "good");
          await loadIntelliCenter();
        } catch (err) {
          toast("Error updating equipment: " + err.message, "error");
        }
      });
    }

    // Device grid event delegation
    var icGrid = $("icDeviceGrid");
    if (icGrid) {
      icGrid.addEventListener("change", function (e) {
        if (e.target.classList.contains("ic-power-toggle")) {
          var objnam = e.target.getAttribute("data-objnam");
          controlDevice(objnam, e.target.checked);
        } else if (e.target.classList.contains("ic-light-effect")) {
          var objnam = e.target.getAttribute("data-objnam");
          controlDevice(objnam, null, null, e.target.value);
        }
      });

      icGrid.addEventListener("input", function (e) {
        if (e.target.classList.contains("ic-rpm-slider")) {
          var readout = e.target.nextElementSibling;
          if (readout) readout.textContent = e.target.value + " RPM";
        } else if (e.target.classList.contains("ic-temp-slider")) {
          var readout = e.target.nextElementSibling;
          if (readout) readout.textContent = e.target.value + "°F";
        }
      });

      icGrid.addEventListener("click", function (e) {
        var applyRpm = e.target.closest(".ic-apply-rpm");
        if (applyRpm) {
          var objnam = applyRpm.getAttribute("data-objnam");
          var slider = icGrid.querySelector('.ic-rpm-slider[data-objnam="' + objnam + '"]');
          if (slider) controlDevice(objnam, null, parseInt(slider.value, 10));
          return;
        }

        var applyTemp = e.target.closest(".ic-apply-temp");
        if (applyTemp) {
          var objnam = applyTemp.getAttribute("data-objnam");
          var slider = icGrid.querySelector('.ic-temp-slider[data-objnam="' + objnam + '"]');
          if (slider) controlDevice(objnam, null, null, null, parseInt(slider.value, 10));
          return;
        }

        var editBtn = e.target.closest(".ic-edit-btn");
        if (editBtn) {
          var objnam = editBtn.getAttribute("data-objnam");
          var name = editBtn.getAttribute("data-name");
          var subtype = editBtn.getAttribute("data-subtype");
          var objtype = editBtn.getAttribute("data-objtype");
          $("editDevObjnam").value = objnam;
          $("editDevObjnamDisplay").value = objnam;
          $("editDevObjtypeDisplay").value = objtype;
          $("editDevName").value = name;
          $("editDevSubtype").value = subtype;
          $("editDeviceModal").style.display = "grid";
          return;
        }

        var delBtn = e.target.closest(".ic-delete-btn");
        if (delBtn) {
          var objnam = delBtn.getAttribute("data-objnam");
          var name = delBtn.getAttribute("data-name");
          if (confirm("Remove custom equipment " + name + " (" + objnam + ") from IntelliCenter?")) {
            api("/api/intellicenter/device/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ objnam: objnam })
            }).then(function (res) {
              toast(res.message || "Equipment removed", "good");
              loadIntelliCenter();
            }).catch(function (err) {
              toast("Error deleting equipment: " + err.message, "error");
            });
          }
          return;
        }
      });
    }

    // Manual tab print actions
    if ($("printManualBtnTop")) {
      $("printManualBtnTop").addEventListener("click", function () { window.print(); });
    }
    if ($("printManualBtnBottom")) {
      $("printManualBtnBottom").addEventListener("click", function () { window.print(); });
    }
    if ($("manualScrollTopBtn")) {
      $("manualScrollTopBtn").addEventListener("click", function () {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    // IntelliCenter 3D Panel controls
    if ($("p3dOpenHostBtn")) {
      $("p3dOpenHostBtn").addEventListener("click", openIntelliCenterHost);
    }
    if ($("p3dToggleDoorBtn")) {
      $("p3dToggleDoorBtn").addEventListener("click", function () {
        if (window.panel3d) window.panel3d.toggleDoor();
      });
    }
    if ($("p3dResetCamBtn")) {
      $("p3dResetCamBtn").addEventListener("click", function () {
        if (window.panel3d) window.panel3d.focus("cabinet");
      });
    }
    document.querySelectorAll(".p3d-cam-preset").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var preset = btn.getAttribute("data-preset");
        if (window.panel3d) window.panel3d.focus(preset);
      });
    });

    var p3dMatrixTable = $("p3dMatrixBody");
    if (p3dMatrixTable) {
      p3dMatrixTable.addEventListener("click", function (e) {
        var btn = e.target.closest(".p3d-matrix-toggle");
        if (btn) {
          var objnam = btn.getAttribute("data-objnam");
          var turnOn = btn.getAttribute("data-on") === "1";
          controlDevice(objnam, turnOn);
        }
      });
    }
  }

  function startLivePoolCamera() {
    updateLiveVideo();
  }

  function init() {
    if (/[?&]kiosk=1\b/.test(window.location.search)) {
      document.body.classList.add("kiosk");
      document.addEventListener("contextmenu", function (e) {
        if (!e.target.closest("input, textarea")) e.preventDefault();
      });
    }
    bindAuth();
    applyAuth({ logged_in: false });
    checkAuth();
    bind();
    populateBrowserVoices();
    startLivePoolCamera();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = populateBrowserVoices;
    }
    loadConfig().then(function () {
      refreshAudioDevices(false);
      refreshCameraDevices(false);
    });
    refresh().then(function () {
      refreshInventory();
    });
    polling = setInterval(refresh, 1500);
    document.addEventListener("pointerdown", ensureBrowserMicMonitor, { once: true });
    document.addEventListener("click", ensureBrowserMicMonitor, { once: true });
  }

  document.addEventListener("DOMContentLoaded", init);
})();

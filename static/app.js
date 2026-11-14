/* Shobots Pool client */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var state = null;
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
    if (!response.ok) {
      throw new Error((data && (data.error || data.message)) || ("HTTP " + response.status));
    }
    return data;
  }

  async function command(action, payload) {
    try {
      var result = await api("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action, payload: payload || {} })
      });
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
    var badge = $("statusBadge");
    var statusText = $("statusText");
    if (badge) {
      badge.classList.remove("online", "offline", "simulation");
      if (conn.connected) badge.classList.add("online");
      else badge.classList.add("simulation");
    }
    if (statusText) {
      statusText.textContent = conn.connected ? "PANEL ONLINE" : "SIMULATION";
      statusText.title = conn.last_error || "IntelliCenter offline - UI and schedule still work";
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
      var light = card.querySelector('[data-act="light"]');
      var thumper = card.querySelector('[data-act="thumper"]');
      if (light) light.classList.toggle("on", !!jet.light && !!jet.on);
      if (thumper) thumper.classList.toggle("on", jet.thumper !== false && !!jet.on);
      var sub = card.querySelector(".feature-sub");
      if (sub) {
        sub.textContent = jet.on
          ? "Running" + (jet.light ? " \u00B7 light" : "") + (jet.thumper !== false ? " \u00B7 thumper" : "")
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
      card.classList.toggle("on", !!basket.on);
      var toggle = card.querySelector('input[data-toggle="firebasket"]');
      if (toggle) toggle.checked = !!basket.on;
      var sub = card.querySelector(".feature-sub");
      if (sub) sub.textContent = basket.on
        ? "Pool & spa fountains flowing" : "Pool & spa fountains off";
      var poolLed = card.querySelector('[data-led="pool"]');
      var spaLed = card.querySelector('[data-led="spa"]');
      if (poolLed) poolLed.classList.toggle("on", !!basket.spillway_pool_led);
      if (spaLed) spaLed.classList.toggle("on", !!basket.spillway_spa_led);
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
    var spill = $("spillwayEffect");
    if (spill && document.activeElement !== spill) {
      var sel = state.spillway_effect || "BLUER";
      var wanted2 = effectOptions(sel);
      if (spill.innerHTML !== wanted2) spill.innerHTML = wanted2;
    }
  }

  function renderHeater() {
    var heater = state.heater || {};
    var toggle = $("heaterToggle");
    var slider = $("heaterSetpoint");
    if (toggle) toggle.checked = !!heater.on;
    if (slider && document.activeElement !== slider && heater.setpoint) slider.value = heater.setpoint;
    $("heaterSetpointVal").textContent = (heater.setpoint || "--") + "\u00B0F";
    $("heaterStatus").textContent = heater.on ? "ON" : "OFF";
    $("heaterStatus").className = "chip " + (heater.on ? "hot" : "");
    $("heaterBodyText").textContent = "Heating the " + (state.active_body || "pool") +
      " \u00B7 set " + (heater.setpoint || "--") + "\u00B0F";
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
    $("infoHeater").textContent = heater.on ? "On \u00B7 " + heater.setpoint + "\u00B0F" : "Off";
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
      " ppm. I\u2019m keeping one eye on the firebaskets.";
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

  function speak(text, audioB64, audioMime) {
    var tts = $("ttsToggle");
    if (!tts || !tts.checked) {
      iguanaSay(text, Math.max(2800, text.length * 55));
      return;
    }
    var source = ($("voiceSource") && $("voiceSource").value) || "browser";
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
    speak(result.text || "Done.", result.audio_b64, result.audio_mime);
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
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      $("voiceStatus").textContent = "Microphone recording is not available in this browser. Type instead.";
      return;
    }
    try {
      var micId = ($("browserMic") && $("browserMic").value) || "";
      var constraints = { audio: micId ? { deviceId: { exact: micId } } : true };
      try {
        recStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (micErr) {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
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
    if (recStream) {
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
      await command("set_spillway_color", { effect: "BLUER" });
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
    var source = localStorage.getItem("pool.voiceSource") || "browser";
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
    var html = '<option value="">Default browser voice</option>';
    voiceList.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (voice) {
      html += '<option value="' + escapeHtml(voice.name) + '">' +
        escapeHtml(voice.name) + " (" + escapeHtml(voice.lang) + ")</option>";
    });
    select.innerHTML = html;
    if (saved) {
      select.value = saved;
      if (!select.value) select.value = "";
    }
  }

  function fillSelect(select, items, defaultLabel, saved) {
    if (!select) return;
    var html = '<option value="">' + escapeHtml(defaultLabel) + "</option>";
    (items || []).forEach(function (item) {
      html += '<option value="' + escapeHtml(item.id || item.name || "") + '">' +
        escapeHtml(item.name || item.id || "") + "</option>";
    });
    select.innerHTML = html;
    if (saved) {
      select.value = saved;
      if (!select.value) select.value = "";
    }
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
      var localMic = localCfg.input_device || "default";
      var localSpk = localCfg.output_device || "default";
      fillSelect($("localMic"), localAudio.inputs, "System default microphone", localMic);
      fillSelect($("localSpeaker"), localAudio.outputs, "System default speaker", localSpk);
      var savedVoice = localStorage.getItem("pool.serverVoice") ||
        (config && config.assistant && config.assistant.server_voice) || "us";
      fillSelect($("serverVoice"), localAudio.voices, "Automatic voice", savedVoice);
      var status = localAudio.local || {};
      var speakerRoute = ("setSinkId" in HTMLMediaElement.prototype)
        ? "Browser speaker routing supported" : "Browser speaker routing not supported by this browser";
      $("localAudioStatus").textContent =
        "Pi microphone: " + (status.mic_running ? "ALWAYS ON on " + (status.input_device || "default") : "not running") +
        "\nPi speaker: " + (status.speaker_available ? "ALWAYS ON on " + (status.output_device || "default") : "not available") +
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
        server_voice: $("serverVoice").value || "us",
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
      localStorage.setItem("pool.voiceSource", $("voiceSource").value);
      toast("Iggy personality and voice saved", "good");
    } catch (err) {
      toast("Could not save personality: " + err.message, "error");
    }
  }

  async function saveAudioSettings() {
    var payload = {
      audio: {
        local: {
          input_device: $("localMic").value || "default",
          output_device: $("localSpeaker").value || "default"
        },
        browser: {
          mic_device: $("browserMic").value,
          speaker_device: $("browserSpeaker").value,
          voice_source: $("voiceSource").value
        }
      }
    };
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      localStorage.setItem("pool.micDevice", $("browserMic").value);
      localStorage.setItem("pool.speakerDevice", $("browserSpeaker").value);
      localStorage.setItem("pool.voiceSource", $("voiceSource").value);
      if (config) {
        config.audio = config.audio || {};
        config.audio.local = payload.audio.local;
      }
      toast("Microphone and speaker settings saved", "good");
    } catch (err) {
      toast("Could not save audio devices: " + err.message, "error");
    }
  }

  async function saveServerKey() {
    var key = $("voiceKey").value.trim();
    if (!key) { toast("Enter an OpenCode API key first", "error"); return; }
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
    if (!img) return;
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

      var alexa = config.alexa || {};
      $("alexaEnabled").checked = alexa.enabled !== false;
      $("alexaSkillName").value = alexa.skill_name || "";
      $("alexaEndpoint").textContent = "Endpoint: " +
        ((pi.public_url || location.origin) + "/alexa");
      $("alexaSkillInfo").textContent = "Skill: " + (alexa.skill_name || "Shobots Pool") +
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
    });
    add("Spa air blower", resolved.blower && resolved.blower.circuit);
    ["pool", "spa"].forEach(function (body) {
      add("Light: " + body, resolved.lights && resolved.lights[body]);
    });
    add("Heater body", resolved.heater && resolved.heater.body);
    add("Heater device", resolved.heater && resolved.heater.device);
    box.innerHTML = rows.join("");
  }

  async function loadAlexa() {
    try {
      var data = await api("/api/alexa");
      $("alexaList").innerHTML = (data.devices || []).map(function (d) {
        return '<div class="alexa-device"><span>' + escapeHtml(d.friendlyName) +
          "</span><span>" + escapeHtml(d.category) + " \u00B7 " + escapeHtml(d.state) + "</span></div>";
      }).join("");
    } catch (err) {
      $("alexaList").textContent = "Alexa preview unavailable: " + err.message;
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
          '<div class="feature-actions">' +
          '<button class="icon-btn" data-act="light">Light</button>' +
          '<button class="icon-btn" data-act="thumper">Thumper</button>' +
          '</div></div>';
      }).join("");
    }
    var baskets = $("firebaskets");
    if (baskets) {
      baskets.innerHTML = ["east", "west"].map(function (key) {
        var title = key === "east" ? "East Firebasket" : "West Firebasket";
        return '<div class="feature-card fire" data-basket="' + key + '">' +
          '<div class="feature-head"><div><div class="feature-title">' + title +
          '</div><div class="feature-sub">Pool &amp; spa fountains off</div></div>' +
          '<label class="switch"><input type="checkbox" data-toggle="firebasket"><span class="slider"></span></label></div>' +
          '<div class="feature-leds">' +
          '<span class="led-pill" data-led="pool"><i></i>Pool fountain</span>' +
          '<span class="led-pill" data-led="spa"><i></i>Spa fountain</span>' +
          '</div></div>';
      }).join("");
    }
  }

  function bind() {
    buildFeatureCards();

    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        tab.classList.add("active");
        var view = $("view-" + tab.getAttribute("data-tab"));
        if (view) view.classList.add("active");
        if (tab.getAttribute("data-tab") === "setup") {
          refreshInventory();
          loadAlexa();
        }
      });
    });

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
    $("deckJets").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      var card = btn.closest("[data-jet]");
      var key = card.getAttribute("data-jet");
      var jet = (state.deck_jets || {})[key] || {};
      if (btn.getAttribute("data-act") === "light") {
        command("set_deck_jet", { id: key, on: true, light: !(jet.light && jet.on) });
      } else {
        command("set_deck_jet", { id: key, on: true, thumper: !(jet.thumper !== false) });
      }
    });
    $("firebaskets").addEventListener("change", function (e) {
      var input = e.target.closest('input[data-toggle="firebasket"]');
      if (!input) return;
      var card = input.closest("[data-basket]");
      command("set_firebasket", { id: card.getAttribute("data-basket"), on: input.checked });
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
    $("spillwayEffect").addEventListener("change", function (e) {
      command("set_spillway_color", { effect: e.target.value });
    });

    $("blowerToggle").addEventListener("change", function (e) {
      command("set_blower", { on: e.target.checked });
    });

    $("heaterToggle").addEventListener("change", function (e) {
      command("set_heater", { on: e.target.checked });
    });
    var heatSlider = $("heaterSetpoint");
    heatSlider.addEventListener("input", function (e) {
      $("heaterSetpointVal").textContent = e.target.value + "\u00B0F";
    });
    heatSlider.addEventListener("change", function (e) {
      command("set_heater", { setpoint: parseInt(e.target.value, 10) });
    });

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

    $("saveSettings").addEventListener("click", saveSettings);
    $("saveAlexa").addEventListener("click", saveAlexaSettings);
    $("refreshInventory").addEventListener("click", refreshInventory);
    $("saveKey").addEventListener("click", function () {
      var key = $("voiceKey").value.trim();
      if (!key) { toast("Enter an OpenCode API key first", "error"); return; }
      localStorage.setItem("pool.geminiKey", key);
      toast("OpenCode key saved in this browser", "good");
    });
    $("saveServerKey").addEventListener("click", saveServerKey);
    $("saveAssistant").addEventListener("click", saveAssistantSettings);
    $("saveAudio").addEventListener("click", saveAudioSettings);
    $("refreshAudio").addEventListener("click", function () { refreshAudioDevices(true); });
    $("personalitySelect").addEventListener("change", updatePersonaVisibility);
    $("speakRate").addEventListener("input", updateRateReadouts);
    $("speakPitch").addEventListener("input", updateRateReadouts);
    $("voiceSource").addEventListener("change", function () {
      localStorage.setItem("pool.voiceSource", $("voiceSource").value);
    });
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
  }

  function init() {
    bind();
    populateBrowserVoices();
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
    setInterval(function () {
      if (Date.now() - lastAiAt > 22000 && state) renderVoiceBubble();
    }, 6000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();

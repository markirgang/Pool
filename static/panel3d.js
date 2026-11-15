/* Shobots Pool - Procedural Three.js Pentair IntelliCenter Hardware & Motherboard Animation
   Exposes window.panel3d = { init, update, setDoor, toggleDoor, focus, isDoorOpen } */
(function () {
  "use strict";

  var canvas = document.getElementById("panelCanvas");
  if (!canvas || typeof THREE === "undefined") return;

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.0));
  if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06141e, 0.018);

  var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0.0, 1.2, 16.5);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0.0, 0.2, 0.0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4.0;
  controls.maxDistance = 28.0;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.minPolarAngle = Math.PI * 0.1;
  controls.update();

  // ------------------------------------------------------------------
  // Lighting
  // ------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9fe8ff, 0x081520, 0.9));
  var ambient = new THREE.AmbientLight(0x7fcde0, 0.35);
  scene.add(ambient);

  var keyLight = new THREE.DirectionalLight(0xdcf8ff, 1.1);
  keyLight.position.set(-6, 12, 10);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  var cyanRim = new THREE.DirectionalLight(0x43e1e8, 0.65);
  cyanRim.position.set(8, -4, 6);
  scene.add(cyanRim);

  var internalLedGlow = new THREE.PointLight(0x4df0a0, 0.8, 12);
  internalLedGlow.position.set(0, 1.5, 1.2);
  scene.add(internalLedGlow);

  // ------------------------------------------------------------------
  // Materials
  // ------------------------------------------------------------------
  var metalCabinetMat = new THREE.MeshStandardMaterial({
    color: 0x4a565d,
    roughness: 0.55,
    metalness: 0.65
  });
  var interiorBackMat = new THREE.MeshStandardMaterial({
    color: 0x222c33,
    roughness: 0.8,
    metalness: 0.35
  });
  var doorMat = new THREE.MeshStandardMaterial({
    color: 0x3d474e,
    roughness: 0.5,
    metalness: 0.7
  });
  var acrylicWindowMat = new THREE.MeshStandardMaterial({
    color: 0x112836,
    transparent: true,
    opacity: 0.42,
    roughness: 0.12,
    metalness: 0.8
  });
  var pcbMat = new THREE.MeshStandardMaterial({
    color: 0x0c3e21,
    roughness: 0.6,
    metalness: 0.2
  });
  var copperTraceMat = new THREE.MeshStandardMaterial({
    color: 0xb8860b,
    roughness: 0.4,
    metalness: 0.8
  });
  var chipBlackMat = new THREE.MeshStandardMaterial({
    color: 0x14181b,
    roughness: 0.7,
    metalness: 0.2
  });
  var relayMat = new THREE.MeshStandardMaterial({
    color: 0x1e2428,
    roughness: 0.45,
    metalness: 0.3
  });
  var terminalMat = new THREE.MeshStandardMaterial({
    color: 0x2e6b8c,
    roughness: 0.6,
    metalness: 0.2
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function addBox(parent, w, h, d, mat, x, y, z) {
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function addCylinder(parent, rt, rb, h, seg, mat, x, y, z, rx, rz) {
    var mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    mesh.position.set(x, y, z);
    if (rx) mesh.rotation.x = rx;
    if (rz) mesh.rotation.z = rz;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------
  // Enclosure Cabinet
  // ------------------------------------------------------------------
  var panelGroup = new THREE.Group();
  scene.add(panelGroup);

  var CAB = { w: 9.6, h: 14.8, d: 3.2 };

  // Back plate
  addBox(panelGroup, CAB.w, CAB.h, 0.3, interiorBackMat, 0, 0, -CAB.d / 2);
  // Outer frame walls
  addBox(panelGroup, CAB.w, 0.3, CAB.d, metalCabinetMat, 0, CAB.h / 2, 0); // Top
  addBox(panelGroup, CAB.w, 0.3, CAB.d, metalCabinetMat, 0, -CAB.h / 2, 0); // Bottom
  addBox(panelGroup, 0.3, CAB.h, CAB.d, metalCabinetMat, -CAB.w / 2, 0, 0); // Left
  addBox(panelGroup, 0.3, CAB.h, CAB.d, metalCabinetMat, CAB.w / 2, 0, 0); // Right

  // Wall mounting brackets (top & bottom flanges)
  addBox(panelGroup, 2.2, 0.5, 0.2, metalCabinetMat, -CAB.w / 2 + 1.2, CAB.h / 2 + 0.35, -CAB.d / 2);
  addBox(panelGroup, 2.2, 0.5, 0.2, metalCabinetMat, CAB.w / 2 - 1.2, CAB.h / 2 + 0.35, -CAB.d / 2);
  addBox(panelGroup, 2.2, 0.5, 0.2, metalCabinetMat, -CAB.w / 2 + 1.2, -CAB.h / 2 - 0.35, -CAB.d / 2);
  addBox(panelGroup, 2.2, 0.5, 0.2, metalCabinetMat, CAB.w / 2 - 1.2, -CAB.h / 2 - 0.35, -CAB.d / 2);

  // High-voltage barrier dividing shelf (separates low-voltage motherboard from high-voltage conduit bay)
  addBox(panelGroup, CAB.w - 0.6, 0.2, CAB.d - 0.5, metalCabinetMat, 0, -4.2, 0);

  // Lower conduit knockouts / pipes
  for (var ki = -3; ki <= 3; ki += 1.5) {
    addCylinder(panelGroup, 0.45, 0.45, 0.8, 16, metalCabinetMat, ki, -CAB.h / 2 - 0.4, 0.2);
  }

  // ------------------------------------------------------------------
  // Swiveling Front Door with Viewing Window
  // ------------------------------------------------------------------
  var doorPivot = new THREE.Group();
  doorPivot.position.set(-CAB.w / 2, 0, CAB.d / 2);
  panelGroup.add(doorPivot);

  var doorOpen = false;
  var doorTargetAngle = 0;

  var doorPanel = new THREE.Group();
  doorPanel.position.set(CAB.w / 2, 0, 0);
  doorPivot.add(doorPanel);

  // Door outer frame
  addBox(doorPanel, CAB.w + 0.2, CAB.h + 0.2, 0.25, doorMat, 0, 0, 0);

  // Door acrylic window (recessed viewing port)
  var doorWindow = addBox(doorPanel, CAB.w - 2.2, CAB.h - 4.5, 0.12, acrylicWindowMat, 0, 1.2, 0.08);

  // Door handle on right
  addBox(doorPanel, 0.35, 1.4, 0.4, metalCabinetMat, CAB.w / 2 - 0.4, 0, 0.3);
  addBox(doorPanel, 0.2, 0.8, 0.5, metalCabinetMat, CAB.w / 2 - 0.4, 0, 0.45);

  // ------------------------------------------------------------------
  // Upper Section: Pentair IntelliCenter Touchscreen Display
  // ------------------------------------------------------------------
  var displayGroup = new THREE.Group();
  displayGroup.position.set(0, 4.4, -0.6);
  panelGroup.add(displayGroup);

  // Display housing bezel (sleek curved black enclosure)
  addBox(displayGroup, 7.8, 4.4, 0.6, chipBlackMat, 0, 0, 0);
  // Brand header bar
  addBox(displayGroup, 7.4, 0.6, 0.1, new THREE.MeshStandardMaterial({ color: 0x081720, roughness: 0.4 }), 0, 1.7, 0.32);

  // Dynamic LCD Canvas & Texture
  var lcdCanvas = document.createElement("canvas");
  lcdCanvas.width = 512;
  lcdCanvas.height = 320;
  var lcdCtx = lcdCanvas.getContext("2d");

  var lcdTex = new THREE.CanvasTexture(lcdCanvas);
  if (THREE.sRGBEncoding !== undefined) lcdTex.outputEncoding = THREE.sRGBEncoding;

  var lcdScreenMat = new THREE.MeshBasicMaterial({ map: lcdTex });
  var lcdScreen = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 3.2), lcdScreenMat);
  lcdScreen.position.set(0, -0.2, 0.32);
  displayGroup.add(lcdScreen);

  // Pentair blue emblem
  var pentairBadge = addBox(displayGroup, 1.6, 0.3, 0.05, new THREE.MeshStandardMaterial({
    color: 0x0088cc, emissive: 0x004466, emissiveIntensity: 0.6
  }), 0, 1.7, 0.38);

  // ------------------------------------------------------------------
  // Middle Section: Motherboard / Personality PCB
  // ------------------------------------------------------------------
  var boardGroup = new THREE.Group();
  boardGroup.position.set(0, -0.6, -0.9);
  panelGroup.add(boardGroup);

  // Green PCB main board
  var pcbBoard = addBox(boardGroup, 8.4, 6.2, 0.15, pcbMat, 0, 0, 0);

  // Silk-screen circuit traces
  for (var ti = -3.5; ti <= 3.5; ti += 0.8) {
    addBox(boardGroup, 0.08, 5.4, 0.04, copperTraceMat, ti, 0, 0.09);
    addBox(boardGroup, 7.2, 0.08, 0.04, copperTraceMat, 0, ti * 0.7, 0.09);
  }

  // Main Microprocessor chip (center)
  var cpuChip = addBox(boardGroup, 1.6, 1.6, 0.3, chipBlackMat, 0, 0.6, 0.2);
  // CPU heat sink
  for (var fi = -0.6; fi <= 0.6; fi += 0.25) {
    addBox(boardGroup, 1.4, 0.08, 0.4, metalCabinetMat, 0, 0.6 + fi, 0.4);
  }

  // Power supply section (left)
  var powerTransformer = addBox(boardGroup, 1.6, 1.6, 1.4, metalCabinetMat, -3.0, 1.6, 0.7);
  var cap1 = addCylinder(boardGroup, 0.4, 0.4, 1.2, 16, chipBlackMat, -1.8, 1.8, 0.6, Math.PI / 2);
  var cap2 = addCylinder(boardGroup, 0.4, 0.4, 1.2, 16, chipBlackMat, -1.8, 1.0, 0.6, Math.PI / 2);

  // Main Power Indicator LED (+24V / +5V OK - glowing green)
  var powerLedMat = new THREE.MeshStandardMaterial({
    color: 0x4df0a0,
    emissive: 0x4df0a0,
    emissiveIntensity: 2.5
  });
  var powerLed = addCylinder(boardGroup, 0.12, 0.12, 0.2, 12, powerLedMat, -3.2, 2.6, 0.15, Math.PI / 2);

  // ------------------------------------------------------------------
  // Relay Bank (High-Voltage Relays 1 to 8 + Filter Pump)
  // ------------------------------------------------------------------
  var RELAY_LABELS = [
    "FILTER PUMP", "AUX 1", "AUX 2", "AUX 3",
    "AUX 4", "AUX 5", "AUX 6", "AUX 7"
  ];
  var relays = [];

  var relayStartX = -3.2;
  var relaySpacing = 0.92;
  var relayY = -1.6;

  for (var ri = 0; ri < 8; ri++) {
    var rx = relayStartX + ri * relaySpacing;
    var rBox = addBox(boardGroup, 0.76, 1.2, 0.9, relayMat, rx, relayY, 0.5);

    // Relay contact status LED (glowing neon green/cyan when active)
    var rLedMat = new THREE.MeshStandardMaterial({
      color: 0x1a2e22,
      emissive: 0x000000,
      emissiveIntensity: 0.0
    });
    var rLed = addCylinder(boardGroup, 0.1, 0.1, 0.2, 12, rLedMat, rx, relayY + 0.75, 0.5, Math.PI / 2);

    // Light point for contact illumination
    var rLight = new THREE.PointLight(0x4df0a0, 0, 1.8);
    rLight.position.set(rx, relayY + 0.8, 0.8);
    boardGroup.add(rLight);

    // Terminal screws on bottom
    addCylinder(boardGroup, 0.1, 0.1, 0.15, 8, copperTraceMat, rx - 0.2, relayY - 0.7, 0.3, Math.PI / 2);
    addCylinder(boardGroup, 0.1, 0.1, 0.15, 8, copperTraceMat, rx + 0.2, relayY - 0.7, 0.3, Math.PI / 2);

    relays.push({
      index: ri,
      name: RELAY_LABELS[ri],
      box: rBox,
      led: rLed,
      mat: rLedMat,
      light: rLight,
      on: false,
      circuit: null
    });
  }

  // ------------------------------------------------------------------
  // Valve Actuator Sockets (A / Intake, B / Return, Aux 1, Aux 2)
  // ------------------------------------------------------------------
  var VALVE_PORTS = ["VALVE A (INTAKE)", "VALVE B (RETURN)", "AUX VALVE 1", "AUX VALVE 2"];
  var valveSockets = [];

  for (var vi = 0; vi < 4; vi++) {
    var vx = -2.6 + vi * 1.7;
    var vy = -2.6;
    var vSoc = addBox(boardGroup, 1.2, 0.5, 0.4, terminalMat, vx, vy, 0.3);

    // Valve direction indicator dial / arrow
    var vCamMat = new THREE.MeshStandardMaterial({ color: 0xffaa33, emissive: 0x884400, emissiveIntensity: 0.8 });
    var vCam = addBox(boardGroup, 0.6, 0.12, 0.1, vCamMat, vx, vy + 0.35, 0.35);

    valveSockets.push({
      index: vi,
      name: VALVE_PORTS[vi],
      box: vSoc,
      cam: vCam,
      angle: 0
    });
  }

  // ------------------------------------------------------------------
  // RS-485 Comms Bus & Comms Status LEDs (Blinking Data Traffic)
  // ------------------------------------------------------------------
  var comTerminal1 = addBox(boardGroup, 1.4, 0.6, 0.4, terminalMat, 2.8, 1.8, 0.3); // COM1 (Pumps)
  var comTerminal2 = addBox(boardGroup, 1.4, 0.6, 0.4, terminalMat, 2.8, 0.9, 0.3); // COM2 (Salt Chlorinator)

  // Blinking RS-485 TX/RX LEDs (yellow/amber)
  var comLedMat1 = new THREE.MeshStandardMaterial({ color: 0xffbb00, emissive: 0xffaa00, emissiveIntensity: 0.5 });
  var comLed1 = addCylinder(boardGroup, 0.09, 0.09, 0.15, 8, comLedMat1, 3.65, 1.8, 0.35, Math.PI / 2);

  var comLedMat2 = new THREE.MeshStandardMaterial({ color: 0xffbb00, emissive: 0xffaa00, emissiveIntensity: 0.5 });
  var comLed2 = addCylinder(boardGroup, 0.09, 0.09, 0.15, 8, comLedMat2, 3.65, 0.9, 0.35, Math.PI / 2);

  // Ethernet / Network Link & Activity LEDs
  var ethSocket = addBox(boardGroup, 1.0, 0.8, 0.7, metalCabinetMat, 3.0, 2.6, 0.4);
  var ethLinkMat = new THREE.MeshStandardMaterial({ color: 0x4df0a0, emissive: 0x4df0a0, emissiveIntensity: 2.2 });
  var ethLinkLed = addCylinder(boardGroup, 0.08, 0.08, 0.12, 8, ethLinkMat, 2.7, 2.9, 0.75, Math.PI / 2);

  var ethActMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff8800, emissiveIntensity: 1.0 });
  var ethActLed = addCylinder(boardGroup, 0.08, 0.08, 0.12, 8, ethActMat, 3.3, 2.9, 0.75, Math.PI / 2);

  // ------------------------------------------------------------------
  // Touchscreen LCD Texture Drawing
  // ------------------------------------------------------------------
  var lastLcdDraw = 0;
  var cachedState = null;
  var cachedInv = null;

  function drawLcdScreen(stateData, invData) {
    var state = stateData || {};
    var mode = (state.mode || "pool").toUpperCase();
    var isPool = mode === "POOL";
    var poolTemp = state.bodies && state.bodies.pool && state.bodies.pool.temp;
    var spaTemp = state.bodies && state.bodies.spa && state.bodies.spa.temp;
    var mainPump = state.pumps && state.pumps.main;
    var mainRpm = mainPump && mainPump.on ? mainPump.rpm : 0;
    var isHeating = state.heater && state.heater.on;
    var heaterSp = state.heater && state.heater.setpoint;
    var conn = state.connection || {};
    var isOnline = !!conn.connected;

    lcdCtx.fillStyle = "#071822";
    lcdCtx.fillRect(0, 0, 512, 320);

    // Gradient background header
    var headGrad = lcdCtx.createLinearGradient(0, 0, 512, 42);
    headGrad.addColorStop(0, "#0b2b3d");
    headGrad.addColorStop(1, "#071c28");
    lcdCtx.fillStyle = headGrad;
    lcdCtx.fillRect(0, 0, 512, 42);

    // Pentair Logo & System title
    lcdCtx.fillStyle = "#43e1e8";
    lcdCtx.font = "bold 15px sans-serif";
    lcdCtx.fillText("PENTAIR INTELLICENTER", 16, 26);

    // Connection icon / text
    lcdCtx.font = "bold 12px monospace";
    lcdCtx.fillStyle = isOnline ? "#55efc4" : "#ffeaa7";
    lcdCtx.fillText(isOnline ? "TCP 6681 ● ONLINE" : "● SIMULATION", 360, 26);

    // Active Mode Card (left)
    lcdCtx.fillStyle = isPool ? "rgba(67, 225, 232, 0.14)" : "rgba(181, 140, 255, 0.14)";
    lcdCtx.strokeStyle = isPool ? "#43e1e8" : "#b58cff";
    lcdCtx.lineWidth = 2;
    lcdCtx.beginPath();
    lcdCtx.roundRect(16, 54, 230, 110, 10);
    lcdCtx.fill();
    lcdCtx.stroke();

    lcdCtx.fillStyle = isPool ? "#43e1e8" : "#b58cff";
    lcdCtx.font = "bold 20px sans-serif";
    lcdCtx.fillText(isPool ? "🏊 POOL MODE" : "♨️ SPA MODE", 32, 88);

    lcdCtx.fillStyle = "#e8f7fb";
    lcdCtx.font = "14px sans-serif";
    lcdCtx.fillText("Water Temp: " + (poolTemp ? poolTemp + "°F" : "84°F"), 32, 118);
    lcdCtx.fillText("Spa Water:  " + (spaTemp ? spaTemp + "°F" : "102°F"), 32, 142);

    // Main Pump Card (right)
    lcdCtx.fillStyle = "rgba(7, 25, 36, 0.8)";
    lcdCtx.strokeStyle = "rgba(135, 168, 183, 0.3)";
    lcdCtx.beginPath();
    lcdCtx.roundRect(266, 54, 230, 110, 10);
    lcdCtx.fill();
    lcdCtx.stroke();

    lcdCtx.fillStyle = "#58a7ff";
    lcdCtx.font = "bold 16px sans-serif";
    lcdCtx.fillText("⚙️ MAIN VSR PUMP", 282, 84);

    lcdCtx.fillStyle = mainRpm > 0 ? "#55efc4" : "#87a8b7";
    lcdCtx.font = "bold 24px monospace";
    lcdCtx.fillText(mainRpm > 0 ? mainRpm + " RPM" : "OFF", 282, 120);

    lcdCtx.fillStyle = "#87a8b7";
    lcdCtx.font = "12px sans-serif";
    lcdCtx.fillText(mainRpm > 0 ? "Circulation active · 45 GPM" : "Pump standby", 282, 145);

    // Lower status cards: Heater, Lights, Water Features
    // Heater badge
    lcdCtx.fillStyle = isHeating ? "rgba(255, 180, 95, 0.2)" : "rgba(8, 28, 40, 0.7)";
    lcdCtx.strokeStyle = isHeating ? "#ffb45f" : "rgba(135, 168, 183, 0.2)";
    lcdCtx.beginPath();
    lcdCtx.roundRect(16, 178, 150, 80, 8);
    lcdCtx.fill();
    lcdCtx.stroke();

    lcdCtx.fillStyle = isHeating ? "#ffb45f" : "#87a8b7";
    lcdCtx.font = "bold 13px sans-serif";
    lcdCtx.fillText("🔥 HEATER", 28, 204);
    lcdCtx.font = "16px monospace";
    lcdCtx.fillText(isHeating ? "FIRING " + (heaterSp || 84) + "°F" : "STANDBY", 28, 234);

    // Lights badge
    var poolLightOn = state.lights && state.lights.pool && state.lights.pool.on;
    var lightEffect = (state.lights && state.lights.pool && state.lights.pool.effect) || "BLUER";
    lcdCtx.fillStyle = poolLightOn ? "rgba(67, 225, 232, 0.2)" : "rgba(8, 28, 40, 0.7)";
    lcdCtx.strokeStyle = poolLightOn ? "#43e1e8" : "rgba(135, 168, 183, 0.2)";
    lcdCtx.beginPath();
    lcdCtx.roundRect(180, 178, 150, 80, 8);
    lcdCtx.fill();
    lcdCtx.stroke();

    lcdCtx.fillStyle = poolLightOn ? "#43e1e8" : "#87a8b7";
    lcdCtx.font = "bold 13px sans-serif";
    lcdCtx.fillText("💡 POOL LED", 192, 204);
    lcdCtx.font = "13px monospace";
    lcdCtx.fillText(poolLightOn ? "ON: " + lightEffect : "OFF", 192, 234);

    // Water Features badge
    var anyJets = state.deck_jets && Object.keys(state.deck_jets).some(function (k) { return state.deck_jets[k].on; });
    var anyFp = state.firebaskets && Object.keys(state.firebaskets).some(function (k) { return state.firebaskets[k].on; });
    var featOn = anyJets || anyFp;
    lcdCtx.fillStyle = featOn ? "rgba(98, 230, 166, 0.2)" : "rgba(8, 28, 40, 0.7)";
    lcdCtx.strokeStyle = featOn ? "#62e6a6" : "rgba(135, 168, 183, 0.2)";
    lcdCtx.beginPath();
    lcdCtx.roundRect(344, 178, 150, 80, 8);
    lcdCtx.fill();
    lcdCtx.stroke();

    lcdCtx.fillStyle = featOn ? "#62e6a6" : "#87a8b7";
    lcdCtx.font = "bold 13px sans-serif";
    lcdCtx.fillText("⛲ FEATURES", 356, 204);
    lcdCtx.font = "13px monospace";
    lcdCtx.fillText(featOn ? "ACTIVE" : "STANDBY", 356, 234);

    // Bottom OS bar
    lcdCtx.fillStyle = "#030e15";
    lcdCtx.fillRect(0, 276, 512, 44);
    lcdCtx.fillStyle = "#87a8b7";
    lcdCtx.font = "12px monospace";
    lcdCtx.fillText("STATUS: AUTO-NORMAL · FW v1.064 · RS485 ACTIVE", 16, 302);

    lcdTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------
  // Camera Presets
  // ------------------------------------------------------------------
  var targetCamPos = camera.position.clone();
  var targetLookAt = controls.target.clone();

  function focus(which) {
    if (which === "screen") {
      targetLookAt.set(0, 4.4, -0.2);
      targetCamPos.set(0, 4.4, 6.2);
    } else if (which === "motherboard") {
      targetLookAt.set(0, -0.6, -0.6);
      targetCamPos.set(0, -0.6, 9.5);
    } else if (which === "valves") {
      targetLookAt.set(0, -3.2, 0.0);
      targetCamPos.set(0, -2.5, 7.5);
    } else {
      // Cabinet overall
      targetLookAt.set(0, 0.2, 0);
      targetCamPos.set(0, 1.2, 16.5);
    }
  }

  function setDoor(open) {
    doorOpen = !!open;
    doorTargetAngle = doorOpen ? -Math.PI * 0.72 : 0;
    var badge = document.getElementById("p3dDoorBadge");
    if (badge) {
      badge.textContent = doorOpen ? "DOOR OPEN" : "DOOR CLOSED";
      badge.className = "chip " + (doorOpen ? "live" : "");
    }
    var btn = document.getElementById("p3dToggleDoorBtn");
    if (btn) btn.textContent = doorOpen ? "🚪 Close Door" : "🚪 Open Door";
  }

  function toggleDoor() {
    setDoor(!doorOpen);
  }

  // ------------------------------------------------------------------
  // Interactive Raycasting (Clicking on Door, Screen, Relays)
  // ------------------------------------------------------------------
  var raycaster = new THREE.Raycaster();
  var mouse = new THREE.Vector2();

  canvas.addEventListener("click", function (e) {
    var rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    var intersects = raycaster.intersectObjects(panelGroup.children, true);

    if (intersects.length > 0) {
      var hit = intersects[0].object;

      // Click on Door / Window to toggle door
      if (hit === doorWindow || hit.parent === doorPanel || hit.parent === doorPivot) {
        toggleDoor();
        return;
      }

      // Click on LCD screen to focus touchscreen
      if (hit === lcdScreen || hit.parent === displayGroup) {
        focus("screen");
        return;
      }

      // Click on a relay to toggle or inspect
      for (var i = 0; i < relays.length; i++) {
        var r = relays[i];
        if (hit === r.box || hit === r.led) {
          if (r.circuit) {
            // Trigger device control toggle via window.poolControl
            if (typeof window.controlDevice === "function") {
              window.controlDevice(r.circuit.objnam, !r.on);
            }
          }
          return;
        }
      }
    }
  });

  // ------------------------------------------------------------------
  // State Update
  // ------------------------------------------------------------------
  function update(stateData, invData) {
    cachedState = stateData;
    cachedInv = invData;

    drawLcdScreen(stateData, invData);

    var inv = invData || (stateData && stateData.inventory) || {};
    var objects = inv.objects || [];
    var circuits = inv.circuits || [];
    var valves = inv.valves || [];
    var conn = (stateData && stateData.connection) || {};
    var isOnline = !!conn.connected;

    // Update connection badge
    var connBadge = document.getElementById("p3dConnBadge");
    if (connBadge) {
      connBadge.textContent = isOnline ? "INTELLICENTER ONLINE (TCP 6681)" : "SIMULATION MODE";
      connBadge.className = "chip " + (isOnline ? "live" : "simulation");
    }

    // Update relays based on circuits
    var activeRelaysCount = 0;
    for (var ri = 0; ri < relays.length; ri++) {
      var r = relays[ri];
      var circuit = circuits[ri] || objects[ri];
      r.circuit = circuit;
      if (circuit) {
        var isOn = (circuit.status === "ON" || circuit.status === "10" || circuit.status === "HEAT" || circuit.status === "2");
        r.on = isOn;
        r.mat.color.setHex(isOn ? 0x4df0a0 : 0x1a2e22);
        r.mat.emissive.setHex(isOn ? 0x4df0a0 : 0x000000);
        r.mat.emissiveIntensity = isOn ? 2.8 : 0.0;
        r.light.intensity = isOn ? 1.5 : 0.0;
        if (isOn) activeRelaysCount++;
      } else {
        r.on = false;
        r.mat.emissiveIntensity = 0;
        r.light.intensity = 0;
      }
    }

    var rBadge = document.getElementById("p3dActiveRelaysBadge");
    if (rBadge) rBadge.textContent = "RELAYS: " + activeRelaysCount + "/8 ACTIVE";

    // Update valve cam dials
    if (valveSockets[0]) {
      // Intake / drain valve
      var mode = stateData && stateData.mode;
      var drainAngle = (mode === "spa") ? Math.PI * 0.75 : 0.2;
      valveSockets[0].cam.rotation.z = drainAngle;
    }
    if (valveSockets[1]) {
      // Return valve
      var retAngle = (mode === "spa") ? 0.2 : Math.PI * 0.75;
      valveSockets[1].cam.rotation.z = retAngle;
    }
  }

  // ------------------------------------------------------------------
  // Main Render Loop
  // ------------------------------------------------------------------
  var clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    var t = clock.getElapsedTime();

    // Smooth door rotation
    if (Math.abs(doorPivot.rotation.y - doorTargetAngle) > 0.002) {
      doorPivot.rotation.y += (doorTargetAngle - doorPivot.rotation.y) * 0.08;
    }

    // Smooth camera transition toward targets
    camera.position.lerp(targetCamPos, 0.06);
    controls.target.lerp(targetLookAt, 0.06);
    controls.update();

    // RS-485 Comms LEDs flickering simulation (active serial packets)
    var pulse1 = Math.sin(t * 18.0) > 0.35 ? 2.2 : 0.2;
    var pulse2 = Math.cos(t * 14.0) > 0.4 ? 2.0 : 0.15;
    comLedMat1.emissiveIntensity = pulse1;
    comLedMat2.emissiveIntensity = pulse2;

    // Ethernet Activity LED flicker
    var ethFlicker = (Math.sin(t * 22.0) + Math.cos(t * 33.0)) > 0.5 ? 2.0 : 0.1;
    ethActMat.emissiveIntensity = ethFlicker;

    // Redraw LCD periodically (every 1 second)
    if (t - lastLcdDraw > 1.0) {
      lastLcdDraw = t;
      drawLcdScreen(cachedState, cachedInv);
    }

    renderer.render(scene, camera);
  }
  animate();

  // Initial render of empty LCD
  drawLcdScreen({}, {});

  // Resize handler
  function handleResize() {
    var rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : canvas.getBoundingClientRect();
    var w = rect.width || canvas.clientWidth || 600;
    var h = rect.height || canvas.clientHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  window.addEventListener("resize", handleResize);
  setTimeout(handleResize, 100);

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  window.panel3d = {
    init: handleResize,
    update: update,
    setDoor: setDoor,
    toggleDoor: toggleDoor,
    isDoorOpen: function () { return doorOpen; },
    focus: focus
  };
})();

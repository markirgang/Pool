/* Shobots Pool - procedural Three.js pool, spa, firebaskets and Iggy the iguana.
   Exposes window.pool3d = { update(state), setTalking(on) }. */
(function () {
  "use strict";

  var canvas = document.getElementById("poolCanvas");
  if (!canvas || typeof THREE === "undefined") return;

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04131d, 0.014);

  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  camera.position.set(17.5, 14.5, 19.5);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(-1.2, 0.4, 1.2);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 10;
  controls.maxDistance = 48;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.update();

  // ------------------------------------------------------------------
  // Lights and materials
  // ------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9fe8ff, 0x122029, 0.85));
  var ambient = new THREE.AmbientLight(0x7fcde0, 0.28);
  scene.add(ambient);

  var sun = new THREE.DirectionalLight(0xd6f7ff, 1.15);
  sun.position.set(-10, 22, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -24;
  sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -24;
  scene.add(sun);

  var deckMat = new THREE.MeshStandardMaterial({ color: 0x1d3c46, roughness: 0.93, metalness: 0.04 });
  var deckMat2 = new THREE.MeshStandardMaterial({ color: 0x234a55, roughness: 0.9, metalness: 0.05 });
  var copingMat = new THREE.MeshStandardMaterial({ color: 0x8eb6bd, roughness: 0.7, metalness: 0.1 });
  var darkStone = new THREE.MeshStandardMaterial({ color: 0x1a2c33, roughness: 0.85, metalness: 0.12 });
  var metalMat = new THREE.MeshStandardMaterial({ color: 0x6a8790, roughness: 0.45, metalness: 0.65 });
  var waterMat = new THREE.MeshStandardMaterial({
    color: 0x0d7c9f, transparent: true, opacity: 0.88,
    roughness: 0.16, metalness: 0.18, emissive: 0x0a516b, emissiveIntensity: 0.5
  });
  var spaWaterMat = new THREE.MeshStandardMaterial({
    color: 0x1690ad, transparent: true, opacity: 0.9,
    roughness: 0.14, metalness: 0.16, emissive: 0x0a516b, emissiveIntensity: 0.55
  });

  var waterMatBase = waterMat.emissive.clone();
  var spaWaterMatBase = spaWaterMat.emissive.clone();

  // ------------------------------------------------------------------
  // Deck and pool shells
  // ------------------------------------------------------------------
  var deck = new THREE.Mesh(new THREE.PlaneGeometry(46, 46, 1, 1), deckMat);
  deck.rotation.x = -Math.PI / 2;
  deck.receiveShadow = true;
  scene.add(deck);

  // subtle deck insets
  for (var di = 0; di < 3; di++) {
    var inset = new THREE.Mesh(new THREE.PlaneGeometry(30 - di * 6, 24 - di * 5), deckMat2);
    inset.rotation.x = -Math.PI / 2;
    inset.position.y = 0.006 + di * 0.001;
    inset.receiveShadow = true;
    scene.add(inset);
  }

  var POOL = { x: -2, z: 1, w: 10.6, d: 6.6, y: 0.09 };
  var SPA = { x: 5.1, z: -4.1, w: 3.8, d: 3.8, y: 0.78 };

  function addBox(w, h, d, mat, x, y, z) {
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // Pool shell: dark basin below the animated water surface
  addBox(POOL.w + 0.5, 1.8, POOL.d + 0.5, new THREE.MeshStandardMaterial({
    color: 0x0a3949, roughness: 0.9, metalness: 0.05
  }), POOL.x, -0.85, POOL.z);
  // coping frame
  addBox(POOL.w + 1.1, 0.18, 0.5, copingMat, POOL.x, 0.12, POOL.z - POOL.d / 2 - 0.3);
  addBox(POOL.w + 1.1, 0.18, 0.5, copingMat, POOL.x, 0.12, POOL.z + POOL.d / 2 + 0.3);
  addBox(0.5, 0.18, POOL.d + 0.2, copingMat, POOL.x - POOL.w / 2 - 0.3, 0.12, POOL.z);
  addBox(0.5, 0.18, POOL.d + 0.2, copingMat, POOL.x + POOL.w / 2 + 0.3, 0.12, POOL.z);

  var poolWaterGeo = new THREE.PlaneGeometry(POOL.w, POOL.d, 48, 28);
  var poolWater = new THREE.Mesh(poolWaterGeo, waterMat);
  poolWater.rotation.x = -Math.PI / 2;
  poolWater.position.set(POOL.x, POOL.y, POOL.z);
  poolWater.receiveShadow = true;
  scene.add(poolWater);
  var poolBase = poolWaterGeo.attributes.position.array.slice(0);

  // Spa raised platform and shell
  addBox(SPA.w + 1.7, 0.8, SPA.d + 1.7, deckMat2, SPA.x, 0.4, SPA.z);
  addBox(SPA.w + 0.9, 0.9, SPA.d + 0.9, new THREE.MeshStandardMaterial({
    color: 0x123d49, roughness: 0.75, metalness: 0.1
  }), SPA.x, 0.52, SPA.z);
  addBox(SPA.w + 1.0, 0.16, 0.34, copingMat, SPA.x, 0.95, SPA.z - SPA.d / 2 - 0.18);
  addBox(SPA.w + 1.0, 0.16, 0.34, copingMat, SPA.x, 0.95, SPA.z + SPA.d / 2 + 0.18);
  addBox(0.34, 0.16, SPA.d + 0.1, copingMat, SPA.x - SPA.w / 2 - 0.18, 0.95, SPA.z);
  addBox(0.34, 0.16, SPA.d + 0.1, copingMat, SPA.x + SPA.w / 2 + 0.18, 0.95, SPA.z);

  var spaWaterGeo = new THREE.PlaneGeometry(SPA.w, SPA.d, 24, 24);
  var spaWater = new THREE.Mesh(spaWaterGeo, spaWaterMat);
  spaWater.rotation.x = -Math.PI / 2;
  spaWater.position.set(SPA.x, SPA.y, SPA.z);
  spaWater.receiveShadow = true;
  scene.add(spaWater);
  var spaBase = spaWaterGeo.attributes.position.array.slice(0);

  // Spa spillway lip toward the pool
  var spaLip = addBox(1.4, 0.12, 0.7, waterMat, SPA.x - 0.2, SPA.y - 0.02, SPA.z + SPA.d / 2 + 0.2);
  spaLip.material = waterMat;

  // ------------------------------------------------------------------
  // Labels (canvas sprites)
  // ------------------------------------------------------------------
  function makeLabel(text, color) {
    var c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    var ctx = c.getContext("2d");
    var tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false
    }));
    sprite.scale.set(3.6, 0.9, 1);
    sprite.userData = { canvas: c, ctx: ctx, tex: tex, color: color || "#a9f4ff", text: "" };
    scene.add(sprite);
    updateLabel(sprite, text, color);
    return sprite;
  }

  function updateLabel(sprite, text, color) {
    if (!sprite || !sprite.userData) return;
    var d = sprite.userData;
    if (d.text === text && !color) return;
    d.text = text;
    var ctx = d.ctx;
    var c = d.canvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = "700 44px Segoe UI, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var w = ctx.measureText(text).width + 54;
    ctx.fillStyle = "rgba(4, 17, 26, 0.72)";
    ctx.strokeStyle = color || d.color;
    ctx.lineWidth = 4;
    roundRect(ctx, (c.width - w) / 2, 24, w, 80, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color || d.color;
    ctx.fillText(text, c.width / 2, 66);
    d.tex.needsUpdate = true;
    sprite.scale.set(Math.max(2.4, Math.min(6.8, text.length * 0.24)), 0.85, 1);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var poolLabel = makeLabel("POOL", "#a9f4ff");
  poolLabel.position.set(POOL.x, 2.3, POOL.z);
  var spaLabel = makeLabel("SPA", "#d9c4ff");
  spaLabel.position.set(SPA.x, 2.7, SPA.z);
  var modeLabel = makeLabel("POOL MODE", "#7df0ef");
  modeLabel.position.set(-1.2, 3.55, 1.2);
  var saltLabel = makeLabel("SALT -- ppm", "#8fe9f5");
  saltLabel.position.set(-8.7, 2.9, 3.1);

  // ------------------------------------------------------------------
  // Deck jets
  // ------------------------------------------------------------------
  var jetDefs = {
    ne: { x: 3.9, z: -3.5, target: [-1.2, 0.1, -0.2] },
    nw: { x: -7.9, z: -3.5, target: [-2.9, 0.1, -0.2] },
    se: { x: 3.9, z: 5.6, target: [-1.2, 0.1, 2.2] },
    sw: { x: -7.9, z: 5.6, target: [-2.9, 0.1, 2.2] }
  };
  var jets = {};

  Object.keys(jetDefs).forEach(function (key) {
    var def = jetDefs[key];
    var group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    scene.add(group);

    var nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.34, 14), metalMat);
    nozzle.position.y = 0.17;
    nozzle.castShadow = true;
    group.add(nozzle);
    var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 14),
      new THREE.MeshStandardMaterial({ color: 0x9fdde6, emissive: 0x2bb9d0, emissiveIntensity: 0.8 }));
    cap.position.y = 0.37;
    group.add(cap);

    var curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(def.x, 0.42, def.z),
      new THREE.Vector3((def.x + def.target[0]) / 2, 3.0, (def.z + def.target[2]) / 2),
      new THREE.Vector3(def.target[0], def.target[1], def.target[2])
    );
    var tubeGeo = new THREE.TubeGeometry(curve, 40, 0.075, 8, false);
    var tubeMat = new THREE.MeshBasicMaterial({
      color: 0xbdfbff, transparent: true, opacity: 0.0, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var tube = new THREE.Mesh(tubeGeo, tubeMat);
    scene.add(tube);

    var drops = [];
    for (var i = 0; i < 12; i++) {
      var drop = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xdcffff, transparent: true, opacity: 0.95 }));
      drop.visible = false;
      scene.add(drop);
      drops.push({ mesh: drop, offset: i / 12, bump: Math.random() * 6.28 });
    }

    var label = makeLabel(key.toUpperCase() + " JET OFF", "#8fe9f5");
    label.position.set(def.x, 1.25, def.z);

    jets[key] = {
      group: group, curve: curve, tube: tube, tubeMat: tubeMat,
      drops: drops, label: label, on: false, light: false, thumper: true, seed: Math.random() * 20
    };
  });

  // ------------------------------------------------------------------
  // Firebaskets with two spillways and LED strips
  // ------------------------------------------------------------------
  var basketDefs = {
    east: { x: 6.65, z: -2.08 },
    west: { x: 3.55, z: -2.08 }
  };
  var baskets = {};

  function createFlame(x, y, z, scale) {
    var flame = new THREE.Mesh(new THREE.ConeGeometry(0.15 * scale, 0.7 * scale, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffb45f, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      }));
    flame.position.set(x, y, z);
    return flame;
  }

  Object.keys(basketDefs).forEach(function (key) {
    var def = basketDefs[key];
    var group = new THREE.Group();
    group.position.set(def.x, SPA.y - 0.03, def.z);
    scene.add(group);

    var bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.44, 0.5, 8), darkStone);
    bowl.position.y = 0.25;
    bowl.castShadow = true;
    group.add(bowl);

    var ember = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 14),
      new THREE.MeshStandardMaterial({ color: 0x2a1b13, emissive: 0xff6a1a, emissiveIntensity: 0.0 }));
    ember.position.y = 0.51;
    group.add(ember);

    var flames = [];
    for (var f = 0; f < 4; f++) {
      var flame = createFlame((Math.random() - 0.5) * 0.3, 0.85 + Math.random() * 0.15,
        (Math.random() - 0.5) * 0.3, 0.8 + Math.random() * 0.7);
      flame.visible = false;
      group.add(flame);
      flames.push(flame);
    }
    var glow = new THREE.PointLight(0xff8c3a, 0.0, 7, 2);
    glow.position.set(0, 1.1, 0);
    group.add(glow);

    // pool-side and spa-side spillways with LED strips
    function spillway(dir) {
      var sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.75, 1, 8),
        new THREE.MeshBasicMaterial({
          color: 0x8defff, transparent: true, opacity: 0.0,
          side: THREE.DoubleSide, depthWrite: false
        }));
      sheet.rotation.x = -Math.PI / 2;
      sheet.position.set(0, 0.02, dir * 0.56);
      sheet.rotation.x = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(sheet);

      var ledMat = new THREE.MeshStandardMaterial({
        color: 0x2a80ff, emissive: 0x2a80ff, emissiveIntensity: 0.0
      });
      var led = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.1, 0.08), ledMat);
      led.position.set(0, 0.1, dir * 0.62);
      group.add(led);
      var ledLight = new THREE.PointLight(0x2a80ff, 0.0, 3.4, 2);
      ledLight.position.set(0, 0.2, dir * 0.7);
      group.add(ledLight);
      return { sheet: sheet, led: led, ledMat: ledMat, ledLight: ledLight };
    }
    var poolSpill = spillway(1);
    var spaSpill = spillway(-1);

    var label = makeLabel(key === "east" ? "FB EAST OFF" : "FB WEST OFF", "#ffcf9a");
    label.position.set(0, 2.15, 0);
    group.add(label);

    baskets[key] = {
      group: group, flames: flames, ember: ember, glow: glow,
      poolSpill: poolSpill, spaSpill: spaSpill, label: label,
      on: false, seed: Math.random() * 20
    };
  });

  // ------------------------------------------------------------------
  // Lights in the water
  // ------------------------------------------------------------------
  var POOL_LIGHT_POS = new THREE.Vector3(POOL.x - 3.7, 0.18, POOL.z + 2.2);
  var SPA_LIGHT_POS = new THREE.Vector3(SPA.x - 1.2, 0.92, SPA.z + 1.2);

  function makeLight(pos) {
    var group = new THREE.Group();
    group.position.copy(pos);
    var lens = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a80ff, emissive: 0x2a80ff, emissiveIntensity: 0.0 }));
    group.add(lens);
    var light = new THREE.PointLight(0x2a80ff, 0.0, 10, 2);
    light.position.set(0, 0.4, 0);
    group.add(light);
    var glow = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24),
      new THREE.MeshBasicMaterial({
        color: 0x2a80ff, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.06;
    group.add(glow);
    scene.add(group);
    return { group: group, lens: lens, light: light, glow: glow };
  }
  var poolLamp = makeLight(POOL_LIGHT_POS);
  var spaLamp = makeLight(SPA_LIGHT_POS);

  // ------------------------------------------------------------------
  // Equipment pad: pumps, heater, valves
  // ------------------------------------------------------------------
  var pad = new THREE.Group();
  pad.position.set(-9.2, 0, 8.2);
  scene.add(pad);
  addBoxLocal(pad, 5.4, 0.18, 2.7, new THREE.MeshStandardMaterial({
    color: 0x142b32, roughness: 0.9
  }), 0, 0.09, 0);

  function addBoxLocal(parent, w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function makePump(x, z, labelText, color) {
    var g = new THREE.Group();
    g.position.set(x, 0.24, z);
    pad.add(g);
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.9, 16), metalMat);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    g.add(body);
    var cage = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.32, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x243a42, roughness: 0.6, metalness: 0.4, wireframe: true }));
    cage.rotation.z = Math.PI / 2;
    cage.position.x = 0.55;
    g.add(cage);
    var fan = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.08),
      new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.5 }));
    fan.position.x = 0.55;
    g.add(fan);
    var indicator = new THREE.PointLight(color, 0.0, 2.5, 2);
    indicator.position.set(0, 0.55, 0);
    g.add(indicator);
    var label = makeLabel(labelText, "#a9f4ff");
    label.position.set(0, 1.45, 0);
    g.add(label);
    return { group: g, fan: fan, indicator: indicator, label: label, on: false };
  }

  var mainPump = makePump(-1.5, 0.4, "MAIN VSR", 0x43e1e8);
  var featuresPump = makePump(0.8, 0.4, "FEATURES VSR", 0x58a7ff);

  var heater = new THREE.Group();
  heater.position.set(2.15, 0.28, 0.25);
  pad.add(heater);
  addBoxLocal(heater, 0.8, 0.85, 0.9, new THREE.MeshStandardMaterial({
    color: 0x273a3f, roughness: 0.55, metalness: 0.4
  }), 0, 0.42, 0);
  addBoxLocal(heater, 0.62, 0.06, 0.62, new THREE.MeshStandardMaterial({
    color: 0x1a262b, roughness: 0.6
  }), 0, 0.92, 0);
  var heaterLed = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xffb45f, emissive: 0xffb45f, emissiveIntensity: 0.0 }));
  heaterLed.position.set(0.25, 0.72, 0.47);
  heater.add(heaterLed);
  var heaterLabel = makeLabel("HEATER OFF", "#ffcf9a");
  heaterLabel.position.set(0, 1.6, 0);
  heater.add(heaterLabel);

  var valveDrain = makeValve(-1.1, 1.05);
  var valveReturn = makeValve(0.15, 1.05);

  function makeValve(x, z) {
    var g = new THREE.Group();
    g.position.set(x, 0.24, z);
    pad.add(g);
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.25, 12), metalMat);
    body.position.y = 0.16;
    body.castShadow = true;
    g.add(body);
    var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.35, 8), metalMat);
    stem.position.y = 0.4;
    g.add(stem);
    var handle = new THREE.Group();
    handle.position.y = 0.58;
    g.add(handle);
    var bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xffb45f, roughness: 0.5, metalness: 0.4 }));
    handle.add(bar);
    return { group: g, handle: handle };
  }

  // ------------------------------------------------------------------
  // Iggy the iguana
  // ------------------------------------------------------------------
  var iguana = createIguana();
  iguana.group.position.set(-9.8, 0, 2.4);
  iguana.group.rotation.y = -0.7;
  iguana.group.scale.setScalar(1.55);
  scene.add(iguana.group);

  function createIguana() {
    var group = new THREE.Group();
    var skin = new THREE.MeshStandardMaterial({ color: 0x5cbf52, roughness: 0.7, metalness: 0.05 });
    var belly = new THREE.MeshStandardMaterial({ color: 0xc7e88f, roughness: 0.8 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x2d7a35, roughness: 0.75 });
    var eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf8ffe8, roughness: 0.3 });
    var black = new THREE.MeshStandardMaterial({ color: 0x101410, roughness: 0.3 });

    var rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.0, 0), darkStone.clone());
    rock.material.color.setHex(0x33454b);
    rock.scale.set(1.5, 0.55, 1.15);
    rock.position.y = 0.28;
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);

    var body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 18, 14), skin);
    body.scale.set(1.35, 0.72, 0.8);
    body.position.set(0, 0.9, 0);
    body.castShadow = true;
    group.add(body);

    var bellyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.56, 16, 12), belly);
    bellyMesh.scale.set(1.25, 0.5, 0.62);
    bellyMesh.position.set(0, 0.78, 0.12);
    group.add(bellyMesh);

    var head = new THREE.Group();
    head.position.set(0.82, 1.12, 0.16);
    group.add(head);
    var skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), skin);
    skull.scale.set(1.25, 0.9, 0.8);
    skull.castShadow = true;
    head.add(skull);
    var snout = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), skin);
    snout.scale.set(1.25, 0.62, 0.7);
    snout.position.set(0.38, -0.05, 0);
    head.add(snout);
    var nostrilMat = new THREE.MeshStandardMaterial({ color: 0x1a3a1c });
    [-0.12, 0.12].forEach(function (z) {
      var nostril = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), nostrilMat);
      nostril.position.set(0.55, 0.04, z);
      head.add(nostril);
    });

    var jawPivot = new THREE.Group();
    jawPivot.position.set(0.22, -0.12, 0);
    head.add(jawPivot);
    var jaw = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.07, 0.26), belly);
    jaw.position.set(0.18, 0, 0);
    jawPivot.add(jaw);
    var tongue = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xff5577 }));
    tongue.position.set(0.45, 0.01, 0);
    jawPivot.add(tongue);

    var eyes = [];
    [-0.16, 0.16].forEach(function (z) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), eyeWhite);
      eye.position.set(0.16, 0.16, z);
      head.add(eye);
      var pupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), black);
      pupil.position.set(0.245, 0.17, z);
      head.add(pupil);
      eyes.push(pupil);
    });

    // crest spikes
    for (var s = 0; s < 7; s++) {
      var spike = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.25 - s * 0.018, 6), dark);
      spike.position.set(0.55 - s * 0.16, 1.33 - s * 0.015, 0);
      spike.rotation.z = -0.5;
      group.add(spike);
    }

    // legs
    [[-0.42, 0.55], [-0.42, -0.55], [0.35, 0.55], [0.35, -0.55]].forEach(function (p) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.45, 8), skin);
      leg.position.set(p[0], 0.5, p[1]);
      leg.rotation.x = p[1] > 0 ? 0.35 : -0.35;
      group.add(leg);
      var foot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), skin);
      foot.scale.set(1.4, 0.35, 1);
      foot.position.set(p[0] + 0.02, 0.27, p[1] * 1.18);
      group.add(foot);
    });

    var tailPivot = new THREE.Group();
    tailPivot.position.set(-0.75, 0.9, 0);
    group.add(tailPivot);
    tailPivot.rotation.z = 0.28;
    for (var t = 0; t < 7; t++) {
      var seg = new THREE.Mesh(new THREE.CylinderGeometry(0.18 - t * 0.022, 0.2 - t * 0.022, 0.34, 8), skin);
      seg.rotation.z = Math.PI / 2;
      seg.position.set(-t * 0.28, -t * 0.02, 0);
      tailPivot.add(seg);
      var tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 6), dark);
      tip.rotation.z = Math.PI / 2;
      tip.position.set(-t * 0.28 - 0.18, -t * 0.02, 0);
      if (t === 6) tailPivot.add(tip);
    }

    var label = makeLabel("IGGY", "#62e6a6");
    label.position.set(-0.1, 2.2, 0);
    group.add(label);

    return {
      group: group, head: head, jawPivot: jawPivot, tailPivot: tailPivot,
      eyes: eyes, talk: 0, targetTalk: 0, blink: 0, label: label
    };
  }

  // ------------------------------------------------------------------
  // Rendering / animation
  // ------------------------------------------------------------------
  var state = null;
  var clock = new THREE.Clock();

  function effectColor(effect) {
    switch (effect) {
      case "WHITER": return 0xffffff;
      case "REDR": return 0xff4444;
      case "GREENR": return 0x44ff99;
      case "MAGNTAR": return 0xff4fd8;
      case "BLUER": return 0x2a80ff;
      case "CARIB": return 0x22e6d0;
      case "SSET": return 0xffa04d;
      case "ROMAN": return 0xff5f9e;
      case "AMERCA": return 0xff4a4a;
      case "ROYAL": return 0x5f66ff;
      case "SAMMOD": return 0x59d8ff;
      default: return 0x2a80ff;
    }
  }

  function resize() {
    var w = canvas.clientWidth || 1;
    var h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  resize();

  function formatTemp(v) { return v === null || v === undefined || isNaN(v) ? "--°F" : Math.round(v) + "°F"; }
  function onOff(v) { return v ? "ON" : "OFF"; }

  function update(next) {
    state = next;
    if (!state) return;
    var mode = state.mode || "pool";
    var poolTemp = formatTemp(state.bodies && state.bodies.pool ? state.bodies.pool.temp : null);
    var spaTemp = formatTemp(state.bodies && state.bodies.spa ? state.bodies.spa.temp : null);
    var salt = state.chemistry && state.chemistry.salt ? state.chemistry.salt + " ppm" : "--";

    updateLabel(poolLabel, "POOL " + poolTemp, mode === "pool" ? "#67eff5" : "#a9f4ff");
    updateLabel(spaLabel, "SPA " + spaTemp, mode === "spa" ? "#d9c4ff" : "#b8d6ff");
    updateLabel(modeLabel, mode === "spa" ? "SPA MODE" : "POOL MODE",
      mode === "spa" ? "#d9c4ff" : "#7df0ef");
    updateLabel(saltLabel, "SALT " + salt, "#8fe9f5");

    // water color & waves
    var poolEffect = state.lights && state.lights.pool ? state.lights.pool.effect : "BLUER";
    var spaEffect = state.lights && state.lights.spa ? state.lights.spa.effect : "BLUER";
    var poolOn = !!(state.lights && state.lights.pool && state.lights.pool.on);
    var spaOn = !!(state.lights && state.lights.spa && state.lights.spa.on);
    var pc = effectColor(poolEffect);
    var sc = effectColor(spaEffect);

    poolLamp.light.color.setHex(pc);
    poolLamp.lens.material.color.setHex(pc);
    poolLamp.lens.material.emissive.setHex(pc);
    poolLamp.light.intensity = poolOn ? 2.6 : 0;
    poolLamp.lens.material.emissiveIntensity = poolOn ? 2.0 : 0;
    poolLamp.glow.material.color.setHex(pc);
    poolLamp.glow.material.opacity = poolOn ? 0.22 : 0;

    spaLamp.light.color.setHex(sc);
    spaLamp.lens.material.color.setHex(sc);
    spaLamp.lens.material.emissive.setHex(sc);
    spaLamp.light.intensity = spaOn ? 2.2 : 0;
    spaLamp.lens.material.emissiveIntensity = spaOn ? 2.0 : 0;
    spaLamp.glow.material.color.setHex(sc);
    spaLamp.glow.material.opacity = spaOn ? 0.24 : 0;
    spaWaterMat.color.setHex(spaOn ? 0x1aa6c4 : 0x1690ad);
    waterMat.color.setHex(poolOn ? 0x108cab : 0x0d7c9f);

    // jets
    Object.keys(jets).forEach(function (key) {
      var jet = jets[key];
      var js = state.deck_jets && state.deck_jets[key] ? state.deck_jets[key] : {};
      jet.on = !!js.on;
      jet.light = !!js.light;
      jet.thumper = js.thumper !== false;
      jet.tubeMat.opacity = jet.on ? 0.95 : 0.0;
      jet.group.children[1].material.emissiveIntensity = jet.on ? 1.4 : 0.0;
      jet.drops.forEach(function (d) { d.mesh.visible = jet.on; });
      updateLabel(jet.label,
        key.toUpperCase() + " JET " + onOff(jet.on) +
        (jet.on ? (jet.light ? " LIT" : "") + (jet.thumper ? " THUMP" : "") : ""),
        jet.on ? "#8ff6ff" : "#648c99");
    });

    // firebaskets
    var spillColor = effectColor(state.spillway_effect || "BLUER");
    Object.keys(baskets).forEach(function (key) {
      var b = baskets[key];
      var bs = state.firebaskets && state.firebaskets[key] ? state.firebaskets[key] : {};
      b.on = !!bs.on;
      b.flames.forEach(function (flame) { flame.visible = b.on; });
      b.ember.material.emissiveIntensity = b.on ? 1.8 : 0.0;
      b.glow.intensity = b.on ? 2.4 : 0;
      [b.poolSpill, b.spaSpill].forEach(function (sp) {
        sp.sheet.material.opacity = b.on ? 0.65 : 0.0;
        sp.ledMat.color.setHex(spillColor);
        sp.ledMat.emissive.setHex(spillColor);
        sp.ledMat.emissiveIntensity = b.on ? 2.2 : 0.0;
        sp.ledLight.color.setHex(spillColor);
        sp.ledLight.intensity = b.on ? 1.4 : 0.0;
      });
      updateLabel(b.label,
        (key === "east" ? "FB EAST " : "FB WEST ") + (b.on ? "FIRING" : "OFF"),
        b.on ? "#ffcf9a" : "#8c7462");
    });

    // pumps / heater / valves
    var main = state.pumps && state.pumps.main ? state.pumps.main : {};
    var feat = state.pumps && state.pumps.features ? state.pumps.features : {};
    mainPump.on = !!main.on;
    featuresPump.on = !!feat.on;
    mainPump.indicator.intensity = mainPump.on ? 0.9 : 0;
    featuresPump.indicator.intensity = featuresPump.on ? 0.9 : 0;
    updateLabel(mainPump.label, "MAIN VSR " + (main.on ? main.rpm + " RPM" : "OFF"),
      main.on ? "#7df0ef" : "#5e7c87");
    updateLabel(featuresPump.label, "FEATURES " + (feat.on ? feat.rpm + " RPM" : "OFF"),
      feat.on ? "#8fbdff" : "#5e7c87");

    var heaterOn = !!(state.heater && state.heater.on);
    heaterLed.material.emissiveIntensity = heaterOn ? 2.4 : 0;
    updateLabel(heaterLabel, "HEATER " + (heaterOn ? state.heater.setpoint + "°F" : "OFF"),
      heaterOn ? "#ffcf9a" : "#7f8c90");

    var valves = state.valves || {};
    var drainSpa = valves.drain && valves.drain.spa !== undefined ? valves.drain.spa : 20;
    var retSpa = valves.return && valves.return.spa !== undefined ? valves.return.spa : 80;
    valveDrain.handle.rotation.y = (drainSpa / 100) * Math.PI;
    valveReturn.handle.rotation.y = (retSpa / 100) * Math.PI;

  }

  function animate() {
    requestAnimationFrame(animate);
    var t = clock.getElapsedTime();
    controls.update();

    // water ripples
    var pArr = poolWaterGeo.attributes.position.array;
    for (var i = 0; i < pArr.length; i += 3) {
      var x = poolBase[i];
      var y = poolBase[i + 1];
      pArr[i + 2] = Math.sin(x * 1.15 + t * 1.6) * 0.035 +
        Math.cos(y * 1.45 - t * 1.2) * 0.03;
    }
    poolWaterGeo.attributes.position.needsUpdate = true;
    var sArr = spaWaterGeo.attributes.position.array;
    for (var j = 0; j < sArr.length; j += 3) {
      var sx = spaBase[j];
      var sy = spaBase[j + 1];
      sArr[j + 2] = Math.sin(sx * 2.2 + t * 2.2) * 0.025 +
        Math.cos(sy * 2.5 - t * 1.8) * 0.02;
    }
    spaWaterGeo.attributes.position.needsUpdate = true;

    // deck jet droplets and thumper bursts
    Object.keys(jets).forEach(function (key) {
      var jet = jets[key];
      if (!jet.on) return;
      jet.drops.forEach(function (d, idx) {
        var speed = jet.thumper ? (0.55 + Math.abs(Math.sin(t * 2.1 + d.bump)) * 1.5) : 0.55;
        var u = (t * speed + d.offset) % 1;
        var p = jet.curve.getPoint(u);
        d.mesh.position.copy(p);
        var burst = jet.thumper ? (0.5 + 0.5 * Math.sin(t * 9 + idx + d.bump)) : 1;
        d.mesh.scale.setScalar(burst * 1.5);
        d.mesh.material.opacity = 0.6 + burst * 0.4;
      });
      if (jet.thumper && Math.random() < 0.012) {
        var d = jet.drops[Math.floor(Math.random() * jet.drops.length)];
        d.mesh.scale.setScalar(2.8);
      }
    });

    // flames
    Object.keys(baskets).forEach(function (key) {
      var b = baskets[key];
      if (!b.on) return;
      b.flames.forEach(function (flame, idx) {
        var flick = 0.75 + Math.abs(Math.sin(t * 7 + idx * 1.7 + b.seed)) * 0.55;
        flame.scale.set(0.9 + flick * 0.2, flick, 0.9 + flick * 0.2);
        flame.material.opacity = 0.55 + flick * 0.35;
        flame.rotation.y = t * 0.8 + idx;
      });
      b.glow.intensity = 2.0 + Math.abs(Math.sin(t * 8 + b.seed)) * 0.9;
    });

    // pumps
    if (mainPump.on) mainPump.fan.rotation.x += 0.22;
    if (featuresPump.on) featuresPump.fan.rotation.x += 0.3;
    mainPump.indicator.intensity = mainPump.on ? 0.7 + Math.sin(t * 4) * 0.2 : 0;
    featuresPump.indicator.intensity = featuresPump.on ? 0.7 + Math.sin(t * 4.3) * 0.2 : 0;

    // Iggy
    if (iguana) {
      iguana.talk += (iguana.targetTalk - iguana.talk) * 0.14;
      var mouth = 0.06 + Math.abs(Math.sin(t * 16)) * 0.42 * iguana.talk;
      iguana.jawPivot.rotation.z = mouth;
      iguana.head.rotation.y = Math.sin(t * 0.7) * 0.12 + iguana.talk * 0.08;
      iguana.head.position.y = 1.12 + Math.sin(t * 1.7) * 0.02;
      iguana.tailPivot.rotation.y = Math.sin(t * 1.2) * 0.35;
      iguana.eyes.forEach(function (pupil, idx) {
        var blink = Math.max(0, Math.sin(t * 0.9 + idx * 3.1));
        pupil.scale.y = blink > 0.985 ? 0.15 : 1;
      });
    }

    renderer.render(scene, camera);
  }
  animate();

  window.pool3d = {
    update: update,
    setTalking: function (on) {
      if (iguana) iguana.targetTalk = on ? 1 : 0;
    },
    focus: function (which) {
      if (which === "spa") {
        controls.target.set(SPA.x, 0.7, SPA.z);
        camera.position.set(13, 9, 4);
      } else if (which === "jets") {
        controls.target.set(POOL.x, 0.5, POOL.z);
        camera.position.set(12, 10, 15);
      } else {
        controls.target.set(-1.2, 0.4, 1.2);
        camera.position.set(17.5, 14.5, 19.5);
      }
      controls.update();
    }
  };
})();

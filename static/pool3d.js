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

  var POOL = { x: -0.5, z: 0.0, w: 6.6, d: 12.0, y: 0.09 };
  var SPA = { x: 3.65, z: 6.85, w: 3.6, d: 3.6, y: 0.78 };

  function addBox(w, h, d, mat, x, y, z) {
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function addBoxLocal(parent, w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
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

  var poolWaterGeo = new THREE.PlaneGeometry(POOL.w, POOL.d, 36, 48);
  var poolWater = new THREE.Mesh(poolWaterGeo, waterMat);
  poolWater.rotation.x = -Math.PI / 2;
  poolWater.position.set(POOL.x, POOL.y, POOL.z);
  poolWater.receiveShadow = true;
  scene.add(poolWater);
  var poolBase = poolWaterGeo.attributes.position.array.slice(0);

  // Spa group (corner between 2 firebaskets aligned with Southeast pool corner and pushed towards pool)
  var spaGroup = new THREE.Group();
  spaGroup.position.set(SPA.x, 0, SPA.z);
  scene.add(spaGroup);

  // Spa raised platform and shell
  addBoxLocal(spaGroup, SPA.w + 1.2, 0.8, SPA.d + 1.2, deckMat2, 0.3, 0.4, 0.3);
  addBoxLocal(spaGroup, SPA.w + 0.6, 0.9, SPA.d + 0.6, new THREE.MeshStandardMaterial({
    color: 0x123d49, roughness: 0.75, metalness: 0.1
  }), 0, 0.52, 0);
  addBoxLocal(spaGroup, SPA.w + 0.6, 0.16, 0.34, copingMat, 0, 0.95, -SPA.d / 2);
  addBoxLocal(spaGroup, SPA.w + 0.6, 0.16, 0.34, copingMat, 0, 0.95, SPA.d / 2);
  addBoxLocal(spaGroup, 0.34, 0.16, SPA.d + 0.6, copingMat, -SPA.w / 2, 0.95, 0);
  addBoxLocal(spaGroup, 0.34, 0.16, SPA.d + 0.6, copingMat, SPA.w / 2, 0.95, 0);

  var spaWaterGeo = new THREE.PlaneGeometry(SPA.w, SPA.d, 24, 24);
  var spaWater = new THREE.Mesh(spaWaterGeo, spaWaterMat);
  spaWater.rotation.x = -Math.PI / 2;
  spaWater.position.set(0, SPA.y, 0);
  spaWater.receiveShadow = true;
  spaGroup.add(spaWater);
  var spaBase = spaWaterGeo.attributes.position.array.slice(0);

  // Corner Waterfall Lip between the 2 firebaskets spilling into the pool
  var spaLipMat = waterMat.clone();
  spaLipMat.color.setHex(0x1bbde0);
  spaLipMat.emissive.setHex(0x0e718c);
  var spaLip = addBoxLocal(spaGroup, 1.35, 0.08, 0.7, spaLipMat, -1.8, SPA.y - 0.01, -1.8);
  spaLip.rotation.y = -Math.PI / 4;

  function createWaterfallTexture() {
    var c = document.createElement("canvas");
    c.width = 128;
    c.height = 256;
    var ctx = c.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "rgba(175, 242, 255, 0.75)");
    grad.addColorStop(0.3, "rgba(125, 230, 255, 0.85)");
    grad.addColorStop(0.8, "rgba(220, 252, 255, 0.95)");
    grad.addColorStop(1.0, "rgba(255, 255, 255, 0.98)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2.5;
    for (var s = 0; s < 20; s++) {
      var sx = (s * 6.8 + 2) % 128;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.bezierCurveTo(sx + 3, 70, sx - 3, 170, sx, 256);
      ctx.stroke();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 2);
    return tex;
  }
  var wfTex = createWaterfallTexture();
  var wfMat = new THREE.MeshStandardMaterial({
    color: 0x9fefff, emissive: 0x24b7db, emissiveIntensity: 0.5,
    roughness: 0.1, metalness: 0.15, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthWrite: false, map: wfTex
  });
  var WF_WIDTH = 1.38;
  var wfGeo = new THREE.PlaneGeometry(WF_WIDTH, 1, 12, 20);
  var wfPos = wfGeo.attributes.position.array;
  var wfBase = new Float32Array(wfPos.length);
  for (var wfi = 0; wfi < wfPos.length; wfi += 3) {
    var vFrac = 0.5 - wfPos[wfi + 1];
    var wy, wz;
    if (vFrac < 0.18) {
      var cf = vFrac / 0.18;
      wy = 0.77 - cf * cf * 0.05;
      wz = -0.2 + cf * 0.22;
    } else {
      var ff = (vFrac - 0.18) / 0.82;
      wy = 0.72 - ff * 0.63;
      wz = 0.02 + Math.sin(ff * Math.PI * 0.5) * 0.18;
    }
    wfPos[wfi + 1] = wy;
    wfPos[wfi + 2] = wz;
    wfBase[wfi] = wfPos[wfi];
    wfBase[wfi + 1] = wy;
    wfBase[wfi + 2] = wz;
  }
  wfGeo.computeVertexNormals();
  var wfMesh = new THREE.Mesh(wfGeo, wfMat);
  wfMesh.position.set(-1.8, 0, -1.8);
  wfMesh.rotation.y = -Math.PI / 4;
  spaGroup.add(wfMesh);

  // ------------------------------------------------------------------
  // Stairs (+z is south, -x is west)
  // ------------------------------------------------------------------
  // The water is nearly opaque and its waves dip below the shell top, so
  // submerged treads are drawn as translucent overlays just above the wave
  // crests, fading with depth, with white edge tiles on each step nose.
  function addSubmergedSteps(parent, x0, x1, zEdge, treadDepth, y, opacities) {
    var width = x1 - x0;
    var cx = (x0 + x1) / 2;
    opacities.forEach(function (opacity, i) {
      var zFar = zEdge - treadDepth * i;
      var zNear = zFar - treadDepth;
      var tread = new THREE.Mesh(new THREE.PlaneGeometry(width, treadDepth),
        new THREE.MeshBasicMaterial({
          color: 0xd8fbff, transparent: true, opacity: opacity, depthWrite: false
        }));
      tread.rotation.x = -Math.PI / 2;
      tread.position.set(cx, y, (zFar + zNear) / 2);
      parent.add(tread);
      var nose = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.07),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: Math.min(0.95, opacity + 0.4),
          depthWrite: false
        }));
      nose.rotation.x = -Math.PI / 2;
      nose.position.set(cx, y + 0.002, zNear + 0.035);
      parent.add(nose);
    });
  }

  // Pool: three entry steps in the southwest corner, along the south wall
  addSubmergedSteps(scene, POOL.x - POOL.w / 2, POOL.x - POOL.w / 2 + 2.2,
    POOL.z + POOL.d / 2, 0.5, POOL.y + 0.075, [0.5, 0.34, 0.2]);

  // Spa: deck steps up the south face of the raised platform...
  var spaPlatformSouth = 0.3 + (SPA.d + 1.2) / 2;
  for (var si = 1; si <= 3; si++) {
    var stepH = 0.2 * si;
    var stepD = 0.35 * (4 - si);
    addBoxLocal(spaGroup, 1.6, stepH, stepD, deckMat2,
      0, stepH / 2, spaPlatformSouth + stepD / 2);
    addBoxLocal(spaGroup, 1.6, 0.03, 0.08, copingMat,
      0, stepH + 0.015, spaPlatformSouth + stepD - 0.04);
  }
  // ...and a bench step down into the water inside the south wall
  addSubmergedSteps(spaGroup, -0.8, 0.8, SPA.d / 2 - 0.17, 0.45,
    SPA.y + 0.175, [0.42]);

  var isPoolMode = true;
  var waterfallIntensity = 1.0;

  // ------------------------------------------------------------------
  // Spa Bubbles (Blower animation)
  // ------------------------------------------------------------------
  var blowerActive = false;
  var blowerIntensity = 0.0;

  var BUBBLE_COUNT = 220;
  var bubbleGeom = new THREE.SphereGeometry(1, 10, 8);
  var bubbleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x88f5ff,
    emissiveIntensity: 1.0,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  var bubbleMesh = new THREE.InstancedMesh(bubbleGeom, bubbleMat, BUBBLE_COUNT);
  if (THREE.DynamicDrawUsage !== undefined) bubbleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bubbleMesh.visible = false;
  spaGroup.add(bubbleMesh);

  var dummyObj = new THREE.Object3D();
  var bubbles = [];
  for (var bi = 0; bi < BUBBLE_COUNT; bi++) {
    bubbles.push({
      x: (Math.random() - 0.5) * 2.8,
      z: (Math.random() - 0.5) * 2.8,
      y: 0.15 + Math.random() * 0.75,
      radius: 0.08 + Math.random() * 0.14,
      speed: 1.2 + Math.random() * 2.2,
      wobbleSpeed: 4.0 + Math.random() * 7.0,
      wobbleAmp: 0.035 + Math.random() * 0.05,
      phase: Math.random() * Math.PI * 2
    });
  }

  function createFoamTexture() {
    var c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    var ctx = c.getContext("2d");
    var grad = ctx.createRadialGradient(30, 30, 2, 32, 32, 28);
    grad.addColorStop(0, "rgba(255, 255, 255, 1.0)");
    grad.addColorStop(0.35, "rgba(225, 252, 255, 0.9)");
    grad.addColorStop(0.7, "rgba(130, 230, 255, 0.5)");
    grad.addColorStop(1, "rgba(130, 230, 255, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
    ctx.beginPath();
    ctx.arc(22, 22, 5, 0, Math.PI * 2);
    ctx.fill();
    var tex = new THREE.CanvasTexture(c);
    return tex;
  }

  var FOAM_COUNT = 140;
  var foamGeom = new THREE.BufferGeometry();
  var foamPos = new Float32Array(FOAM_COUNT * 3);
  var foamSeeds = [];
  for (var fi = 0; fi < FOAM_COUNT; fi++) {
    var fx = (Math.random() - 0.5) * 2.8;
    var fz = (Math.random() - 0.5) * 2.8;
    foamPos[fi * 3] = fx;
    foamPos[fi * 3 + 1] = SPA.y + 0.02;
    foamPos[fi * 3 + 2] = fz;
    foamSeeds.push({
      bx: fx,
      bz: fz,
      speed: 2.0 + Math.random() * 3.5,
      radius: 0.06 + Math.random() * 0.16,
      phase: Math.random() * Math.PI * 2
    });
  }
  foamGeom.setAttribute("position", new THREE.BufferAttribute(foamPos, 3));
  var foamMat = new THREE.PointsMaterial({
    size: 0.55,
    map: createFoamTexture(),
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  var foamPoints = new THREE.Points(foamGeom, foamMat);
  foamPoints.visible = false;
  spaGroup.add(foamPoints);

  var foamDisc = new THREE.Mesh(new THREE.PlaneGeometry(SPA.w - 0.2, SPA.d - 0.2),
    new THREE.MeshBasicMaterial({
      color: 0xebfcff,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
  foamDisc.rotation.x = -Math.PI / 2;
  foamDisc.position.set(0, SPA.y + 0.015, 0);
  foamDisc.visible = false;
  spaGroup.add(foamDisc);

  // Falling waterfall spray droplets & pool impact foam
  var WF_SPRAY_COUNT = 36;
  var wfSprayGeom = new THREE.BufferGeometry();
  var wfSprayPos = new Float32Array(WF_SPRAY_COUNT * 3);
  var wfSprayData = [];
  for (var si = 0; si < WF_SPRAY_COUNT; si++) {
    var sx = (Math.random() - 0.5) * (WF_WIDTH - 0.08);
    var sy = 0.09 + Math.random() * 0.68;
    wfSprayPos[si * 3] = sx;
    wfSprayPos[si * 3 + 1] = sy;
    wfSprayPos[si * 3 + 2] = 2.55;
    wfSprayData.push({ x: sx, speed: 2.2 + Math.random() * 2.4, phase: Math.random() * Math.PI * 2 });
  }
  wfSprayGeom.setAttribute("position", new THREE.BufferAttribute(wfSprayPos, 3));
  var wfSprayMat = new THREE.PointsMaterial({
    size: 0.20, map: createFoamTexture(), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var wfSprayPoints = new THREE.Points(wfSprayGeom, wfSprayMat);
  spaGroup.add(wfSprayPoints);

  var impactFoamMat = new THREE.MeshBasicMaterial({
    color: 0xebfcff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var impactFoam = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.45), impactFoamMat);
  impactFoam.rotation.x = -Math.PI / 2;
  impactFoam.position.set(-2.05, 0.096, -2.05);
  impactFoam.rotation.z = -Math.PI / 4;
  spaGroup.add(impactFoam);

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
  saltLabel.position.set(-7.5, 2.9, -1.8);
  var connStatusLabel = makeLabel("SIMULATION MODE", "#ffaa33");
  connStatusLabel.position.set(-6.8, 2.5, 12.8);

  // ------------------------------------------------------------------
  // Deck floor jets
  // ------------------------------------------------------------------
  var jetDefs = {
    ne: { x: 3.3, z: -4.5, target: [0.5, 0.1, -2.5] },
    nw: { x: -4.3, z: -4.5, target: [-1.0, 0.1, -2.5] },
    se: { x: 3.3, z: 1.5, target: [0.5, 0.1, 2.0] },
    sw: { x: -4.3, z: 3.5, target: [-1.0, 0.1, 2.5] }
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
  // Firebaskets flanking the Southeast pool corner (each has 2 spillways)
  // ------------------------------------------------------------------
  var basketDefs = {
    east: { x: 3.20, z: 5.05, poolAngle: Math.PI, spaAngle: 0, labelOffset: [1.9, 0.2] },
    west: { x: 1.85, z: 6.40, poolAngle: -Math.PI / 2, spaAngle: Math.PI / 2, labelOffset: [-1.25, 1.25] }
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

    // LED strip under the burner (AUX 1 "Burner Lights", shared by both baskets)
    var burnerLedMat = new THREE.MeshStandardMaterial({
      color: 0x3a3226, emissive: 0xffd9a0, emissiveIntensity: 0.0
    });
    var burnerLed = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.025, 6, 32), burnerLedMat);
    burnerLed.rotation.x = Math.PI / 2;
    burnerLed.position.y = 0.47;
    group.add(burnerLed);
    var burnerLedLight = new THREE.PointLight(0xffd9a0, 0.0, 3.5, 2);
    burnerLedLight.position.set(0, 0.62, 0);
    group.add(burnerLedLight);

    // Dual spillways: one emptying into the pool, one emptying into the spa
    function makeSpillway(angleRad) {
      var spillGroup = new THREE.Group();
      spillGroup.position.set(Math.sin(angleRad) * 0.52, 0.02, Math.cos(angleRad) * 0.52);
      spillGroup.rotation.y = angleRad;
      group.add(spillGroup);

      var sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.82, 1, 8),
        new THREE.MeshBasicMaterial({
          color: 0x98f2ff, transparent: true, opacity: 0.0,
          side: THREE.DoubleSide, depthWrite: false
        }));
      sheet.rotation.x = -Math.PI / 3;
      sheet.position.set(0, -0.05, 0.35);
      spillGroup.add(sheet);

      var ledMat = new THREE.MeshStandardMaterial({
        color: 0x2a80ff, emissive: 0x2a80ff, emissiveIntensity: 0.0
      });
      var led = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.07), ledMat);
      led.position.set(0, 0.08, 0.05);
      spillGroup.add(led);

      var ledLight = new THREE.PointLight(0x2a80ff, 0.0, 3.0, 2);
      ledLight.position.set(0, 0.15, 0.2);
      spillGroup.add(ledLight);

      return { group: spillGroup, sheet: sheet, led: led, ledMat: ledMat, ledLight: ledLight };
    }
    var poolSpill = makeSpillway(def.poolAngle);
    var spaSpill = makeSpillway(def.spaAngle);

    var label = makeLabel(key === "east" ? "FB EAST OFF" : "FB WEST OFF", "#ffcf9a");
    // The baskets sit ~1.9 apart, closer than a label is wide, so push each
    // label outward (away from the spa) to keep them from overlapping.
    label.position.set(def.labelOffset[0], 2.15, def.labelOffset[1]);
    group.add(label);

    baskets[key] = {
      group: group, flames: flames, ember: ember, glow: glow,
      burnerLedMat: burnerLedMat, burnerLedLight: burnerLedLight,
      poolSpill: poolSpill, spaSpill: spaSpill, label: label,
      on: false, seed: Math.random() * 20
    };
  });

  // ------------------------------------------------------------------
  // East side: Canal, Seawall, Boat Dock, Boat and Jet Ski
  // ------------------------------------------------------------------
  var seawall = addBox(0.55, 0.25, 32, copingMat, 9.8, 0.12, 0);
  addBox(0.3, 1.2, 32, new THREE.MeshStandardMaterial({ color: 0x3d4b52, roughness: 0.9 }), 10.05, -0.42, 0);

  var canalWaterGeo = new THREE.PlaneGeometry(16, 32, 24, 24);
  var canalWaterMat = new THREE.MeshStandardMaterial({
    color: 0x0c4f5e, transparent: true, opacity: 0.88,
    roughness: 0.16, metalness: 0.14, emissive: 0x062832, emissiveIntensity: 0.4
  });
  var canalWater = new THREE.Mesh(canalWaterGeo, canalWaterMat);
  canalWater.rotation.x = -Math.PI / 2;
  canalWater.position.set(18.2, -0.42, 0);
  canalWater.receiveShadow = true;
  scene.add(canalWater);
  var canalBase = canalWaterGeo.attributes.position.array.slice(0);

  var dockMat = new THREE.MeshStandardMaterial({ color: 0x7c624e, roughness: 0.85, metalness: 0.05 });
  var pilingMat = new THREE.MeshStandardMaterial({ color: 0x3d2f24, roughness: 0.9 });
  addBox(4.0, 0.16, 17.5, dockMat, 12.1, 0.06, 0);
  [-8.0, -4.0, 0, 4.0, 8.0].forEach(function (pz) {
    var piling = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.8, 10), pilingMat);
    piling.position.set(14.15, -0.2, pz);
    piling.castShadow = true;
    scene.add(piling);
  });

  // North boat lift with center console boat
  var boatGroup = new THREE.Group();
  boatGroup.position.set(16.5, 0.28, -4.0);
  scene.add(boatGroup);

  var liftMat = new THREE.MeshStandardMaterial({ color: 0xb5c0c6, roughness: 0.35, metalness: 0.75 });
  [[-1.8, -2.4], [1.8, -2.4], [-1.8, 2.4], [1.8, 2.4]].forEach(function (lp) {
    var post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.8, 8), liftMat);
    post.position.set(lp[0], 0.7, lp[1]);
    boatGroup.add(post);
  });
  [-2.4, 2.4].forEach(function (cz) {
    var beam = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 0.14), liftMat);
    beam.position.set(0, -0.15, cz);
    boatGroup.add(beam);
  });

  var marineWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.08 });
  var navyAccent = new THREE.MeshStandardMaterial({ color: 0x0f2b48, roughness: 0.35, metalness: 0.1 });
  var boatHull = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.75, 5.2), marineWhite);
  boatHull.position.set(0, 0.25, 0);
  boatHull.castShadow = true;
  boatGroup.add(boatHull);

  var bow = new THREE.Mesh(new THREE.ConeGeometry(1.05, 1.4, 4), marineWhite);
  bow.rotation.y = Math.PI / 4;
  bow.rotation.x = -Math.PI / 2;
  bow.position.set(0, 0.25, -3.1);
  bow.scale.set(1, 0.55, 1);
  bow.castShadow = true;
  boatGroup.add(bow);

  var stripe = new THREE.Mesh(new THREE.BoxGeometry(2.14, 0.08, 5.2), navyAccent);
  stripe.position.set(0, 0.08, 0);
  boatGroup.add(stripe);

  var boatDeck = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 4.8), new THREE.MeshStandardMaterial({ color: 0xdde4e8, roughness: 0.6 }));
  boatDeck.position.set(0, 0.48, 0);
  boatGroup.add(boatDeck);

  var consoleBox = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.75, 0.9), marineWhite);
  consoleBox.position.set(0, 0.85, -0.2);
  boatGroup.add(consoleBox);
  var windshield = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.28, 0.06), new THREE.MeshStandardMaterial({ color: 0x3d7085, roughness: 0.1, transparent: true, opacity: 0.75 }));
  windshield.position.set(0, 1.32, -0.6);
  boatGroup.add(windshield);

  [-0.48, 0.48].forEach(function (tx) {
    var stanchion = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 6), liftMat);
    stanchion.position.set(tx, 1.25, -0.2);
    boatGroup.add(stanchion);
  });
  var tTop = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 2.2), navyAccent);
  tTop.position.set(0, 1.95, -0.2);
  boatGroup.add(tTop);

  [-0.42, 0.42].forEach(function (ox) {
    var motor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.65, 0.42), navyAccent);
    motor.position.set(ox, 0.35, 2.75);
    boatGroup.add(motor);
    var prop = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.25), liftMat);
    prop.position.set(ox, -0.05, 2.85);
    boatGroup.add(prop);
  });

  var dockLabel = makeLabel("NORTH BOAT LIFT", "#8fe9f5");
  dockLabel.position.set(16.5, 2.9, -4.0);

  // South jet ski lift with jet ski
  var jetskiGroup = new THREE.Group();
  jetskiGroup.position.set(15.5, 0.18, 4.5);
  scene.add(jetskiGroup);

  [-1.1, 1.1].forEach(function (lx) {
    var post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8), liftMat);
    post.position.set(lx, 0.5, 0);
    jetskiGroup.add(post);
  });
  [-0.4, 0.4].forEach(function (bx) {
    var bunk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 2.6), dockMat);
    bunk.position.set(bx, -0.08, 0);
    jetskiGroup.add(bunk);
  });

  var tealMat = new THREE.MeshStandardMaterial({ color: 0x11b5ad, roughness: 0.25, metalness: 0.15 });
  var seatMat = new THREE.MeshStandardMaterial({ color: 0x1c2124, roughness: 0.7 });
  var jsHull = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.42, 2.8), marineWhite);
  jsHull.position.set(0, 0.15, 0);
  jsHull.castShadow = true;
  jetskiGroup.add(jsHull);

  var jsBow = new THREE.Mesh(new THREE.ConeGeometry(0.58, 0.85, 4), tealMat);
  jsBow.rotation.y = Math.PI / 4;
  jsBow.rotation.x = Math.PI / 2;
  jsBow.scale.set(1, 0.48, 1);
  jsBow.position.set(0, 0.18, 1.75);
  jetskiGroup.add(jsBow);

  var jsHood = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.22, 1.6), tealMat);
  jsHood.position.set(0, 0.4, 0.2);
  jetskiGroup.add(jsHood);

  var jsBars = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.05, 0.06), liftMat);
  jsBars.position.set(0, 0.65, 0.45);
  jetskiGroup.add(jsBars);

  var jsSeat = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.22, 1.4), seatMat);
  jsSeat.position.set(0, 0.44, -0.35);
  jetskiGroup.add(jsSeat);

  var jetskiLabel = makeLabel("SOUTH JET SKI LIFT", "#7df0ef");
  jetskiLabel.position.set(15.5, 2.4, 4.5);

  // ------------------------------------------------------------------
  // West side: Two-Story House at 2732 NE 23rd Ave
  // ------------------------------------------------------------------
  var houseGroup = new THREE.Group();
  scene.add(houseGroup);

  var stuccoMat = new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.88, metalness: 0.03 });
  var fasciaMat = new THREE.MeshStandardMaterial({ color: 0x222a2e, roughness: 0.6 });
  var glassSliderMat = new THREE.MeshStandardMaterial({
    color: 0x3d7085, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.75
  });

  // Story 1: Ground floor main structure (y: 0 to 4.2)
  addBoxLocal(houseGroup, 8.5, 4.2, 26.0, stuccoMat, -13.2, 2.1, 0);

  // Covered Lanai ceiling & patio columns (y = 3.9)
  addBoxLocal(houseGroup, 2.8, 0.28, 20.0, fasciaMat, -7.6, 3.9, 0);
  [-8.5, -3.0, 3.0, 8.5].forEach(function (cz) {
    addBoxLocal(houseGroup, 0.38, 3.8, 0.38, stuccoMat, -6.6, 1.9, cz);
  });

  // 1st Floor wide sliding glass door panels (facing pool)
  addBoxLocal(houseGroup, 0.08, 3.2, 16.0, glassSliderMat, -8.95, 1.6, 0);

  // Story 2: Intermediate floor band & Balcony (y = 4.1 to 8.4)
  addBoxLocal(houseGroup, 8.8, 0.35, 26.4, fasciaMat, -13.2, 4.2, 0);

  // Story 2: Upper floor structure
  addBoxLocal(houseGroup, 8.0, 4.0, 24.0, stuccoMat, -13.2, 6.3, 0);

  // Story 2: Covered balcony / terrace over the pool
  addBoxLocal(houseGroup, 2.0, 0.2, 14.0, fasciaMat, -8.0, 4.2, 0);
  // Upper balcony glass railing
  addBoxLocal(houseGroup, 0.06, 0.95, 14.0, glassSliderMat, -7.0, 4.8, 0);

  // Story 2: Upper bedroom / master suite sliding glass windows
  [-4.0, 4.0].forEach(function (wz) {
    addBoxLocal(houseGroup, 0.08, 2.2, 5.2, glassSliderMat, -9.2, 6.4, wz);
  });

  // Modern 2-story roof fascia / parapet (y = 8.4)
  addBoxLocal(houseGroup, 8.5, 0.4, 25.0, fasciaMat, -13.2, 8.4, 0);

  // Warm interior lights from 1st and 2nd stories
  var houseLight1 = new THREE.PointLight(0xffdfa8, 1.2, 18, 2);
  houseLight1.position.set(-10.2, 2.2, 0);
  houseGroup.add(houseLight1);

  var houseLight2 = new THREE.PointLight(0xffdfa8, 1.0, 16, 2);
  houseLight2.position.set(-10.2, 6.4, 0);
  houseGroup.add(houseLight2);

  // House address sign
  var houseLabel = makeLabel("2732 NE 23RD AVE", "#e2f7ff");
  houseLabel.position.set(-6.5, 4.4, 0);

  // ------------------------------------------------------------------
  // Lights in the water
  // ------------------------------------------------------------------
  var POOL_LIGHT_POS = new THREE.Vector3(POOL.x + 1.5, 0.18, POOL.z - 1.2);

  function makeLight(pos, parent) {
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
    (parent || scene).add(group);
    return { group: group, lens: lens, light: light, glow: glow };
  }
  var poolLamp = makeLight(POOL_LIGHT_POS);
  var spaLamp = makeLight(new THREE.Vector3(0, 0.92, 0), spaGroup);

  // ------------------------------------------------------------------
  // Equipment pad: pumps, heater, valves (touching South property line)
  // ------------------------------------------------------------------
  var southPropertyWall = addBox(32, 1.8, 0.28, new THREE.MeshStandardMaterial({
    color: 0xd6e0e4, roughness: 0.85
  }), 1.0, 0.9, 14.2);

  var pad = new THREE.Group();
  pad.position.set(-6.8, 0, 12.8);
  scene.add(pad);
  addBoxLocal(pad, 5.4, 0.18, 2.7, new THREE.MeshStandardMaterial({
    color: 0x142b32, roughness: 0.9
  }), 0, 0.09, 0);

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
  // Iggy the iguana (half of body and tail on the dock)
  // ------------------------------------------------------------------
  var iguana = createIguana();
  iguana.group.position.set(10.4, 0.12, -0.5);
  iguana.group.rotation.y = -Math.PI;
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
  var lastT = 0;

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
    if (state.blower && state.blower.on !== undefined) {
      blowerActive = !!state.blower.on;
    }
    isPoolMode = (mode === "pool");

    var conn = state.connection || {};
    var isOnline = !!conn.connected;
    updateLabel(connStatusLabel, isOnline ? "INTELLICENTER ONLINE" : "SIMULATION MODE",
      isOnline ? "#4df0a0" : "#ffaa33");

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

    // firebaskets (individual pool & spa spillway flows)
    var spillColor = effectColor(state.spillway_effect || "BLUER");
    Object.keys(baskets).forEach(function (key) {
      var b = baskets[key];
      var bs = state.firebaskets && state.firebaskets[key] ? state.firebaskets[key] : {};
      var burnerOn = !!bs.on;
      var poolFlow = !!bs.water;
      var spaFlow = !!bs.spa_water;
      var burnerLight = !!bs.burner_light;

      b.on = burnerOn || poolFlow || spaFlow;
      b.burnerLedMat.emissiveIntensity = burnerLight ? 2.4 : 0.0;
      b.burnerLedMat.color.setHex(burnerLight ? 0xffe6c0 : 0x3a3226);
      b.burnerLedLight.intensity = burnerLight ? 1.6 : 0.0;
      b.flames.forEach(function (flame) { flame.visible = burnerOn; });
      b.ember.material.emissiveIntensity = burnerOn ? 1.8 : 0.0;
      b.glow.intensity = burnerOn ? 2.4 : 0;

      if (b.poolSpill) {
        b.poolSpill.sheet.material.opacity = poolFlow ? 0.75 : 0.0;
        b.poolSpill.ledMat.color.setHex(spillColor);
        b.poolSpill.ledMat.emissive.setHex(spillColor);
        b.poolSpill.ledMat.emissiveIntensity = poolFlow ? 2.2 : 0.0;
        b.poolSpill.ledLight.color.setHex(spillColor);
        b.poolSpill.ledLight.intensity = poolFlow ? 1.4 : 0.0;
      }
      if (b.spaSpill) {
        b.spaSpill.sheet.material.opacity = spaFlow ? 0.75 : 0.0;
        b.spaSpill.ledMat.color.setHex(spillColor);
        b.spaSpill.ledMat.emissive.setHex(spillColor);
        b.spaSpill.ledMat.emissiveIntensity = spaFlow ? 2.2 : 0.0;
        b.spaSpill.ledLight.color.setHex(spillColor);
        b.spaSpill.ledLight.intensity = spaFlow ? 1.4 : 0.0;
      }

      var parts = [];
      if (poolFlow) parts.push("POOL");
      if (spaFlow) parts.push("SPA");
      if (burnerOn) parts.push("FIRE");
      if (burnerLight) parts.push("LIT");
      var statusText = parts.length ? parts.join("+") : "OFF";
      updateLabel(b.label,
        (key === "east" ? "FB EAST " : "FB WEST ") + statusText,
        (poolFlow || spaFlow || burnerOn || burnerLight) ? "#ffcf9a" : "#8c7462");
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
    updateLabel(heaterLabel, "HEATER " + (heaterOn ? "ON" : "OFF"),
      heaterOn ? "#ffcf9a" : "#7f8c90");

    var valves = state.valves || {};
    var drainSpa = valves.drain && valves.drain.spa !== undefined ? valves.drain.spa : 20;
    var retSpa = valves.return && valves.return.spa !== undefined ? valves.return.spa : 80;

    if (valves.drain_valve && state.inventory && state.inventory.valves) {
      for (var vi = 0; vi < state.inventory.valves.length; vi++) {
        if (state.inventory.valves[vi].objnam === valves.drain_valve) {
          drainSpa = (state.inventory.valves[vi].status === "ON") ? 80 : 20;
          break;
        }
      }
    }
    if (valves.return_valve && state.inventory && state.inventory.valves) {
      for (var vj = 0; vj < state.inventory.valves.length; vj++) {
        if (state.inventory.valves[vj].objnam === valves.return_valve) {
          retSpa = (state.inventory.valves[vj].status === "ON") ? 80 : 20;
          break;
        }
      }
    }

    valveDrain.handle.rotation.y = (drainSpa / 100) * Math.PI;
    valveReturn.handle.rotation.y = (retSpa / 100) * Math.PI;

  }

  function animate() {
    requestAnimationFrame(animate);
    // Skip rendering while the canvas is hidden (e.g. on the Live tab).
    if (!renderer.domElement.offsetParent) return;
    var t = clock.getElapsedTime();
    var dt = lastT ? Math.min(t - lastT, 0.1) : 0.016;
    lastT = t;
    controls.update();

    // Blower bubbles & foam animation
    if (blowerActive) {
      blowerIntensity = Math.min(1.0, blowerIntensity + dt * 4.0);
    } else {
      blowerIntensity = Math.max(0.0, blowerIntensity - dt * 2.5);
    }

    var showBubbles = blowerIntensity > 0.01;
    bubbleMesh.visible = showBubbles;
    foamPoints.visible = showBubbles;
    foamDisc.visible = showBubbles;

    if (showBubbles) {
      foamMat.opacity = blowerIntensity * 0.95;
      foamDisc.material.opacity = blowerIntensity * (0.35 + Math.sin(t * 8) * 0.08);
      spaWaterMat.opacity = Math.max(0.48, 0.9 - blowerIntensity * 0.38);

      for (var bi = 0; bi < BUBBLE_COUNT; bi++) {
        var b = bubbles[bi];
        b.y += b.speed * dt * (0.5 + 0.5 * blowerIntensity);
        if (b.y > SPA.y + 0.16) {
          b.y = 0.15 + Math.random() * 0.1;
          b.x = (Math.random() - 0.5) * 2.8;
          b.z = (Math.random() - 0.5) * 2.8;
        }
        var curX = b.x + Math.sin(t * b.wobbleSpeed + b.phase) * b.wobbleAmp;
        var curZ = b.z + Math.cos(t * b.wobbleSpeed + b.phase) * b.wobbleAmp;
        var progress = Math.min(1.0, Math.max(0.0, (b.y - 0.15) / (SPA.y - 0.15)));
        var curScale = b.radius * (1.0 + 0.8 * progress) * Math.min(1.0, blowerIntensity * 1.6);

        dummyObj.position.set(curX, b.y, curZ);
        dummyObj.scale.set(curScale, curScale, curScale);
        dummyObj.updateMatrix();
        bubbleMesh.setMatrixAt(bi, dummyObj.matrix);
      }
      bubbleMesh.instanceMatrix.needsUpdate = true;

      var fArr = foamGeom.attributes.position.array;
      for (var fi = 0; fi < FOAM_COUNT; fi++) {
        var fs = foamSeeds[fi];
        var angle = t * fs.speed + fs.phase;
        fArr[fi * 3] = fs.bx + Math.cos(angle) * fs.radius;
        fArr[fi * 3 + 1] = SPA.y + 0.015 + Math.sin(t * 12 + fi) * 0.015;
        fArr[fi * 3 + 2] = fs.bz + Math.sin(angle) * fs.radius;
      }
      foamGeom.attributes.position.needsUpdate = true;
    } else {
      spaWaterMat.opacity = 0.9;
    }

    // Waterfall animation (pool mode vs spa mode)
    if (isPoolMode) {
      waterfallIntensity = Math.min(1.0, waterfallIntensity + dt * 2.5);
    } else {
      waterfallIntensity = Math.max(0.0, waterfallIntensity - dt * 2.5);
    }

    var showWaterfall = waterfallIntensity > 0.01;
    wfMesh.visible = showWaterfall;
    wfSprayPoints.visible = showWaterfall;
    impactFoam.visible = showWaterfall;
    spaLip.visible = showWaterfall;

    if (showWaterfall) {
      wfTex.offset.y -= dt * 3.8;
      wfMat.opacity = waterfallIntensity * 0.9;
      spaLipMat.opacity = waterfallIntensity * 0.88;
      impactFoamMat.opacity = waterfallIntensity * (0.42 + Math.sin(t * 11) * 0.12);
      wfSprayMat.opacity = waterfallIntensity * 0.85;

      for (var k = 0; k < wfPos.length; k += 3) {
        var bx = wfBase[k];
        var by = wfBase[k + 1];
        var bz = wfBase[k + 2];
        var vFrac = Math.min(1.0, Math.max(0.0, (0.77 - by) / 0.68));
        var turb = Math.sin(by * 16.0 + t * 14.0 + bx * 3.5) * 0.018 * vFrac;
        var flutter = Math.cos(by * 24.0 - t * 20.0) * 0.012 * vFrac;
        wfPos[k] = bx + Math.sin(by * 10.0 + t * 9.0) * 0.01 * vFrac;
        wfPos[k + 1] = by;
        wfPos[k + 2] = bz + (turb + flutter) * waterfallIntensity;
      }
      wfGeo.attributes.position.needsUpdate = true;
      wfGeo.computeVertexNormals();

      var spArr = wfSprayGeom.attributes.position.array;
      for (var si = 0; si < WF_SPRAY_COUNT; si++) {
        var sd = wfSprayData[si];
        spArr[si * 3 + 1] -= sd.speed * dt;
        if (spArr[si * 3 + 1] < 0.09) {
          spArr[si * 3 + 1] = 0.77;
          spArr[si * 3] = (Math.random() - 0.5) * (WF_WIDTH - 0.1);
        }
        var curY = spArr[si * 3 + 1];
        var sProg = Math.min(1.0, Math.max(0.0, (0.77 - curY) / 0.68));
        spArr[si * 3] += Math.sin(t * 8 + sd.phase) * 0.005;
        spArr[si * 3 + 2] = 2.45 + sProg * 0.33 + Math.sin(t * 12 + si) * 0.015;
      }
      wfSprayGeom.attributes.position.needsUpdate = true;
    }

    // Pool water ripples + waterfall impact ripples
    var pArr = poolWaterGeo.attributes.position.array;
    for (var i = 0; i < pArr.length; i += 3) {
      var x = poolBase[i];
      var y = poolBase[i + 1];
      var rWave = Math.sin(x * 1.15 + t * 1.6) * 0.035 +
        Math.cos(y * 1.45 - t * 1.2) * 0.03;
      if (waterfallIntensity > 0.001) {
        var dImpact = Math.sqrt((x - 2.05) * (x - 2.05) + (y - (-4.75)) * (y - (-4.75)));
        if (dImpact < 3.2) {
          rWave += Math.sin(dImpact * 6.5 - t * 9.5) * (0.045 / (1.0 + dImpact * 1.4)) * waterfallIntensity;
        }
      }
      pArr[i + 2] = rWave;
    }
    poolWaterGeo.attributes.position.needsUpdate = true;

    var sArr = spaWaterGeo.attributes.position.array;
    var churnAmp = blowerIntensity * 0.055;
    for (var j = 0; j < sArr.length; j += 3) {
      var sx = spaBase[j];
      var sy = spaBase[j + 1];
      var wave = Math.sin(sx * 2.2 + t * 2.2) * 0.025 +
        Math.cos(sy * 2.5 - t * 1.8) * 0.02;
      if (churnAmp > 0.001) {
        wave += Math.sin(sx * 6.5 + t * 8.5) * churnAmp +
                Math.cos(sy * 7.5 - t * 7.0) * (churnAmp * 0.8) +
                Math.sin((sx + sy) * 10.0 + t * 12.0) * (churnAmp * 0.5);
      }
      sArr[j + 2] = wave;
    }
    spaWaterGeo.attributes.position.needsUpdate = true;

    // Canal water ripples
    if (canalWaterGeo && canalBase) {
      var cArr = canalWaterGeo.attributes.position.array;
      for (var ci = 0; ci < cArr.length; ci += 3) {
        var cx = canalBase[ci];
        var cy = canalBase[ci + 1];
        cArr[ci + 2] = Math.sin(cx * 0.9 + t * 1.4) * 0.035 + Math.cos(cy * 1.1 - t * 1.0) * 0.03;
      }
      canalWaterGeo.attributes.position.needsUpdate = true;
    }

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
    resize: resize,
    setTalking: function (on) {
      if (iguana) iguana.targetTalk = on ? 1 : 0;
    },
    setBlower: function (on) {
      blowerActive = !!on;
    },
    setMode: function (mode) {
      isPoolMode = (mode === "pool");
    },
    setConnection: function (conn) {
      var isOnline = !!(conn && conn.connected);
      updateLabel(connStatusLabel, isOnline ? "INTELLICENTER ONLINE" : "SIMULATION MODE",
        isOnline ? "#4df0a0" : "#ffaa33");
    },
    focus: function (which) {
      if (which === "spa") {
        controls.target.set(SPA.x, 0.7, SPA.z);
        camera.position.set(SPA.x + 5.5, 5.0, SPA.z + 5.5);
      } else if (which === "jets") {
        controls.target.set(POOL.x, 0.5, POOL.z);
        camera.position.set(POOL.x + 8.0, 7.5, POOL.z + 8.0);
      } else if (which === "dock") {
        controls.target.set(13.0, 0.5, 0);
        camera.position.set(19.0, 8.0, 6.0);
      } else if (which === "pumps" || which === "pad") {
        controls.target.set(-6.8, 0.5, 12.8);
        camera.position.set(-2.0, 4.5, 16.5);
      } else if (which === "house") {
        controls.target.set(-9.0, 2.0, 0);
        camera.position.set(-2.0, 6.0, 10.0);
      } else {
        controls.target.set(0.5, 0.5, 1.0);
        camera.position.set(16.5, 14.0, 16.5);
      }
      controls.update();
    }
  };
})();

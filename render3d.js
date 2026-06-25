/* =========================================================================
 * render3d.js — Three.js low-poly renderer for the supermarket game.
 *
 * Reads window.Game.getState() every frame and mirrors it into a 3D scene.
 * Owns the requestAnimationFrame loop and drives Game.update(dt).
 *
 * Depends on: THREE (r149 global), window.Game.
 * Publishes:  window.Render3D = { init(canvas) }
 * ========================================================================= */
(function () {
  'use strict';

  var Game = window.Game;
  var WORLD = Game.WORLD;

  var scene, camera, renderer, clock;
  var canvasEl, floatLayer;
  var camTarget = new THREE.Vector3(0, 0, 0);
  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var clickPoint = new THREE.Vector3();
  var dragStick, dragKnob;
  var dragPointerId = null;
  var dragOrigin = { x: 0, y: 0 };
  var dragActive = false;
  var DRAG_DEADZONE = 10;
  var DRAG_RADIUS = 58;

  // entity pools keyed by id
  var playerGroup, carryGroup;
  var shelfMeshes = {};   // id -> { group, fillBars:[], lockMesh, sign }
  var sourceMeshes = {};  // id -> { group, crops:[] }
  var checkoutMeshes = {};// id -> group
  var padMeshes = {};     // id -> { group, ring, label }
  var customerPool = [];  // reusable customer meshes
  var customerMap = {};   // id -> mesh
  var tutorialBeacon;
  var floatPool = [];     // reusable DOM float elements

  function colorHex(type) { return Game.getProductColor(type); }

  // ---- material helpers --------------------------------------------------
  function mat(color, opts) {
    opts = opts || {};
    return new THREE.MeshLambertMaterial({
      color: color,
      transparent: !!opts.transparent,
      opacity: opts.opacity == null ? 1 : opts.opacity
    });
  }
  function box(w, h, d, color, opts) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  }
  function cyl(rt, rb, h, color, seg) {
    return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 10), mat(color));
  }

  // ---- scene setup -------------------------------------------------------
  function init(canvas) {
    canvasEl = canvas;
    floatLayer = document.getElementById('floatLayer');

    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x8fd3ff, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x8fd3ff, 40, 75);

    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(0, 26, 22);
    camera.lookAt(0, 0, 0);

    // lights
    var amb = new THREE.HemisphereLight(0xffffff, 0x6b8f5a, 0.95);
    scene.add(amb);
    var sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(-18, 30, 12);
    scene.add(sun);

    buildGround();
    buildStaticFromState();

    // player
    playerGroup = buildPlayer();
    scene.add(playerGroup);
    carryGroup = new THREE.Group();
    playerGroup.add(carryGroup);

    // tutorial beacon
    tutorialBeacon = buildBeacon();
    tutorialBeacon.visible = false;
    scene.add(tutorialBeacon);

    clock = new THREE.Clock();
    resize();
    window.addEventListener('resize', resize);
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('pointercancel', onPointerCancel);
    requestAnimationFrame(loop);
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    dragPointerId = e.pointerId;
    dragOrigin.x = e.clientX;
    dragOrigin.y = e.clientY;
    dragActive = false;
    showDragStick(e.clientX, e.clientY, 0, 0);
    if (canvasEl.setPointerCapture) {
      try { canvasEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }

  function onPointerMove(e) {
    if (dragPointerId !== e.pointerId) return;
    if (e.cancelable) e.preventDefault();
    var dx = e.clientX - dragOrigin.x;
    var dy = e.clientY - dragOrigin.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    var clampedX = dx;
    var clampedY = dy;
    if (len > DRAG_RADIUS) {
      clampedX = dx / len * DRAG_RADIUS;
      clampedY = dy / len * DRAG_RADIUS;
    }
    showDragStick(dragOrigin.x, dragOrigin.y, clampedX, clampedY);
    if (len > DRAG_DEADZONE) {
      dragActive = true;
      Game.setMove(clampedX / DRAG_RADIUS, clampedY / DRAG_RADIUS);
    } else if (dragActive) {
      Game.setMove(0, 0);
    }
  }

  function onPointerUp(e) {
    if (dragPointerId !== e.pointerId) return;
    if (e.cancelable) e.preventDefault();
    if (canvasEl.releasePointerCapture) {
      try { canvasEl.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    if (dragActive) {
      Game.setMove(0, 0);
    } else {
      moveToClickedGround(e);
    }
    dragPointerId = null;
    dragActive = false;
    hideDragStick();
  }

  function onPointerCancel(e) {
    if (dragPointerId !== e.pointerId) return;
    Game.setMove(0, 0);
    dragPointerId = null;
    dragActive = false;
    hideDragStick();
  }

  function moveToClickedGround(e) {
    var rect = canvasEl.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(groundPlane, clickPoint)) {
      Game.setMoveTarget(clickPoint.x, clickPoint.z);
    }
  }

  function ensureDragStick() {
    if (dragStick) return;
    dragStick = document.createElement('div');
    dragStick.id = 'freeStick';
    dragStick.innerHTML = '<div id="freeStickBase"><div id="freeStickKnob"></div></div>';
    document.body.appendChild(dragStick);
    dragKnob = document.getElementById('freeStickKnob');
  }

  function showDragStick(x, y, dx, dy) {
    ensureDragStick();
    dragStick.style.display = 'block';
    dragStick.style.left = x + 'px';
    dragStick.style.top = y + 'px';
    dragKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  function hideDragStick() {
    if (!dragStick) return;
    dragStick.style.display = 'none';
    dragKnob.style.transform = 'translate(0,0)';
  }

  function resize() {
    var w = canvasEl.clientWidth || window.innerWidth;
    var h = canvasEl.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---- ground / world decor ---------------------------------------------
  function buildGround() {
    var W = WORLD.maxX - WORLD.minX;
    var midX = (WORLD.minX + WORLD.maxX) / 2;

    // Store floor (z<0): tiled grey.
    var storeD = 0 - WORLD.minZ;
    var store = box(W + 6, 0.4, storeD + 2, 0xd7d2c4);
    store.position.set(midX, -0.2, (WORLD.minZ + 0) / 2);
    scene.add(store);

    // checkerboard tiles on the store floor for readability
    var tile = new THREE.Group();
    for (var tx = WORLD.minX; tx < WORLD.maxX; tx += 4) {
      for (var tz = WORLD.minZ; tz < 0; tz += 4) {
        if (((tx + tz) / 4) % 2 === 0) {
          var t = box(3.8, 0.06, 3.8, 0xc7c2b4);
          t.position.set(tx + 2, 0.02, tz + 2);
          tile.add(t);
        }
      }
    }
    scene.add(tile);

    // Farm floor (z>0): green soil.
    var farmD = WORLD.maxZ - 0;
    var farm = box(W + 6, 0.4, farmD + 2, 0x6fae54);
    farm.position.set(midX, -0.2, (0 + WORLD.maxZ) / 2);
    scene.add(farm);

    // soil patches on the farm
    var soil = new THREE.Group();
    for (var sx = WORLD.minX + 2; sx < WORLD.maxX; sx += 4) {
      for (var sz = 2; sz < WORLD.maxZ; sz += 4) {
        var p = box(3.4, 0.08, 3.4, 0x7a5a3a);
        p.position.set(sx, 0.04, sz);
        soil.add(p);
      }
    }
    scene.add(soil);

    // Boundary walls (low) around the whole lot.
    var wallMat = 0xb9b1a0;
    addWall(midX, WORLD.minZ - 0.5, W + 6, 1.2, 0.5, wallMat);   // back (store)
    addWall(midX, WORLD.maxZ + 0.5, W + 6, 1.2, 0.5, wallMat);   // back (farm)
    addWallV(WORLD.maxX + 0.5, 0, WORLD.maxZ - WORLD.minZ + 2, 1.2, 0.5, wallMat); // right
    // left wall has the entrance gap near z=-1
    addWallV(WORLD.minX - 0.5, -8, 14, 1.2, 0.5, wallMat);

    // Entrance arch marker
    var arch = box(0.6, 4, 0.6, 0xff7043);
    arch.position.set(WORLD.minX + 0.2, 2, 2.2);
    scene.add(arch);
    var arch2 = arch.clone(); arch2.position.z = -4.2; scene.add(arch2);
    var top = box(0.6, 0.6, 7, 0xff7043); top.position.set(WORLD.minX + 0.2, 4, -1); scene.add(top);

    // dividing fence between store and farm (z=0) with a gap in the middle
    var fence = new THREE.Group();
    for (var fx = WORLD.minX + 1; fx < WORLD.maxX; fx += 2) {
      if (Math.abs(fx) < 3) continue; // gap to walk through
      var post = box(0.25, 1.2, 0.25, 0x8a6b4a);
      post.position.set(fx, 0.6, 0);
      fence.add(post);
    }
    scene.add(fence);
  }
  function addWall(x, z, w, h, d, color) {
    var m = box(w, h, d, color); m.position.set(x, h / 2, z); scene.add(m);
  }
  function addWallV(x, z, d, h, w, color) {
    var m = box(w, h, d, color); m.position.set(x, h / 2, z); scene.add(m);
  }

  // ---- player ------------------------------------------------------------
  function buildPlayer() {
    var g = new THREE.Group();
    var body = box(1.0, 1.2, 0.7, 0x2b6cff); body.position.y = 0.9; g.add(body);
    var apron = box(1.02, 0.7, 0.72, 0xffffff); apron.position.y = 0.7; g.add(apron);
    var head = box(0.7, 0.7, 0.7, 0xffcca0); head.position.y = 1.9; g.add(head);
    var cap = box(0.78, 0.22, 0.78, 0xff3b3b); cap.position.y = 2.32; g.add(cap);
    // legs
    var l1 = box(0.34, 0.7, 0.34, 0x33373d); l1.position.set(-0.25, 0.35, 0); g.add(l1);
    var l2 = box(0.34, 0.7, 0.34, 0x33373d); l2.position.set(0.25, 0.35, 0); g.add(l2);
    // facing marker (nose)
    var nose = box(0.2, 0.2, 0.25, 0xff8a65); nose.position.set(0, 1.9, 0.45); g.add(nose);
    g.userData.legs = [l1, l2];
    return g;
  }

  function buildCarryStack(type, count) {
    while (carryGroup.children.length) carryGroup.remove(carryGroup.children[0]);
    if (!type || count <= 0) return;
    var c = colorHex(type);
    var n = Math.min(count, 10);
    for (var i = 0; i < n; i++) {
      var b = box(0.55, 0.32, 0.55, c);
      b.position.set(0, 2.55 + i * 0.34, 0.05);
      carryGroup.add(b);
    }
  }

  // ---- shelves -----------------------------------------------------------
  function buildShelf(s) {
    var g = new THREE.Group();
    g.position.set(s.x, 0, s.z);

    var frameColor = 0x9aa3ad;
    // base + two tiers
    var base = box(2.4, 0.5, 1.2, frameColor); base.position.y = 0.25; g.add(base);
    var t1 = box(2.4, 0.12, 1.2, frameColor); t1.position.y = 0.9; g.add(t1);
    var t2 = box(2.4, 0.12, 1.2, frameColor); t2.position.y = 1.5; g.add(t2);
    var backP = box(2.4, 1.6, 0.12, 0xb7bec6); backP.position.set(0, 1.0, -0.55); g.add(backP);

    // product fill bars (boxes) on the two tiers
    var fillBars = [];
    var pc = colorHex(s.productType);
    for (var tier = 0; tier < 2; tier++) {
      for (var col = 0; col < 4; col++) {
        var item = box(0.45, 0.45, 0.8, pc);
        item.position.set(-0.85 + col * 0.57, tier === 0 ? 1.2 : 1.8, 0.05);
        item.visible = false;
        g.add(item);
        fillBars.push(item);
      }
    }

    // hanging sign with product colour
    var sign = box(1.6, 0.5, 0.1, pc); sign.position.set(0, 2.5, 0); g.add(sign);
    var post = box(0.1, 1.0, 0.1, 0x6b7178); post.position.set(0, 2.1, 0); g.add(post);

    // structural meshes we dim to a "ghost" when the shelf is locked
    var frame = [base, t1, t2, backP, sign, post];

    // floating padlock shown only while locked
    var lock = new THREE.Group();
    var lbody = box(0.5, 0.4, 0.2, 0xf4c542); lbody.position.y = 0; lock.add(lbody);
    var shackle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.06, 6, 12, Math.PI),
      new THREE.MeshLambertMaterial({ color: 0xcfcfcf }));
    shackle.position.y = 0.2; lock.add(shackle);
    lock.position.set(0, 2.4, 0.6); g.add(lock);

    scene.add(g);
    shelfMeshes[s.id] = { group: g, fillBars: fillBars, frame: frame, lock: lock, sign: sign };
  }

  function setOpacity(meshes, op) {
    for (var i = 0; i < meshes.length; i++) {
      var mm = meshes[i].material;
      mm.transparent = op < 1; mm.opacity = op;
    }
  }

  function syncShelf(s) {
    var m = shelfMeshes[s.id];
    if (!m) { buildShelf(s); m = shelfMeshes[s.id]; }
    m.group.visible = true;
    m.lock.visible = s.locked;
    setOpacity(m.frame, s.locked ? 0.32 : 1);
    var fillCount = Math.round((s.amount / s.capacity) * m.fillBars.length);
    for (var i = 0; i < m.fillBars.length; i++) {
      m.fillBars[i].visible = !s.locked && i < fillCount;
    }
  }

  // ---- sources (farm plots) ---------------------------------------------
  function buildSource(s) {
    var g = new THREE.Group();
    g.position.set(s.x, 0, s.z);

    // raised garden bed
    var bed = box(2.6, 0.4, 2.6, 0x5a3d26); bed.position.y = 0.2; g.add(bed);
    var soil = box(2.3, 0.2, 2.3, 0x3f2c1c); soil.position.y = 0.42; g.add(soil);

    // sign post showing the crop colour
    var sign = box(0.9, 0.6, 0.1, colorHex(s.productType));
    sign.position.set(0, 2.0, -1.0); g.add(sign);
    var post = box(0.12, 2.0, 0.12, 0x6b4a2c); post.position.set(0, 1.0, -1.0); g.add(post);

    // crop plants (3x3 grid). Scale conveys growth+stock.
    var crops = [];
    var pc = colorHex(s.productType);
    for (var ix = 0; ix < 3; ix++) {
      for (var iz = 0; iz < 3; iz++) {
        var stalk = new THREE.Group();
        var stem = box(0.12, 0.5, 0.12, 0x2f7d32); stem.position.y = 0.25; stalk.add(stem);
        var fruit = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), mat(pc));
        fruit.position.y = 0.6; stalk.add(fruit);
        stalk.position.set(-0.75 + ix * 0.75, 0.5, -0.75 + iz * 0.75);
        g.add(stalk);
        crops.push(stalk);
      }
    }

    scene.add(g);
    sourceMeshes[s.id] = { group: g, crops: crops };
  }

  function syncSource(s) {
    var m = sourceMeshes[s.id];
    if (!m) { buildSource(s); m = sourceMeshes[s.id]; }
    // Show crops proportional to stock; the "next" one scales with growth.
    var full = Math.floor((s.stock / 14) * m.crops.length);
    for (var i = 0; i < m.crops.length; i++) {
      var c = m.crops[i];
      if (i < full) {
        c.visible = true; c.scale.setScalar(1);
      } else if (i === full) {
        c.visible = true; c.scale.setScalar(0.4 + s.growth * 0.6);
      } else {
        c.visible = false;
      }
    }
  }

  // ---- checkouts ---------------------------------------------------------
  function buildCheckout(c) {
    var g = new THREE.Group();
    g.position.set(c.x, 0, c.z);
    var counter = box(1.6, 1.0, 2.2, 0xefce6a); counter.position.y = 0.5; g.add(counter);
    var belt = box(1.0, 0.1, 2.0, 0x2f3338); belt.position.set(0, 1.02, 0); g.add(belt);
    var reg = box(0.6, 0.5, 0.6, 0xdfe3e8); reg.position.set(0.4, 1.3, -0.6); g.add(reg);
    // a little cashier
    var head = box(0.5, 0.5, 0.5, 0xffcca0); head.position.set(-0.9, 1.6, 0); g.add(head);
    var body = box(0.7, 0.8, 0.5, 0x3aa655); body.position.set(-0.9, 1.0, 0); g.add(body);
    scene.add(g);
    checkoutMeshes[c.id] = g;
  }
  function syncCheckout(c) {
    if (!checkoutMeshes[c.id]) buildCheckout(c);
  }

  // ---- pads --------------------------------------------------------------
  function buildPad(p) {
    var g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    var plate = cyl(1.2, 1.2, 0.2, 0xffd54a, 16); plate.position.y = 0.12; g.add(plate);
    var ring = cyl(1.25, 1.25, 0.24, 0x4caf50, 16);
    ring.position.y = 0.13; ring.scale.set(1, 1, 1); g.add(ring);
    // floating arrow
    var arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.8, 4), mat(0x4caf50));
    arrow.position.y = 1.6; g.add(arrow);
    g.userData.arrow = arrow;

    // DOM label
    var label = document.createElement('div');
    label.className = 'pad-label';
    floatLayer.appendChild(label);

    scene.add(g);
    padMeshes[p.id] = { group: g, ring: ring, plate: plate, label: label, arrow: arrow };
  }
  function syncPad(p) {
    var m = padMeshes[p.id];
    if (!m) { buildPad(p); m = padMeshes[p.id]; }
    var frac = Math.min(1, p.paid / p.cost);
    var done = p.paid >= p.cost;
    m.group.visible = !done;
    if (m.label) m.label.style.display = done ? 'none' : 'block';
    if (done) return;
    // ring colour from green->amber as you pay; plate shows progress
    m.plate.scale.set(1, 0.3 + frac * 1.4, 1);
    // project label to screen
    projectLabel(m.label, p.x, 2.4, p.z,
      '<b>' + p.label + '</b><br>$' + p.paid + ' / $' + p.cost);
  }

  // ---- customers ---------------------------------------------------------
  function buildCustomerMesh() {
    var g = new THREE.Group();
    var body = box(0.85, 1.0, 0.6, 0xcf5fae); body.position.y = 0.8; g.add(body);
    var head = box(0.6, 0.6, 0.6, 0xffcca0); head.position.y = 1.6; g.add(head);
    var l1 = box(0.3, 0.6, 0.3, 0x444a52); l1.position.set(-0.22, 0.3, 0); g.add(l1);
    var l2 = box(0.3, 0.6, 0.3, 0x444a52); l2.position.set(0.22, 0.3, 0); g.add(l2);
    var item = box(0.5, 0.5, 0.5, 0xffffff); item.position.set(0, 1.9, 0); item.visible = false;
    g.add(item);
    g.userData.item = item;
    g.userData.body = body;
    scene.add(g);
    return g;
  }
  function customerColor(idx) {
    var palette = [0xcf5fae, 0x5fa8cf, 0xcf9b5f, 0x7fcf5f, 0xcf5f5f, 0x9b5fcf];
    return palette[idx % palette.length];
  }
  function syncCustomers(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      seen[c.id] = true;
      var m = customerMap[c.id];
      if (!m) {
        m = customerPool.pop() || buildCustomerMesh();
        m.visible = true;
        m.userData.body.material.color.setHex(customerColor(i + c.id.length));
        customerMap[c.id] = m;
      }
      m.position.set(c.x, 0, c.z);
      m.rotation.y = c.angle;
      var item = m.userData.item;
      if (c.carryType) {
        item.visible = true;
        item.material.color.setHex(colorHex(c.carryType));
      } else {
        item.visible = false;
      }
    }
    // retire unseen
    for (var id in customerMap) {
      if (!seen[id]) {
        var mm = customerMap[id];
        mm.visible = false;
        customerPool.push(mm);
        delete customerMap[id];
      }
    }
  }

  // ---- tutorial beacon ---------------------------------------------------
  function buildBeacon() {
    var g = new THREE.Group();
    var cone = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe23b }));
    cone.rotation.x = Math.PI; cone.position.y = 3.2; g.add(cone);
    return g;
  }

  // ---- floating text (DOM overlay) --------------------------------------
  var tmpV = new THREE.Vector3();
  function projectLabel(el, x, y, z, html) {
    tmpV.set(x, y, z);
    tmpV.project(camera);
    var w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    var sx = (tmpV.x * 0.5 + 0.5) * w;
    var sy = (-tmpV.y * 0.5 + 0.5) * h;
    if (tmpV.z > 1) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    if (html != null) el.innerHTML = html;
  }

  function syncFloats(floats) {
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i];
      var el = floatPool[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'float-text';
        floatLayer.appendChild(el);
        floatPool[i] = el;
      }
      el.style.display = 'block';
      el.textContent = f.text;
      el.style.color = f.color || '#fff';
      el.style.opacity = Math.max(0, Math.min(1, f.life));
      projectLabel(el, f.x, f.y, f.z, null);
    }
    for (var j = floats.length; j < floatPool.length; j++) {
      if (floatPool[j]) floatPool[j].style.display = 'none';
    }
  }

  // ---- build static entities once ---------------------------------------
  function buildStaticFromState() {
    var st = Game.getState();
    if (!st) return;
    st.shelves.forEach(buildShelf);
    st.sources.forEach(buildSource);
    st.checkouts.forEach(buildCheckout);
    st.pads.forEach(buildPad);
  }

  // ---- main loop ---------------------------------------------------------
  var legPhase = 0;
  function loop() {
    requestAnimationFrame(loop);
    var dt = clock.getDelta();
    Game.update(dt);

    var st = Game.getState();
    if (!st) { renderer.render(scene, camera); return; }

    // player
    playerGroup.position.set(st.player.x, 0, st.player.z);
    playerGroup.rotation.y = st.player.angle;
    buildCarryStack(st.player.carryType, st.player.carryCount);
    // simple walking bob
    var moving = (st.player.carryCount >= 0); // always slight idle
    legPhase += dt * 10;
    var legs = playerGroup.userData.legs;
    if (legs) {
      legs[0].rotation.x = Math.sin(legPhase) * 0.4;
      legs[1].rotation.x = -Math.sin(legPhase) * 0.4;
    }

    // entities
    st.shelves.forEach(syncShelf);
    st.sources.forEach(syncSource);
    st.checkouts.forEach(syncCheckout);
    st.pads.forEach(syncPad);
    syncCustomers(st.customers);
    syncFloats(st.floats);

    // tutorial beacon
    if (st.tutorialTarget) {
      tutorialBeacon.visible = true;
      tutorialBeacon.position.set(st.tutorialTarget.x, 0, st.tutorialTarget.z);
      tutorialBeacon.children[0].position.y = 3.2 + Math.sin(legPhase * 0.6) * 0.25;
    } else {
      tutorialBeacon.visible = false;
    }

    // camera follow (smooth) — angled top-down
    camTarget.lerp(new THREE.Vector3(st.player.x, 0, st.player.z), 0.08);
    var camX = camTarget.x * 0.5;
    camera.position.lerp(
      new THREE.Vector3(camTarget.x * 0.4, 24, camTarget.z + 20), 0.06);
    camera.lookAt(camTarget.x * 0.4, 0, camTarget.z - 2);

    renderer.render(scene, camera);

    // HUD
    if (window.HUD) window.HUD.update(st);
  }

  window.Render3D = { init: init };
})();

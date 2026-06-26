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
  var textureLoader = new THREE.TextureLoader();
  var fruitTextureCache = {};

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
  var districtSigns = [];

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
  function sphere(r, color, seg) {
    return new THREE.Mesh(new THREE.SphereGeometry(r, seg || 16, seg || 16), mat(color));
  }

  function fruitAssetPath(type, variant) {
    var names = {
      apple:  { single: 'apple-single.png', crate: 'apple-crate.png' },
      banana: { single: 'banana-bunch.png', crate: 'banana-crate.png' },
      grape:  { single: 'grape-bunch.png', crate: 'grape-crate.png' }
    };
    var byType = names[type] || names.apple;
    return 'assets/fruit/' + (byType[variant] || byType.single);
  }

  function fruitTexture(type, variant) {
    var key = type + ':' + variant;
    if (!fruitTextureCache[key]) {
      var tx = textureLoader.load(fruitAssetPath(type, variant));
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      if (THREE.sRGBEncoding) tx.encoding = THREE.sRGBEncoding;
      fruitTextureCache[key] = tx;
    }
    return fruitTextureCache[key];
  }

  function fruitAssetSprite(type, scale, variant) {
    scale = scale || 1;
    variant = variant || 'single';
    var g = new THREE.Group();
    var material = new THREE.SpriteMaterial({
      map: fruitTexture(type, variant),
      transparent: true,
      alphaTest: 0.08,
      depthWrite: false
    });
    var sprite = new THREE.Sprite(material);
    var size = {
      apple:  { single: [0.78, 0.78], crate: [1.65, 1.35] },
      banana: { single: [1.05, 0.86], crate: [1.7, 1.35] },
      grape:  { single: [0.9, 1.02], crate: [1.7, 1.35] }
    };
    var dims = (size[type] && size[type][variant]) || size.apple.single;
    sprite.scale.set(dims[0] * scale, dims[1] * scale, 1);
    sprite.center.set(0.5, 0.5);
    g.add(sprite);
    g.userData.sprite = sprite;
    return g;
  }

  function fruitMesh(type, scale) {
    return fruitAssetSprite(type, scale, 'single');
  }

  function fruitCrateMesh(type, scale) {
    return fruitAssetSprite(type, scale, 'crate');
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
    buildDistrictSigns();
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
  // A cute low-poly "small farm + fruit shop" stage. This only builds scenery
  // and leaves fruit sprites, controls, entity sync and cashier logic alone.
  var GCOL = {
    grass: 0x8fd24c, grassDk: 0x7cc23e, grassLt: 0xa6dd62,
    path: 0xe7d3a1, pathEdge: 0xd8c08a, soilDk: 0x5f3c20,
    storeFloor: 0xf4e7c8, storeTile: 0xe7d3a4,
    wood: 0xb9824a, woodDk: 0x8a5a2b, fence: 0xd2a86a, fenceDk: 0xb88a4e,
    leaf: 0x4fae44, leafDk: 0x3c8c36, awningA: 0xe8543f, awningB: 0xfff1e0,
    signWood: 0xc98a4e
  };

  function buildGround() {
    var W = WORLD.maxX - WORLD.minX;
    var D = WORLD.maxZ - WORLD.minZ;
    var midX = (WORLD.minX + WORLD.maxX) / 2;
    var midZ = (WORLD.minZ + WORLD.maxZ) / 2;

    var grass = box(W + 14, 1.0, D + 14, GCOL.grass);
    grass.position.set(midX, -0.5, midZ);
    scene.add(grass);

    var seed = 1;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    var patches = new THREE.Group();
    for (var i = 0; i < 26; i++) {
      var pw = 3 + rnd() * 5;
      var pch = box(pw, 0.06, pw * (0.7 + rnd() * 0.6), rnd() > 0.5 ? GCOL.grassDk : GCOL.grassLt);
      pch.position.set(WORLD.minX - 4 + rnd() * (W + 8), 0.02, WORLD.minZ - 4 + rnd() * (D + 8));
      pch.rotation.y = rnd() * Math.PI;
      patches.add(pch);
    }
    scene.add(patches);

    var storeFront = -0.6;
    var storeD = storeFront - WORLD.minZ;
    var floor = box(W + 4, 0.4, storeD, GCOL.storeFloor);
    floor.position.set(midX, -0.2, (WORLD.minZ + storeFront) / 2);
    scene.add(floor);

    var tiles = new THREE.Group();
    for (var tx = WORLD.minX - 1; tx < WORLD.maxX + 1; tx += 3) {
      for (var tz = WORLD.minZ; tz < storeFront; tz += 3) {
        if ((Math.round(tx) + Math.round(tz)) % 6 === 0) {
          var t = box(2.9, 0.06, 2.9, GCOL.storeTile);
          t.position.set(tx + 1.5, 0.03, tz + 1.5);
          tiles.add(t);
        }
      }
    }
    scene.add(tiles);

    gPath(0, midZ + 1, 5.0, D + 6);
    gPath(WORLD.minX + 8, -2.5, 24, 5.0);
    gPath(0, 7.5, W - 2, 4.0);

    for (var rz = 3; rz <= 12; rz += 3.2) {
      var rib = box(W - 2, 0.05, 0.5, GCOL.soilDk, { transparent: true, opacity: 0.5 });
      rib.position.set(midX, 0.05, rz);
      scene.add(rib);
    }

    var fg = new THREE.Group();
    var nx = WORLD.minX - 1.5, xx = WORLD.maxX + 1.5;
    var nz = WORLD.minZ - 1.5, xz = WORLD.maxZ + 1.5;
    gFence(fg, nx, nz, xx, nz);
    gFence(fg, nx, xz, xx, xz);
    gFence(fg, xx, nz, xx, xz);
    gFence(fg, nx, nz, nx, -4.5);
    gFence(fg, nx, 2.5, nx, xz);
    gFence(fg, nx + 2, 0, -3, 0);
    gFence(fg, 3, 0, xx - 2, 0);
    scene.add(fg);

    buildShopFacade(midX);
    buildDecor();
  }

  function gPath(cx, cz, w, d) {
    var edge = box(w + 0.8, 0.08, d + 0.8, GCOL.pathEdge);
    edge.position.set(cx, 0.04, cz);
    scene.add(edge);
    var p = box(w, 0.1, d, GCOL.path);
    p.position.set(cx, 0.06, cz);
    scene.add(p);
  }

  function gFence(parent, x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) return;
    var n = Math.max(1, Math.round(len / 2.4));
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var post = box(0.22, 1.1, 0.22, GCOL.fenceDk);
      post.position.set(x1 + dx * t, 0.55, z1 + dz * t);
      parent.add(post);
    }
    [0.45, 0.85].forEach(function (h) {
      var rail = box(0.12, 0.16, len, GCOL.fence);
      rail.position.set((x1 + x2) / 2, h, (z1 + z2) / 2);
      rail.rotation.y = Math.atan2(dx, dz);
      parent.add(rail);
    });
  }

  function gAwning(width, depth, slats) {
    var g = new THREE.Group();
    var sw = width / slats;
    for (var i = 0; i < slats; i++) {
      var col = (i % 2 === 0) ? GCOL.awningA : GCOL.awningB;
      var slat = box(sw * 0.98, 0.25, depth, col);
      slat.position.set(-width / 2 + sw * (i + 0.5), 0, 0);
      g.add(slat);
      var tip = box(sw * 0.98, 0.5, 0.3, col);
      tip.position.set(-width / 2 + sw * (i + 0.5), -0.28, depth / 2);
      g.add(tip);
    }
    g.rotation.x = -0.32;
    return g;
  }

  function buildShopFacade(midX) {
    var g = new THREE.Group();
    var backZ = WORLD.minZ - 0.2;
    var wall = box(WORLD.maxX - WORLD.minX + 3, 2.6, 0.5, 0xfbf3e4);
    wall.position.set(midX, 1.3, backZ);
    g.add(wall);
    var trim = box(WORLD.maxX - WORLD.minX + 3.4, 0.4, 0.7, GCOL.woodDk);
    trim.position.set(midX, 2.6, backZ);
    g.add(trim);
    var awning = gAwning(WORLD.maxX - WORLD.minX + 2, 3.2, 12);
    awning.position.set(midX, 2.7, backZ + 1.6);
    g.add(awning);
    var boardFrame = box(9.4, 1.7, 0.18, GCOL.woodDk);
    boardFrame.position.set(midX, 3.7, backZ - 0.02);
    g.add(boardFrame);
    var board = box(9, 1.4, 0.3, GCOL.signWood);
    board.position.set(midX, 3.7, backZ + 0.1);
    g.add(board);
    [-2.6, 0, 2.6].forEach(function (ox, i) {
      var c = [0xe23b3b, 0x8d55d9, 0xffd84a][i];
      var fr = sphere(0.42, c, 12);
      fr.position.set(midX + ox, 3.7, backZ + 0.3);
      g.add(fr);
    });
    scene.add(g);
  }

  function buildDecor() {
    var g = new THREE.Group();
    [[-18, 12.5], [18, 12.5], [18, -2], [-18, 7], [14, 12], [-14, 13]]
      .forEach(function (p) { g.add(gTree(p[0], p[1])); });
    [[-15, -3, 0xe23b3b], [-15, -4.6, 0xffd84a], [12.5, -2.5, 0x8d55d9], [9.5, -2.6, 0xe23b3b]]
      .forEach(function (p) { g.add(gCrate(p[0], p[1], p[2])); });
    [[10, 3, 0xffd84a], [-10, 3, 0xe23b3b], [3.2, 12.5, 0x8d55d9]]
      .forEach(function (p) { g.add(gBasket(p[0], p[1], p[2])); });
    g.add(gLamp(WORLD.minX + 0.5, -4.5));
    g.add(gLamp(WORLD.minX + 0.5, 2.5));
    var seed = 7;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (var i = 0; i < 20; i++) {
      var x = WORLD.minX - 3 + rnd() * (WORLD.maxX - WORLD.minX + 6);
      var z = WORLD.minZ - 3 + rnd() * (WORLD.maxZ - WORLD.minZ + 6);
      if (x > WORLD.minX + 1 && x < WORLD.maxX - 1 && z > WORLD.minZ + 1 && z < WORLD.maxZ - 1) continue;
      g.add(gFlower(x, z, [0xff5d8f, 0xffd23b, 0xff8a3b, 0xffffff][i % 4]));
    }
    scene.add(g);
  }

  function gTree(x, z) {
    var g = new THREE.Group();
    var trunk = cyl(0.32, 0.42, 1.6, GCOL.woodDk, 7);
    trunk.position.y = 0.8;
    g.add(trunk);
    var c1 = sphere(1.5, GCOL.leaf, 10); c1.position.y = 2.5; c1.scale.set(1, 0.9, 1); g.add(c1);
    var c2 = sphere(1.1, GCOL.leafDk, 10); c2.position.set(0.7, 2.0, 0.4); g.add(c2);
    var c3 = sphere(1.05, GCOL.leaf, 10); c3.position.set(-0.7, 2.2, -0.3); g.add(c3);
    [[0.6, 2.6, 0.8], [-0.5, 2.1, 0.9], [0.2, 3.1, -0.4]].forEach(function (p) {
      var a = sphere(0.18, 0xe23b3b, 8);
      a.position.set(p[0], p[1], p[2]);
      g.add(a);
    });
    g.position.set(x, 0, z);
    g.scale.setScalar(0.9);
    return g;
  }

  function gCrate(x, z, fruitColor) {
    var g = new THREE.Group();
    var crate = box(1.5, 0.9, 1.1, GCOL.wood); crate.position.y = 0.45; g.add(crate);
    var rim = box(1.6, 0.18, 1.2, GCOL.woodDk); rim.position.y = 0.92; g.add(rim);
    [[-0.35, 0, -0.25], [0.35, 0, -0.25], [-0.35, 0, 0.25], [0.35, 0, 0.25], [0, 0.18, 0]].forEach(function (o) {
      var fr = sphere(0.32, fruitColor, 10);
      fr.position.set(o[0], 1.15 + o[1], o[2]);
      g.add(fr);
    });
    g.position.set(x, 0, z);
    return g;
  }

  function gBasket(x, z, fruitColor) {
    var g = new THREE.Group();
    var b = cyl(0.7, 0.55, 0.7, GCOL.fence, 12);
    b.position.y = 0.35;
    g.add(b);
    [[-0.25, 0, 0], [0.25, 0, 0], [0, 0, 0.25], [0, 0.18, 0]].forEach(function (o) {
      var fr = sphere(0.28, fruitColor, 10);
      fr.position.set(o[0], 0.78 + o[1], o[2]);
      g.add(fr);
    });
    g.position.set(x, 0, z);
    return g;
  }

  function gLamp(x, z) {
    var g = new THREE.Group();
    var pole = cyl(0.1, 0.12, 3.2, GCOL.woodDk, 6);
    pole.position.y = 1.6;
    g.add(pole);
    var head = box(0.5, 0.5, 0.5, 0xfff3b0);
    head.position.y = 3.2;
    g.add(head);
    g.position.set(x, 0, z);
    return g;
  }

  function gFlower(x, z, color) {
    var g = new THREE.Group();
    var stem = box(0.06, 0.4, 0.06, GCOL.leafDk);
    stem.position.y = 0.2;
    g.add(stem);
    var head = sphere(0.16, color, 8);
    head.position.y = 0.42;
    g.add(head);
    g.position.set(x, 0, z);
    return g;
  }

  function buildDistrictSigns() {
    function mk(text) {
      var el = document.createElement('div');
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);' +
        'font-size:17px;font-weight:800;color:#fff;white-space:nowrap;letter-spacing:1px;' +
        'pointer-events:none;text-shadow:0 2px 4px rgba(0,0,0,.55),0 0 2px rgba(0,0,0,.5);';
      el.innerHTML = text;
      floatLayer.appendChild(el);
      return el;
    }
    districtSigns = [
      { el: mk('FRUIT SHOP'), x: 0, y: 5.6, z: WORLD.minZ + 0.2 },
      { el: mk('FARM'), x: 0, y: 3.0, z: WORLD.maxZ - 1.5 }
    ];
  }

  // ---- player ------------------------------------------------------------
  function buildPlayer() {
    var g = new THREE.Group();
    var main = 0xc875ff;
    var light = 0xf0c8ff;
    var dark = 0x8c4bd6;

    var hips = sphere(0.55, main, 20); hips.position.y = 0.92; hips.scale.set(0.95, 0.82, 0.78); g.add(hips);
    var chest = sphere(0.62, main, 20); chest.position.y = 1.32; chest.scale.set(0.9, 1.12, 0.7); g.add(chest);
    var belly = sphere(0.45, light, 16); belly.position.set(0, 1.08, 0.18); belly.scale.set(0.8, 0.65, 0.35); g.add(belly);

    var head = sphere(0.55, light, 24); head.position.y = 2.08; g.add(head);
    var neck = cyl(0.26, 0.28, 0.3, main, 16); neck.position.y = 1.65; g.add(neck);

    var a1 = cyl(0.16, 0.14, 0.82, main, 16); a1.position.set(-0.62, 1.28, 0); a1.rotation.z = -0.42; g.add(a1);
    var a2 = cyl(0.16, 0.14, 0.82, main, 16); a2.position.set(0.62, 1.28, 0); a2.rotation.z = 0.42; g.add(a2);
    var h1 = sphere(0.18, light, 16); h1.position.set(-0.83, 0.86, 0.03); g.add(h1);
    var h2 = sphere(0.18, light, 16); h2.position.set(0.83, 0.86, 0.03); g.add(h2);

    var l1 = cyl(0.19, 0.18, 0.72, dark, 16); l1.position.set(-0.25, 0.44, 0); g.add(l1);
    var l2 = cyl(0.19, 0.18, 0.72, dark, 16); l2.position.set(0.25, 0.44, 0); g.add(l2);
    var f1 = sphere(0.24, light, 16); f1.position.set(-0.25, 0.08, 0.16); f1.scale.set(1.15, 0.65, 1.45); g.add(f1);
    var f2 = sphere(0.24, light, 16); f2.position.set(0.25, 0.08, 0.16); f2.scale.set(1.15, 0.65, 1.45); g.add(f2);
    g.userData.legs = [l1, l2];
    g.userData.arms = [a1, a2];
    g.userData.feet = [f1, f2];
    g.userData.bodyParts = [hips, chest, belly, head, neck];
    return g;
  }

  function buildCarryStack(type, count) {
    while (carryGroup.children.length) carryGroup.remove(carryGroup.children[0]);
    if (!type || count <= 0) return;
    var n = Math.min(count, 10);
    for (var i = 0; i < n; i++) {
      var item = fruitMesh(type, 0.9);
      item.position.set((i % 2 ? 0.18 : -0.18), 2.48 + i * 0.2, 0.08);
      carryGroup.add(item);
    }
  }

  // ---- shelves -----------------------------------------------------------
  function buildShelf(s) {
    var g = new THREE.Group();
    g.position.set(s.x, 0, s.z);

    var frameColor = 0xd7c09a;
    // Single wide angled produce table. It keeps all 20 items visible at a
    // readable size instead of shrinking them across several tiers.
    var base = box(3.8, 0.45, 1.9, frameColor); base.position.y = 0.23; g.add(base);
    var table = box(3.65, 0.16, 1.85, 0xf0dfb9); table.position.y = 0.82; table.rotation.x = -0.18; g.add(table);
    var frontLip = box(3.9, 0.24, 0.16, 0xb98b54); frontLip.position.set(0, 0.95, 0.92); g.add(frontLip);
    var backLip = box(3.9, 0.28, 0.16, 0xb98b54); backLip.position.set(0, 1.2, -0.92); g.add(backLip);
    var sideL = box(0.16, 0.28, 1.9, 0xb98b54); sideL.position.set(-1.95, 1.06, 0); g.add(sideL);
    var sideR = box(0.16, 0.28, 1.9, 0xb98b54); sideR.position.set(1.95, 1.06, 0); g.add(sideR);

    // 20 visible product slots: one fruit image equals one shelf stock.
    var fillBars = [];
    var pc = colorHex(s.productType);
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 5; col++) {
        var item = fruitMesh(s.productType, 0.74);
        item.position.set(-1.35 + col * 0.68, 1.02 + row * 0.09, 0.58 - row * 0.38);
        item.visible = false;
        g.add(item);
        fillBars.push(item);
      }
    }

    // hanging sign with product colour
    var sign = box(1.8, 0.48, 0.1, pc); sign.position.set(0, 2.2, -0.72); g.add(sign);
    var post = box(0.1, 0.9, 0.1, 0x6b7178); post.position.set(0, 1.78, -0.72); g.add(post);

    // structural meshes we dim to a "ghost" when the shelf is locked
    var frame = [base, table, frontLip, backLip, sideL, sideR, sign, post];

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

    var crate = fruitCrateMesh(s.productType, 0.72);
    crate.position.set(0.82, 1.18, 0.82);
    g.add(crate);

    // sign post showing the crop colour
    var sign = box(0.9, 0.6, 0.1, colorHex(s.productType));
    sign.position.set(0, 2.0, -1.0); g.add(sign);
    var post = box(0.12, 2.0, 0.12, 0x6b4a2c); post.position.set(0, 1.0, -1.0); g.add(post);

    // crop plants (3x3 grid). Each slot uses a recognizable fruit shape.
    var crops = [];
    for (var ix = 0; ix < 3; ix++) {
      for (var iz = 0; iz < 3; iz++) {
        var stalk = new THREE.Group();
        var stem = box(0.08, 0.34, 0.08, 0x2f7d32); stem.position.y = 0.18; stalk.add(stem);
        var leaves = sphere(0.18, 0x3aa655, 8); leaves.position.y = 0.42; leaves.scale.set(1.4, 0.35, 1.0); stalk.add(leaves);
        var fruit = fruitMesh(s.productType, 0.82);
        fruit.position.y = 0.7;
        stalk.add(fruit);
        stalk.position.set(-0.75 + ix * 0.75, 0.5, -0.75 + iz * 0.75);
        g.add(stalk);
        crops.push(stalk);
      }
    }

    scene.add(g);
    sourceMeshes[s.id] = { group: g, crops: crops, crate: crate };
  }

  function syncSource(s) {
    var m = sourceMeshes[s.id];
    if (!m) { buildSource(s); m = sourceMeshes[s.id]; }
    // Show crops proportional to stock; the "next" one scales with growth.
    var full = Math.floor((s.stock / 14) * m.crops.length);
    m.crate.visible = s.stock > 0;
    m.crate.scale.setScalar(0.75 + Math.min(1, s.stock / 14) * 0.25);
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
    // A hired cashier appears only after the player pays the recruit pad.
    var cashier = new THREE.Group();
    cashier.position.set(-0.9, 0, 0);
    var body = sphere(0.38, 0x58c6a9, 16); body.position.y = 1.02; body.scale.set(0.85, 1.0, 0.62); cashier.add(body);
    var head = sphere(0.32, 0xf2ccff, 16); head.position.y = 1.58; cashier.add(head);
    var arm1 = cyl(0.08, 0.07, 0.46, 0x58c6a9, 10); arm1.position.set(-0.33, 1.02, 0.16); arm1.rotation.z = -0.4; cashier.add(arm1);
    var arm2 = cyl(0.08, 0.07, 0.46, 0x58c6a9, 10); arm2.position.set(0.33, 1.02, 0.16); arm2.rotation.z = 0.4; cashier.add(arm2);
    cashier.visible = !!c.cashierHired;
    g.add(cashier);
    g.userData.cashier = cashier;
    scene.add(g);
    checkoutMeshes[c.id] = g;
  }
  function syncCheckout(c) {
    if (!checkoutMeshes[c.id]) buildCheckout(c);
    var g = checkoutMeshes[c.id];
    if (g.userData.cashier) g.userData.cashier.visible = !!c.cashierHired;
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
    var body = sphere(0.48, 0xcf73ff, 18); body.position.y = 0.92; body.scale.set(0.85, 1.18, 0.7); g.add(body);
    var head = sphere(0.42, 0xf2ccff, 18); head.position.y = 1.68; g.add(head);
    var a1 = cyl(0.12, 0.1, 0.6, 0xcf73ff, 12); a1.position.set(-0.46, 1.0, 0); a1.rotation.z = -0.35; g.add(a1);
    var a2 = cyl(0.12, 0.1, 0.6, 0xcf73ff, 12); a2.position.set(0.46, 1.0, 0); a2.rotation.z = 0.35; g.add(a2);
    var l1 = cyl(0.14, 0.13, 0.55, 0x8652cc, 12); l1.position.set(-0.18, 0.34, 0); g.add(l1);
    var l2 = cyl(0.14, 0.13, 0.55, 0x8652cc, 12); l2.position.set(0.18, 0.34, 0); g.add(l2);
    var f1 = sphere(0.17, 0xf2ccff, 12); f1.position.set(-0.18, 0.06, 0.12); f1.scale.set(1.05, 0.6, 1.3); g.add(f1);
    var f2 = sphere(0.17, 0xf2ccff, 12); f2.position.set(0.18, 0.06, 0.12); f2.scale.set(1.05, 0.6, 1.3); g.add(f2);
    var item = box(0.5, 0.5, 0.5, 0xffffff); item.position.set(0, 2.12, 0); item.visible = false;
    g.add(item);
    g.userData.item = item;
    g.userData.body = body;
    g.userData.tintMeshes = [body, a1, a2];
    g.userData.legMeshes = [l1, l2];
    g.userData.legs = [l1, l2];
    g.userData.arms = [a1, a2];
    g.userData.feet = [f1, f2];
    g.userData.bodyParts = [body, head];
    scene.add(g);
    return g;
  }
  function customerColor(idx) {
    var palette = [0xcf73ff, 0xe16cff, 0xb66dff, 0xf070c8, 0xc45dff, 0xda8cff];
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
        if (m.userData.tintMeshes) {
          var tint = customerColor(i + c.id.length);
          for (var ti = 0; ti < m.userData.tintMeshes.length; ti++) {
            m.userData.tintMeshes[ti].material.color.setHex(tint);
          }
        }
        customerMap[c.id] = m;
      }
      m.position.set(c.x, 0, c.z);
      m.rotation.y = c.angle;
      animateHumanoid(m, c.x, c.z, 0.85, 0.85);
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

  function animateHumanoid(g, x, z, stride, bounce) {
    var ud = g.userData || {};
    var hasPrev = typeof ud.prevX === 'number' && typeof ud.prevZ === 'number';
    var moved = hasPrev ? Math.sqrt(Math.pow(x - ud.prevX, 2) + Math.pow(z - ud.prevZ, 2)) : 0;
    ud.prevX = x;
    ud.prevZ = z;
    var walking = moved > 0.012;
    var phase = legPhase * (walking ? 1.45 : 0.42);
    var s = Math.sin(phase);
    var c = Math.cos(phase);
    var stepA = Math.max(0, s);
    var stepB = Math.max(0, -s);
    var swing = walking ? s : s * 0.08;
    var lift = walking ? Math.abs(s) : 0;

    g.position.y = walking ? 0.06 + lift * 0.11 * bounce : 0;
    g.rotation.x = walking ? -0.08 * stride + c * 0.025 : 0;
    g.rotation.z = walking ? s * 0.045 : 0;

    var legs = ud.legs || ud.legMeshes;
    if (legs) {
      if (ud.legBaseY0 == null) { ud.legBaseY0 = legs[0].position.y; ud.legBaseY1 = legs[1].position.y; }
      legs[0].rotation.x = swing * 0.82 * stride;
      legs[1].rotation.x = -swing * 0.82 * stride;
      legs[0].position.y = ud.legBaseY0 + stepA * 0.1 * bounce;
      legs[1].position.y = ud.legBaseY1 + stepB * 0.1 * bounce;
    }
    if (ud.arms) {
      if (ud.armBaseZ0 == null) { ud.armBaseZ0 = ud.arms[0].rotation.z; ud.armBaseZ1 = ud.arms[1].rotation.z; }
      ud.arms[0].rotation.x = -swing * 0.62 * stride;
      ud.arms[1].rotation.x = swing * 0.62 * stride;
      ud.arms[0].rotation.z = ud.armBaseZ0 + (walking ? c * 0.08 : 0);
      ud.arms[1].rotation.z = ud.armBaseZ1 - (walking ? c * 0.08 : 0);
    }
    if (ud.feet) {
      if (ud.footBaseY0 == null) {
        ud.footBaseY0 = ud.feet[0].position.y; ud.footBaseY1 = ud.feet[1].position.y;
        ud.footBaseZ0 = ud.feet[0].position.z; ud.footBaseZ1 = ud.feet[1].position.z;
      }
      ud.feet[0].rotation.x = stepA * 0.75 - stepB * 0.18;
      ud.feet[1].rotation.x = stepB * 0.75 - stepA * 0.18;
      ud.feet[0].position.y = ud.footBaseY0 + stepA * 0.09 * bounce;
      ud.feet[1].position.y = ud.footBaseY1 + stepB * 0.09 * bounce;
      ud.feet[0].position.z = ud.footBaseZ0 + s * 0.16 * stride;
      ud.feet[1].position.z = ud.footBaseZ1 - s * 0.16 * stride;
    }
    if (ud.bodyParts) {
      if (ud.bodyBaseY == null) {
        ud.bodyBaseY = [];
        for (var bi = 0; bi < ud.bodyParts.length; bi++) ud.bodyBaseY[bi] = ud.bodyParts[bi].position.y;
      }
      for (var bj = 0; bj < ud.bodyParts.length; bj++) {
        ud.bodyParts[bj].position.y = ud.bodyBaseY[bj] + (walking ? lift * 0.025 * bounce : Math.sin(phase) * 0.006);
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
    legPhase += dt * 10;
    animateHumanoid(playerGroup, st.player.x, st.player.z, 1.15, 1.15);

    // entities
    st.shelves.forEach(syncShelf);
    st.sources.forEach(syncSource);
    st.checkouts.forEach(syncCheckout);
    st.pads.forEach(syncPad);
    syncCustomers(st.customers);
    syncFloats(st.floats);

    for (var dsI = 0; dsI < districtSigns.length; dsI++) {
      projectLabel(districtSigns[dsI].el, districtSigns[dsI].x, districtSigns[dsI].y, districtSigns[dsI].z, null);
    }

    // tutorial beacon
    if (st.tutorialTarget) {
      tutorialBeacon.visible = true;
      tutorialBeacon.position.set(st.tutorialTarget.x, 0, st.tutorialTarget.z);
      tutorialBeacon.children[0].position.y = 3.2 + Math.sin(legPhase * 0.6) * 0.25;
    } else {
      tutorialBeacon.visible = false;
    }

    // camera follow (smooth) — angled top-down
    camTarget.lerp(new THREE.Vector3(st.player.x, 0, st.player.z), 0.12);
    camera.position.lerp(
      new THREE.Vector3(camTarget.x, 24, camTarget.z + 20), 0.1);
    camera.lookAt(camTarget.x, 0, camTarget.z);

    renderer.render(scene, camera);

    // HUD
    if (window.HUD) window.HUD.update(st);
  }

  window.Render3D = { init: init };
})();

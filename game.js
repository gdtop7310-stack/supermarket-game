/* =========================================================================
 * game.js — Supermarket idle-tycoon game logic.
 *
 * Pure logic, no rendering, no DOM. Publishes `window.Game`.
 * The renderer (render3d.js) reads Game.getState() every frame and syncs.
 *
 * Contract (do not break — render3d.js depends on it):
 *   window.Game = {
 *     WORLD, start(), update(dt), setMove(mx,mz), setMoveTarget(x,z),
 *     getState(), onMoney(cb), onUnlock(cb)
 *   }
 *
 * Coordinate convention:
 *   store area  = z < 0
 *   farm area   = z > 0
 *   entrance    = x near WORLD.minX
 * ========================================================================= */
(function () {
  'use strict';

  var WORLD = { minX: -20, maxX: 20, minZ: -14, maxZ: 14 };

  // --- Product catalogue --------------------------------------------------
  // Each product has a price (what a customer pays) and a colour hint that the
  // renderer may use. Keeping it here keeps logic the single source of truth.
  var PRODUCTS = {
    apple:  { price: 3,  color: 0xe23b3b },
    carrot: { price: 4,  color: 0xe8902e },
    milk:   { price: 6,  color: 0xf2f2f7 },
    bread:  { price: 8,  color: 0xc8923f },
    grape:  { price: 11, color: 0x7d4fc4 }
  };

  // --- Tunables -----------------------------------------------------------
  var PLAYER_SPEED      = 9.0;   // units / sec
  var CUSTOMER_SPEED    = 4.2;
  var REACH             = 2.2;   // interaction distance
  var HARVEST_INTERVAL  = 0.16;  // sec between picking 1 item from a source
  var REFILL_INTERVAL   = 0.12;  // sec between dropping 1 item to a shelf
  var GROW_RATE         = 0.55;  // growth units / sec (0..1 fills then +1 stock)
  var SOURCE_MAX_STOCK  = 14;
  var SHELF_BUY_INTERVAL= 0.5;   // sec a customer spends grabbing 1 item
  var CHECKOUT_TIME     = 0.9;   // sec to process one customer at checkout
  var CUSTOMER_SPAWN    = 2.4;   // base sec between customer spawns
  var PAD_PAY_RATE      = 90;    // $ / sec drained while standing on a pad

  // ------------------------------------------------------------------------
  var state = null;
  var moneyCbs = [];
  var unlockCbs = [];

  var _ids = 0;
  function nid(p) { _ids += 1; return (p || 'e') + _ids; }

  function dist2(ax, az, bx, bz) {
    var dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function addFloat(x, y, z, text, color) {
    state.floats.push({ x: x, y: y, z: z, text: text, color: color, life: 1.1 });
  }

  // --- World construction -------------------------------------------------
  function buildWorld() {
    state = {
      running: false,
      money: 50,
      carryCap: 6,
      player: { x: WORLD.minX + 2, z: -2, angle: 0, carryType: null, carryCount: 0 },
      sources: [],
      shelves: [],
      checkouts: [],
      customers: [],
      pads: [],
      floats: [],
      tutorialTarget: null,
      // private timers (not part of the public contract but harmless to expose)
      _spawnT: 1.5,
      _harvestT: 0,
      _refillT: 0
    };

    // Checkouts near the entrance (store side, z<0).
    state.checkouts.push(mkCheckout(WORLD.minX + 4, -8));
    state.checkouts.push(mkCheckout(WORLD.minX + 4, -11.5));

    // Shelves: rows in the store (z<0). Some locked behind upgrade pads.
    // layout: two rows.
    var shelfDefs = [
      { x: -6,  z: -5,  type: 'apple',  locked: false },
      { x: 0,   z: -5,  type: 'carrot', locked: false },
      { x: 6,   z: -5,  type: 'milk',   locked: false },
      { x: -6,  z: -10, type: 'bread',  locked: true  },
      { x: 0,   z: -10, type: 'grape',  locked: true  },
      { x: 6,   z: -10, type: 'apple',  locked: true  }
    ];
    shelfDefs.forEach(function (d) {
      state.shelves.push({
        id: nid('shelf'), x: d.x, z: d.z, productType: d.type,
        amount: 0, capacity: 16, locked: d.locked
      });
    });

    // Sources: farm plots in the farm area (z>0). Same products as shelves.
    var srcDefs = [
      { x: -6,  z: 5,  type: 'apple'  },
      { x: 0,   z: 5,  type: 'carrot' },
      { x: 6,   z: 5,  type: 'milk'   },
      { x: -6,  z: 10, type: 'bread'  },
      { x: 0,   z: 10, type: 'grape'  }
    ];
    srcDefs.forEach(function (d) {
      state.sources.push({
        id: nid('src'), x: d.x, z: d.z, productType: d.type,
        stock: 4, growth: 0
      });
    });

    // Upgrade pads. `kind` tells the logic what to do when fully paid.
    state.pads = [
      mkPad(-6, -10, 'unlockShelf', 60,  'Bread Shelf',  { shelfIndex: 3 }),
      mkPad(0,  -10, 'unlockShelf', 120, 'Grape Shelf',  { shelfIndex: 4 }),
      mkPad(6,  -10, 'unlockShelf', 200, 'Apple Shelf 2',{ shelfIndex: 5 }),
      mkPad(WORLD.minX + 2, 2, 'carryCap', 80, 'Carry +4', { amount: 4 }),
      mkPad(12, -7, 'checkout', 260, 'New Checkout', { x: WORLD.minX + 4, z: -3 })
    ];

    return state;
  }

  function mkCheckout(x, z) {
    return { id: nid('co'), x: x, z: z, queueLen: 0,
             _queue: [], _busyT: 0 };
  }
  function mkPad(x, z, kind, cost, label, data) {
    return { id: nid('pad'), x: x, z: z, kind: kind, cost: cost,
             paid: 0, label: label, _data: data, _done: false };
  }

  // --- Public: movement ---------------------------------------------------
  function setMove(mx, mz) {
    if (!state) return;
    state.player._mx = mx;
    state.player._mz = mz;
    if (Math.abs(mx || 0) > 1e-3 || Math.abs(mz || 0) > 1e-3) {
      state.player._target = null;
    }
  }

  function setMoveTarget(x, z) {
    if (!state) return;
    state.player._target = {
      x: clamp(x, WORLD.minX + 1, WORLD.maxX - 1),
      z: clamp(z, WORLD.minZ + 1, WORLD.maxZ - 1)
    };
  }

  // --- Update sub-systems -------------------------------------------------
  function updatePlayer(dt) {
    var p = state.player;
    var mx = p._mx || 0, mz = p._mz || 0;
    if (p._target && Math.abs(mx) < 1e-3 && Math.abs(mz) < 1e-3) {
      var dx = p._target.x - p.x;
      var dz = p._target.z - p.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < 0.15) {
        p._target = null;
        return;
      }
      mx = dx / d;
      mz = dz / d;
    }
    var len = Math.sqrt(mx * mx + mz * mz);
    if (len > 1e-3) {
      mx /= len; mz /= len;
      var step = PLAYER_SPEED * dt;
      if (p._target) {
        var tx = p._target.x - p.x;
        var tz = p._target.z - p.z;
        var td = Math.sqrt(tx * tx + tz * tz);
        if (step >= td) {
          p.x = p._target.x;
          p.z = p._target.z;
          p._target = null;
        } else {
          p.x = clamp(p.x + mx * step, WORLD.minX + 1, WORLD.maxX - 1);
          p.z = clamp(p.z + mz * step, WORLD.minZ + 1, WORLD.maxZ - 1);
        }
      } else {
        p.x = clamp(p.x + mx * step, WORLD.minX + 1, WORLD.maxX - 1);
        p.z = clamp(p.z + mz * step, WORLD.minZ + 1, WORLD.maxZ - 1);
      }
      p.angle = Math.atan2(mx, mz);
    }
  }

  function updateSources(dt) {
    for (var i = 0; i < state.sources.length; i++) {
      var s = state.sources[i];
      if (s.stock < SOURCE_MAX_STOCK) {
        s.growth += GROW_RATE * dt;
        while (s.growth >= 1 && s.stock < SOURCE_MAX_STOCK) {
          s.growth -= 1;
          s.stock += 1;
        }
        if (s.stock >= SOURCE_MAX_STOCK) s.growth = 0;
      }
    }
  }

  // Player auto-harvests from the nearest in-range source.
  function updateHarvest(dt) {
    var p = state.player;
    if (p.carryCount >= state.carryCap) return;
    state._harvestT -= dt;
    if (state._harvestT > 0) return;

    var best = null, bd = REACH * REACH;
    for (var i = 0; i < state.sources.length; i++) {
      var s = state.sources[i];
      if (s.stock <= 0) continue;
      if (p.carryType && p.carryType !== s.productType) continue;
      var d = dist2(p.x, p.z, s.x, s.z);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      best.stock -= 1;
      p.carryType = best.productType;
      p.carryCount += 1;
      state._harvestT = HARVEST_INTERVAL;
      addFloat(best.x, 1.4, best.z, '+1', '#fff7cc');
    }
  }

  // Player auto-refills the nearest in-range matching shelf.
  function updateRefill(dt) {
    var p = state.player;
    if (p.carryCount <= 0 || !p.carryType) return;
    state._refillT -= dt;
    if (state._refillT > 0) return;

    var best = null, bd = REACH * REACH;
    for (var i = 0; i < state.shelves.length; i++) {
      var sh = state.shelves[i];
      if (sh.locked) continue;
      if (sh.productType !== p.carryType) continue;
      if (sh.amount >= sh.capacity) continue;
      var d = dist2(p.x, p.z, sh.x, sh.z);
      if (d < bd) { bd = d; best = sh; }
    }
    if (best) {
      best.amount += 1;
      p.carryCount -= 1;
      if (p.carryCount <= 0) p.carryType = null;
      state._refillT = REFILL_INTERVAL;
      addFloat(best.x, 1.6, best.z, '+1', '#cdefff');
    }
  }

  // Upgrade pads: drain money while the player stands on them.
  function updatePads(dt) {
    var p = state.player;
    for (var i = 0; i < state.pads.length; i++) {
      var pad = state.pads[i];
      if (pad._done) continue;
      if (dist2(p.x, p.z, pad.x, pad.z) > REACH * REACH) continue;

      var need = pad.cost - pad.paid;
      if (need <= 0) continue;
      var pay = Math.min(need, Math.min(state.money, PAD_PAY_RATE * dt));
      // ensure progress even with tiny dt / low money by allowing $1 steps
      if (pay < 1 && state.money >= 1 && need >= 1) pay = 1 * Math.min(1, dt * 8);
      if (pay <= 0) continue;

      state.money -= pay;
      pad.paid += pay;
      emitMoney();
      if (pad.paid >= pad.cost - 1e-6) {
        pad.paid = pad.cost;
        pad._done = true;
        applyPad(pad);
        addFloat(pad.x, 1.8, pad.z, 'UNLOCKED!', '#9cff9c');
      }
    }
  }

  function applyPad(pad) {
    var d = pad._data;
    if (pad.kind === 'unlockShelf') {
      var sh = state.shelves[d.shelfIndex];
      if (sh) sh.locked = false;
      emitUnlock({ type: 'shelf', id: sh ? sh.id : null, label: pad.label });
    } else if (pad.kind === 'carryCap') {
      state.carryCap += d.amount;
      emitUnlock({ type: 'carryCap', value: state.carryCap, label: pad.label });
    } else if (pad.kind === 'checkout') {
      state.checkouts.push(mkCheckout(d.x, d.z));
      emitUnlock({ type: 'checkout', label: pad.label });
    }
  }

  // --- Customers ----------------------------------------------------------
  function unlockedShelvesWithStock() {
    var out = [];
    for (var i = 0; i < state.shelves.length; i++) {
      var sh = state.shelves[i];
      if (!sh.locked && sh.amount > 0) out.push(sh);
    }
    return out;
  }

  function spawnCustomer() {
    var shelves = unlockedShelvesWithStock();
    if (shelves.length === 0) return; // nothing to buy yet
    var target = shelves[(_ids + state.customers.length) % shelves.length];
    state.customers.push({
      id: nid('cust'),
      x: WORLD.minX + 1, z: -1,
      angle: 0, state: 'toShelf',
      carryType: null,
      _target: target.id,
      _t: 0
    });
  }

  function moveToward(c, tx, tz, dt) {
    var dx = tx - c.x, dz = tz - c.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.05) return true;
    var step = CUSTOMER_SPEED * dt;
    if (step >= d) { c.x = tx; c.z = tz; return true; }
    c.x += dx / d * step;
    c.z += dz / d * step;
    c.angle = Math.atan2(dx, dz);
    return false;
  }

  function findShelf(id) {
    for (var i = 0; i < state.shelves.length; i++)
      if (state.shelves[i].id === id) return state.shelves[i];
    return null;
  }
  function shortestCheckout() {
    var best = null, bq = Infinity;
    for (var i = 0; i < state.checkouts.length; i++) {
      var c = state.checkouts[i];
      if (c.queueLen < bq) { bq = c.queueLen; best = c; }
    }
    return best;
  }
  function findCheckout(id) {
    for (var i = 0; i < state.checkouts.length; i++)
      if (state.checkouts[i].id === id) return state.checkouts[i];
    return null;
  }

  function updateCustomers(dt) {
    var alive = [];
    for (var i = 0; i < state.customers.length; i++) {
      var c = state.customers[i];
      var keep = stepCustomer(c, dt);
      if (keep) alive.push(c);
    }
    state.customers = alive;

    // Process checkout queues.
    for (var k = 0; k < state.checkouts.length; k++) {
      var co = state.checkouts[k];
      co.queueLen = co._queue.length;
      if (co._queue.length > 0) {
        co._busyT -= dt;
        if (co._busyT <= 0) {
          var done = co._queue.shift();
          if (done) {
            var prod = PRODUCTS[done.carryType];
            var price = prod ? prod.price : 2;
            state.money += price;
            emitMoney();
            addFloat(co.x, 1.6, co.z, '+$' + price, '#9cff9c');
            done.state = 'leaving';
          }
          co._busyT = CHECKOUT_TIME;
          co.queueLen = co._queue.length;
        }
      } else {
        co._busyT = CHECKOUT_TIME;
      }
    }
  }

  function stepCustomer(c, dt) {
    if (c.state === 'toShelf') {
      var sh = findShelf(c._target);
      if (!sh || sh.locked || (sh.amount <= 0 && c.carryType == null)) {
        // target gone; re-pick or leave
        var opts = unlockedShelvesWithStock();
        if (opts.length === 0) { c.state = 'leaving'; return true; }
        c._target = opts[0].id;
        return true;
      }
      if (moveToward(c, sh.x, sh.z + (c.z < sh.z ? -1.4 : 1.4), dt)) {
        c.state = 'shopping'; c._t = SHELF_BUY_INTERVAL;
      }
      return true;
    }

    if (c.state === 'shopping') {
      c._t -= dt;
      if (c._t <= 0) {
        var s2 = findShelf(c._target);
        if (s2 && s2.amount > 0) {
          s2.amount -= 1;
          c.carryType = s2.productType;
          addFloat(s2.x, 1.7, s2.z, '-1', '#ffd0d0');
          c.state = 'toCheckout';
          var co = shortestCheckout();
          c._co = co ? co.id : null;
          if (co) { co._queue.push(c); }
        } else {
          c.state = 'leaving';
        }
      }
      return true;
    }

    if (c.state === 'toCheckout') {
      var co2 = findCheckout(c._co);
      if (!co2) { c.state = 'leaving'; return true; }
      // queue position offset so customers line up
      var idx = co2._queue.indexOf(c);
      if (idx < 0) idx = 0;
      var qx = co2.x - 1.4 - idx * 1.3;
      moveToward(c, qx, co2.z, dt);
      // payment handled by checkout processing (state set to 'leaving')
      return true;
    }

    if (c.state === 'leaving') {
      if (moveToward(c, WORLD.minX + 1, -1, dt)) {
        return false; // despawn
      }
      return true;
    }

    return true;
  }

  function updateSpawns(dt) {
    state._spawnT -= dt;
    if (state._spawnT <= 0) {
      spawnCustomer();
      // spawn a touch faster as the store grows
      var openShelves = unlockedShelvesWithStock().length;
      state._spawnT = Math.max(0.9, CUSTOMER_SPAWN - openShelves * 0.18);
    }
  }

  // --- Floats fade --------------------------------------------------------
  function updateFloats(dt) {
    var alive = [];
    for (var i = 0; i < state.floats.length; i++) {
      var f = state.floats[i];
      f.life -= dt;
      f.y += dt * 1.1;
      if (f.life > 0) alive.push(f);
    }
    state.floats = alive;
  }

  // --- Tutorial guidance --------------------------------------------------
  function updateTutorial() {
    var p = state.player;
    // If carrying, point at a matching shelf that has room. Otherwise point at
    // the nearest source that has stock.
    if (p.carryCount > 0 && p.carryType) {
      var best = null, bd = Infinity;
      for (var i = 0; i < state.shelves.length; i++) {
        var sh = state.shelves[i];
        if (sh.locked || sh.productType !== p.carryType || sh.amount >= sh.capacity) continue;
        var d = dist2(p.x, p.z, sh.x, sh.z);
        if (d < bd) { bd = d; best = sh; }
      }
      state.tutorialTarget = best ? { x: best.x, z: best.z } : null;
      return;
    }
    var bestS = null, bs = Infinity;
    for (var j = 0; j < state.sources.length; j++) {
      var s = state.sources[j];
      if (s.stock <= 0) continue;
      var dd = dist2(p.x, p.z, s.x, s.z);
      if (dd < bs) { bs = dd; bestS = s; }
    }
    state.tutorialTarget = bestS ? { x: bestS.x, z: bestS.z } : null;
  }

  // --- Callbacks ----------------------------------------------------------
  function emitMoney() {
    for (var i = 0; i < moneyCbs.length; i++) moneyCbs[i](state.money);
  }
  function emitUnlock(info) {
    for (var i = 0; i < unlockCbs.length; i++) unlockCbs[i](info);
  }

  // --- Persistence (localStorage) ----------------------------------------
  var SAVE_KEY = 'supermarket-save-v1';
  var _saveT = 0;

  function hasStorage() {
    try { return typeof localStorage !== 'undefined' && localStorage; }
    catch (e) { return false; }
  }

  function saveGame() {
    if (!state || !hasStorage()) return;
    try {
      var snap = {
        money: state.money,
        carryCap: state.carryCap,
        shelves: state.shelves.map(function (s) {
          return { id: s.id, locked: s.locked, amount: s.amount };
        }),
        sources: state.sources.map(function (s) {
          return { id: s.id, stock: s.stock };
        }),
        pads: state.pads.map(function (p) {
          return { id: p.id, paid: p.paid, done: p._done };
        }),
        // persist any extra checkouts that were unlocked
        checkouts: state.checkouts.map(function (c) { return { x: c.x, z: c.z }; })
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(snap));
    } catch (e) { /* ignore quota / serialisation errors */ }
  }

  function loadGame() {
    if (!hasStorage()) return false;
    var raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return false; }
    if (!snap) return false;

    if (typeof snap.money === 'number') state.money = snap.money;
    if (typeof snap.carryCap === 'number') state.carryCap = snap.carryCap;

    function byId(arr, id) {
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
      return null;
    }
    (snap.shelves || []).forEach(function (ss) {
      var sh = byId(state.shelves, ss.id);
      if (sh) { sh.locked = ss.locked; sh.amount = ss.amount; }
    });
    (snap.sources || []).forEach(function (ss) {
      var s = byId(state.sources, ss.id);
      if (s) s.stock = ss.stock;
    });
    (snap.pads || []).forEach(function (ps) {
      var p = byId(state.pads, ps.id);
      if (p) { p.paid = ps.paid; if (ps.done) { p._done = true; } }
    });
    // Re-create extra checkouts beyond the two defaults.
    if (snap.checkouts && snap.checkouts.length > state.checkouts.length) {
      for (var i = state.checkouts.length; i < snap.checkouts.length; i++) {
        var c = snap.checkouts[i];
        state.checkouts.push(mkCheckout(c.x, c.z));
      }
    }
    return true;
  }

  function resetSave() {
    if (hasStorage()) { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  }

  // --- Public API ---------------------------------------------------------
  function start() {
    buildWorld();
    loadGame();
    state.running = true;
    emitMoney();
    return state;
  }

  function update(dt) {
    if (!state || !state.running) return;
    // clamp dt to avoid tunnelling on tab-switch / long frames
    if (dt > 0.1) dt = 0.1;
    updatePlayer(dt);
    updateSources(dt);
    updateHarvest(dt);
    updateRefill(dt);
    updatePads(dt);
    updateSpawns(dt);
    updateCustomers(dt);
    updateFloats(dt);
    updateTutorial();

    // autosave every few seconds
    _saveT -= dt;
    if (_saveT <= 0) { saveGame(); _saveT = 4; }
  }

  // Return a snapshot matching the documented contract. We strip private
  // fields (those prefixed with `_`) so the renderer only sees the contract.
  function getState() {
    if (!state) return null;
    return {
      running: state.running,
      money: Math.floor(state.money),
      carryCap: state.carryCap,
      player: {
        x: state.player.x, z: state.player.z, angle: state.player.angle,
        carryType: state.player.carryType, carryCount: state.player.carryCount
      },
      sources: state.sources.map(function (s) {
        return { id: s.id, x: s.x, z: s.z, productType: s.productType,
                 stock: s.stock, growth: s.growth };
      }),
      shelves: state.shelves.map(function (s) {
        return { id: s.id, x: s.x, z: s.z, productType: s.productType,
                 amount: s.amount, capacity: s.capacity, locked: s.locked };
      }),
      checkouts: state.checkouts.map(function (c) {
        return { id: c.id, x: c.x, z: c.z, queueLen: c.queueLen };
      }),
      customers: state.customers.map(function (c) {
        return { id: c.id, x: c.x, z: c.z, angle: c.angle,
                 state: c.state, carryType: c.carryType };
      }),
      pads: state.pads.map(function (p) {
        return { id: p.id, x: p.x, z: p.z, kind: p.kind, cost: p.cost,
                 paid: Math.floor(p.paid), label: p.label };
      }),
      floats: state.floats.map(function (f) {
        return { x: f.x, y: f.y, z: f.z, text: f.text, color: f.color, life: f.life };
      }),
      tutorialTarget: state.tutorialTarget
    };
  }

  function onMoney(cb) { if (typeof cb === 'function') moneyCbs.push(cb); }
  function onUnlock(cb) { if (typeof cb === 'function') unlockCbs.push(cb); }

  // Expose product catalogue read-only for the renderer's colour choices.
  function getProductColor(type) {
    return PRODUCTS[type] ? PRODUCTS[type].color : 0xcccccc;
  }

  window.Game = {
    WORLD: WORLD,
    PRODUCTS: PRODUCTS,
    start: start,
    update: update,
    setMove: setMove,
    setMoveTarget: setMoveTarget,
    getState: getState,
    onMoney: onMoney,
    onUnlock: onUnlock,
    getProductColor: getProductColor,
    save: saveGame,
    reset: function () { resetSave(); }
  };
})();

// Coconut Craze: red and blue grab coconuts that fall from three palm trees and carry them to their own conveyor belt.
// Ice coconuts freeze the other player, negative coconuts take away their points, and you can snatch what they're carrying.
(() => {
  // ── The beach ────────────────────────────────────────────────────────────
  const W = 800, H = 500;
  const BELT = 56;                 // red's belt runs down the left edge, blue's down the right
  const R = 18, SPEED = 210, NUT_R = 11, PICK = R + NUT_R + 2;
  const ROUND = 90;                // seconds
  const FREEZE = 3000, GUARD = 1200, FALL = 700;  // ms
  const MAX_NUTS = 8;
  const TREES = [{ x: 230, y: 95 }, { x: 400, y: 95 }, { x: 570, y: 95 }], TRUNK = 16;
  // n: plain coconut, i: ice, x: negative.
  const POINTS = 1, MINUS = 10;
  const COLORS = ['#ff6b6b', '#4dabf7'], DARK = ['#c0392b', '#1c6fb5'], COLOR_NAMES = ['Red', 'Blue'];
  const START = [{ x: 150, y: 400 }, { x: 650, y: 400 }];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const beltX = slot => slot === 0 ? BELT + R : W - BELT - R;  // where a player stands to touch their belt
  const onBelt = p => p.slot === 0 ? p.x <= BELT + R + 1 : p.x >= W - BELT - R - 1;

  // ── Online rooms ─────────────────────────────────────────────────────────
  // Bump with the ?v= on the script in index.html whenever what goes in the room changes.
  const VERSION = 1;
  const OUTDATED = 'That room is using a different version of Coconut Craze. Everyone needs to refresh the page.';
  const ROOMS = 'coconutcraze/rooms';

  const db = window.firebase ? (firebase.initializeApp({
    apiKey:            'AIzaSyAsJboNGVuESMhkivllUD0o8MUB5LUCMRQ',
    authDomain:        'kvgames.firebaseapp.com',
    databaseURL:       'https://kvgames-default-rtdb.firebaseio.com',
    projectId:         'kvgames',
    storageBucket:     'kvgames.firebasestorage.app',
    messagingSenderId: '463308384695',
    appId:             '1:463308384695:web:5d57623ebd52101ad26032',
  }), firebase.database()) : null;
  let clockOffset = 0;  // server clock minus ours, so both devices agree when the round starts and ends
  if (db) db.ref('.info/serverTimeOffset').on('value', s => { clockOffset = s.val() || 0; });
  const now = () => Date.now() + clockOffset;

  const $ = id => document.getElementById(id);
  const show = id => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
    if (id !== 'game') { $('over').hidden = true; $('count').hidden = true; }
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const swatch = slot => `<span class="sw" style="background:${COLORS[slot]}"></span>`;

  const myId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // The host runs the beach: falling coconuts, pickups, snatches and points. It sends all of that in live/state.
  // The other player moves themselves and sends where they are in live/pos.
  let room = null;  // { code, ref, meta, pos, state, joining, listeners }

  const playerList = meta => Object.entries((meta && meta.players) || {}).filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ id, ...p })).sort((a, b) => a.slot - b.slot);

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function busy(on) { for (const b of document.querySelectorAll('#menu button')) b.disabled = on; }
  function myName() {
    const name = $('name').value.trim().slice(0, 14);
    if (!name) { $('menu-error').textContent = 'Type your name first.'; $('name').focus(); return null; }
    store.set('coconutcraze-name', name);
    return name;
  }
  const NO_SERVER = "Can't reach the game server. Check the internet connection.";

  async function createRoom(name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    try {
      let code, ref;
      for (let i = 0; i < 10; i++) {
        code = genCode();
        ref = db.ref(`${ROOMS}/${code}`);
        if (!(await ref.child('meta').get()).exists()) break;
      }
      await ref.set({ meta: { host: myId, v: VERSION, created: firebase.database.ServerValue.TIMESTAMP, phase: 'lobby',
        players: { [myId]: { name, slot: 0 } } } });
      ref.onDisconnect().remove();
      await enterRoom(code, ref);
    } catch (e) {
      $('menu-error').textContent = "Couldn't create a room. Check the internet connection.";
    }
    busy(false);
  }

  async function joinRoom(code, name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    const ref = db.ref(`${ROOMS}/${code}`);
    try {
      const meta = await enterRoom(code, ref, true);
      const problem = !meta || !meta.host ? `There's no room ${code}.` : meta.v !== VERSION ? OUTDATED
        : meta.phase !== 'lobby' ? 'That game has already started. Wait for it to finish, then join.'
        : playerList(meta).length >= 2 ? 'That room is full (2 players).' : null;
      if (problem) throw new Error(problem);
      // A transaction, so two people joining at once can't both get in.
      const res = await ref.child('meta/players').transaction(cur => {
        if (!cur) return;
        const taken = new Set(Object.values(cur).filter(p => p && p.name).map(p => p.slot));
        const slot = [0, 1].find(i => !taken.has(i));
        if (slot === undefined) return;
        cur[myId] = { name, slot };
        return cur;
      });
      if (!res.committed) throw new Error('That room is full (2 players).');
      for (const path of mine()) ref.child(path).onDisconnect().remove();
      room.joining = false;
      render();
    } catch (e) {
      leaveRoom();
      show('menu');
      $('menu-error').textContent = e.message && !/^FIREBASE|permission/i.test(e.message) ? e.message
        : "Couldn't join. Check the code and the internet connection.";
    }
    busy(false);
  }
  const mine = () => [`meta/players/${myId}`, `live/pos/${myId}`];

  // Start listening to the room. Resolves with its first meta, so a join can check it before taking a seat.
  function enterRoom(code, ref, joining = false) {
    leaveRoom();
    room = { code, ref, meta: null, pos: {}, state: null, joining, listeners: [] };
    const r = room;
    const listen = (path, ev, fn) => { const q = ref.child(path); q.on(ev, fn); r.listeners.push([q, ev, fn]); };
    listen('live/pos', 'value', snap => { if (room === r) r.pos = snap.val() || {}; });
    listen('live/state', 'value', snap => { if (room === r) { r.state = snap.val(); if (game) applyState(); } });
    return new Promise(resolve => {
      listen('meta', 'value', snap => {
        if (room !== r) return;
        r.meta = snap.val();
        if (resolve) { const f = resolve; resolve = null; f(r.meta); if (joining) return; }
        if (!r.joining) render();
      });
    });
  }
  function leaveRoom() {
    const r = room;
    game = null;
    if (!r) return;
    room = null;
    for (const [q, ev, fn] of r.listeners) q.off(ev, fn);
    if (r.meta && r.meta.host === myId) { r.ref.onDisconnect().cancel(); r.ref.remove(); }
    else if (!r.joining) for (const path of mine()) { const c = r.ref.child(path); c.onDisconnect().cancel(); c.remove(); }
  }

  function startRound() {
    const meta = room && room.meta;
    if (!meta || meta.host !== myId || playerList(meta).length < 2) return;
    const startAt = now() + 3600;
    room.ref.child('live').remove();
    room.ref.child('meta').update({ phase: 'play', startAt, endAt: startAt + ROUND * 1000, scores: null });
  }

  // ── The game ─────────────────────────────────────────────────────────────
  // game: { mode: practice/local/online, auth (this device runs the beach), me (my slot), startAt, endAt, players: [red, blue],
  //   nuts, belt, fx, ev, evSeen, drops, over }.
  let game = null;

  function newPlayer(slot, name, moved, bot) {
    const s = START[slot];
    return { slot, name, x: s.x, y: s.y, tx: s.x, ty: s.y, face: -Math.PI / 2, walk: 0, moving: false,
      hold: '', frozen: 0, guard: 0, score: 0, moved, bot, think: 0, goal: null, stuck: 0 };
  }
  function newGame(mode, startAt, names, me = 0) {
    const auth = mode !== 'online' || me === 0;
    game = { mode, auth, me, startAt, endAt: startAt + ROUND * 1000, nuts: [], belt: [], fx: [], ev: [], evN: 0, evSeen: 0,
      drops: TREES.map((_, i) => startAt + 400 + i * 500), nid: 0, over: null, sendAt: 0, sent: '', ended: false };
    game.players = [0, 1].map(slot => newPlayer(slot, names[slot],
      mode === 'local' || slot === me || (mode === 'practice' && slot === 1), mode === 'practice' && slot === 1));
    $('over').hidden = true;
    $('controls').classList.toggle('two', mode === 'local');
    $('stick1').hidden = mode !== 'local';
    $('keys-hint').textContent = mode === 'local' ? 'Red: W A S D · Blue: arrow keys' : 'Move with the arrow keys or W A S D';
  }
  function startPractice() { leaveRoom(); newGame('practice', now() + 3600, ['You', 'Computer']); show('game'); fit(); }
  function startLocal() { leaveRoom(); newGame('local', now() + 3600, ['Red', 'Blue']); show('game'); fit(); }
  const playing = () => game && !game.over && now() >= game.startAt && now() < game.endAt;
  const frozen = p => now() < p.frozen;

  // ── Moving ───────────────────────────────────────────────────────────────
  const keys = new Set();
  const sticks = [{ x: 0, y: 0, on: false }, { x: 0, y: 0, on: false }];
  const WASD = { KeyW: [0, -1], KeyA: [-1, 0], KeyS: [0, 1], KeyD: [1, 0] };
  const ARROWS = { ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0] };
  function keyVec(map) { let x = 0, y = 0; for (const [k, v] of Object.entries(map)) if (keys.has(k)) { x += v[0]; y += v[1]; } return [x, y]; }
  // Which way a person wants to walk: a stick, or keys. With two players on one device, each has their own.
  function input(slot) {
    const two = game.mode === 'local', st = sticks[two ? slot : 0];
    if (st.on && Math.hypot(st.x, st.y) > 0.15) return [st.x, st.y];
    let [x, y] = two ? keyVec(slot === 0 ? WASD : ARROWS) : (() => { const a = keyVec(WASD), b = keyVec(ARROWS); return [a[0] + b[0], a[1] + b[1]]; })();
    const d = Math.hypot(x, y);
    return d ? [x / d, y / d] : [0, 0];
  }

  // The computer player: carry coconuts home, chase you if you're carrying one, and go for the special coconuts first.
  function botInput(p, dt) {
    const o = game.players[1 - p.slot];
    p.think -= dt;
    if (p.think <= 0) {
      p.think = 0.15 + Math.random() * 0.15;
      if (p.hold) p.goal = { x: beltX(p.slot) + (p.slot === 0 ? -10 : 10), y: clamp(p.y, 60, H - 40) };
      else {
        let best = null, score = 1e9;
        for (const n of game.nuts) {
          const d = Math.hypot(n.x - p.x, n.y - p.y) * (n.k === 'n' ? 1 : 0.6) + Math.max(0, n.at + FALL - now()) * 0.1;
          if (d < score) { score = d; best = n; }
        }
        const od = Math.hypot(o.x - p.x, o.y - p.y);
        if (o.hold && now() > o.guard && od < 230 && (od < score || o.hold !== 'n')) p.goal = { x: o.x, y: o.y };
        else p.goal = best ? { x: best.x, y: best.y } : { x: W / 2 + 60, y: H / 2 + 40 };
      }
    }
    const g = p.goal; if (!g) return [0, 0];
    let dx = g.x - p.x, dy = g.y - p.y, d = Math.hypot(dx, dy);
    if (d < 4) return [0, 0];
    dx /= d; dy /= d;
    // Step around a tree trunk in the way.
    for (const t of TREES) {
      const ax = t.x - p.x, ay = t.y - p.y, ahead = ax * dx + ay * dy;
      if (ahead > 0 && ahead < 60 && Math.abs(ax * dy - ay * dx) < TRUNK + R) { const s = ax * dy - ay * dx > 0 ? 1 : -1; dx += dy * s * 1.2; dy -= dx * s * 1.2; }
    }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l * 0.82, dy / l * 0.82];
  }

  function walk(p, v, dt) {
    const sp = Math.hypot(v[0], v[1]);
    p.moving = sp > 0.05;
    if (!p.moving) return;
    p.face = Math.atan2(v[1], v[0]);
    p.walk += dt * sp;
    p.x += v[0] * SPEED * dt; p.y += v[1] * SPEED * dt;
    for (const t of TREES) {
      const dx = p.x - t.x, dy = p.y - t.y, d = Math.hypot(dx, dy), min = TRUNK + R;
      if (d < min) { p.x = t.x + dx / (d || 1) * min; p.y = t.y + dy / (d || 1) * min; }
    }
    p.x = clamp(p.x, BELT + R, W - BELT - R); p.y = clamp(p.y, R + 34, H - R);
    p.tx = p.x; p.ty = p.y;
  }

  // ── The beach rules (run by the host, or by this device when not online) ─
  function dropNuts() {
    const t = now();
    TREES.forEach((tree, i) => {
      if (t < game.drops[i]) return;
      game.drops[i] = t + 1600 + Math.random() * 1800;
      if (game.nuts.length >= MAX_NUTS) return;
      for (let tries = 0; tries < 20; tries++) {
        const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 140;
        const x = clamp(tree.x + Math.cos(a) * d, BELT + 30, W - BELT - 30), y = clamp(tree.y + 40 + Math.abs(Math.sin(a)) * d, 70, H - 24);
        if (TREES.some(o => Math.hypot(x - o.x, y - o.y) < TRUNK + NUT_R + 10)) continue;
        const r = Math.random(), k = r < 0.13 ? 'i' : r < 0.25 ? 'x' : 'n';
        game.nuts.push({ id: ++game.nid, k, x: Math.round(x), y: Math.round(y), tree: i, at: t });
        return;
      }
    });
  }
  function event(e) { e.n = ++game.evN; game.ev.push(e); if (game.ev.length > 10) game.ev.shift(); playEvent(e); game.evSeen = e.n; }

  function rules() {
    dropNuts();
    const t = now(), [a, b] = game.players;
    for (const p of game.players) {
      if (frozen(p)) continue;
      if (!p.hold) {
        const n = game.nuts.find(n => t >= n.at + FALL && Math.hypot(n.x - p.tx, n.y - p.ty) < PICK);
        if (n) { p.hold = n.k; game.nuts = game.nuts.filter(m => m !== n); event({ t: 'p', s: p.slot, k: n.k }); }
      } else if (onBelt({ slot: p.slot, x: p.tx })) {
        const o = game.players[1 - p.slot], k = p.hold;
        p.hold = '';
        if (k === 'n') p.score += POINTS;
        else if (k === 'i') o.frozen = t + FREEZE;
        else o.score = Math.max(0, o.score - MINUS);
        event({ t: 'd', s: p.slot, k, y: Math.round(p.ty) });
      }
    }
    // Snatch: empty hands bump into full hands. The snatcher is safe from being snatched back for a moment.
    for (const [p, o] of [[a, b], [b, a]]) {
      if (p.hold || !o.hold || frozen(p) || t < o.guard) continue;
      if (Math.hypot(p.tx - o.tx, p.ty - o.ty) > R * 2 + 6) continue;
      p.hold = o.hold; o.hold = ''; p.guard = t + GUARD;
      event({ t: 's', s: p.slot, k: p.hold });
      break;
    }
    if (t >= game.endAt) finish();
  }

  function finish() {
    if (game.ended) return;
    game.ended = true;
    const scores = game.players.map(p => p.score);
    if (game.mode === 'online') { sendState(true); room.ref.child('meta').update({ phase: 'over', scores }); }
    else setTimeout(() => { if (game && game.ended && !game.over) { game.over = { scores }; showOver(); } }, 1000);
  }

  // Sounds, belt rides and floating words for something that happened. The other device gets the same list from the host.
  function playEvent(e) {
    const p = game.players[e.s], o = game.players[1 - e.s];
    if (e.t === 'p') { sfx.pickup(); return; }
    if (e.t === 's') { text(p.x, p.y - 30, 'SNATCH!', '#fff'); sfx.snatch(); return; }
    game.belt.push({ slot: e.s, k: e.k, y: e.y });
    if (e.k === 'n') { text(p.x, p.y - 30, `+${POINTS}`, COLORS[e.s]); sfx.point(); }
    else if (e.k === 'i') { text(o.x, o.y - 34, 'FROZEN!', '#bfefff'); sfx.freeze(); }
    else { text(o.x, o.y - 34, `−${MINUS}`, '#d0a0ff'); sfx.minus(); }
  }
  const text = (x, y, s, c) => game.fx.push({ x, y, s, c, t: 0 });

  // ── Keeping two devices in step ──────────────────────────────────────────
  function sendState(force) {
    if (performance.now() < game.sendAt && !force) return;
    game.sendAt = performance.now() + 80;
    const s = {
      p: game.players.map(p => [Math.round(p.tx), Math.round(p.ty), +p.face.toFixed(2), p.moving ? 1 : 0, p.hold, p.frozen, p.guard, p.score]),
      n: game.nuts.map(n => [n.id, n.k, n.x, n.y, n.tree, n.at]),
      e: game.ev,
    };
    room.ref.child('live/state').set(JSON.stringify(s));
  }
  function sendPos() {
    if (performance.now() < game.sendAt) return;
    const p = game.players[game.me], v = [Math.round(p.x), Math.round(p.y), +p.face.toFixed(2), p.moving ? 1 : 0].join(',');
    if (v === game.sent && performance.now() < game.sendAt + 500) return;
    game.sendAt = performance.now() + 70; game.sent = v;
    room.ref.child(`live/pos/${myId}`).set(v);
  }
  // The guest takes everything but its own position from the host.
  function applyState() {
    if (!game || game.auth || !room.state) return;
    let s; try { s = JSON.parse(room.state); } catch { return; }
    s.p.forEach((q, slot) => {
      const p = game.players[slot];
      if (slot !== game.me) { p.tx = q[0]; p.ty = q[1]; p.face = q[2]; p.moving = !!q[3]; }
      p.hold = q[4]; p.frozen = q[5]; p.guard = q[6]; p.score = q[7];
    });
    game.nuts = s.n.map(([id, k, x, y, tree, at]) => ({ id, k, x, y, tree, at }));
    for (const e of s.e || []) if (e.n > game.evSeen) { game.evSeen = e.n; playEvent(e); }
  }
  // The host reads where the guest is.
  function readGuest() {
    const meta = room.meta, guest = playerList(meta).find(p => p.slot === 1), v = guest && room.pos[guest.id];
    if (!v) return;
    const [x, y, face, moving] = String(v).split(',').map(Number);
    const p = game.players[1];
    p.tx = x; p.ty = y; p.face = face; p.moving = !!moving;
  }

  function update(dt) {
    const go = playing();
    for (const p of game.players) {
      if (p.moved && go && !frozen(p)) walk(p, p.bot ? botInput(p, dt) : input(p.slot), dt);
      else if (p.moved) p.moving = false;
      if (!p.moved) {
        // Glide toward where the other device says they are.
        const k = Math.min(1, dt * 12);
        p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
        if (p.moving) p.walk += dt;
      }
    }
    if (game.mode === 'online') {
      if (game.auth) { readGuest(); if (go || (now() >= game.endAt && !game.ended)) rules(); sendState(false); }
      else if (go) sendPos();
    } else if (go || (now() >= game.endAt && !game.ended)) rules();
    for (const b of game.belt) b.y += 90 * dt;
    game.belt = game.belt.filter(b => b.y < H + 30);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const canvas = $('canvas'), g2 = canvas.getContext('2d');
  let S = 1, lastFrame = performance.now();

  function fit() {
    const wrap = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(100, Math.floor(Math.min(wrap.width - 8, (wrap.height - 4) * W / H))), h = Math.round(w * H / W);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    S = w / W * dpr;
  }
  window.addEventListener('resize', () => { if (game) fit(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (game) fit(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { if (game) fit(); }, 300));

  function drawBeach(t) {
    const sand = g2.createLinearGradient(0, 0, 0, H);
    sand.addColorStop(0, '#f6dc9a'); sand.addColorStop(1, '#e9c27a');
    g2.fillStyle = sand; g2.fillRect(0, 0, W, H);
    // The sea along the top, with foam.
    g2.fillStyle = '#3bb6d6'; g2.fillRect(0, 0, W, 30);
    g2.fillStyle = 'rgba(255,255,255,.8)'; g2.beginPath(); g2.moveTo(0, 30);
    for (let x = 0; x <= W; x += 20) g2.lineTo(x, 30 + Math.sin(x / 30 + t * 2) * 4);
    g2.lineTo(W, 24); g2.lineTo(0, 24); g2.fill();
    // Specks of sand.
    g2.fillStyle = 'rgba(160,110,50,.18)';
    for (let i = 0; i < 70; i++) { g2.beginPath(); g2.arc((i * 137) % W, 40 + (i * 89) % (H - 40), 1.6, 0, 7); g2.fill(); }
  }
  function drawBelt(slot, t) {
    const x0 = slot === 0 ? 0 : W - BELT;
    g2.fillStyle = '#4b5563'; g2.fillRect(x0, 0, BELT, H);
    g2.fillStyle = '#2f3640'; g2.fillRect(x0 + 6, 0, BELT - 12, H);
    // Stripes that move down, so it looks like it's running.
    g2.strokeStyle = 'rgba(255,255,255,.12)'; g2.lineWidth = 3;
    const off = (t * 90) % 24;
    g2.beginPath(); for (let y = -24 + off; y < H; y += 24) { g2.moveTo(x0 + 8, y); g2.lineTo(x0 + BELT - 8, y); } g2.stroke();
    g2.fillStyle = COLORS[slot]; g2.fillRect(slot === 0 ? x0 + BELT - 5 : x0, 0, 5, H);
    for (const b of game.belt) if (b.slot === slot) drawNut(x0 + BELT / 2, b.y, b.k, 1);
  }
  function drawNut(x, y, k, s) {
    g2.save(); g2.translate(x, y); g2.scale(s, s);
    const c = k === 'i' ? ['#bff3ff', '#5bc8e8'] : k === 'x' ? ['#a46be0', '#5b2c91'] : ['#8b5a2b', '#4e2f12'];
    const grad = g2.createRadialGradient(-3, -4, 2, 0, 0, NUT_R);
    grad.addColorStop(0, c[0]); grad.addColorStop(1, c[1]);
    g2.fillStyle = grad; g2.beginPath(); g2.arc(0, 0, NUT_R, 0, 7); g2.fill();
    if (k === 'n') { g2.fillStyle = '#2b1a0a'; for (const [a, b] of [[-3, -2], [3, -2], [0, 3]]) { g2.beginPath(); g2.arc(a, b, 1.6, 0, 7); g2.fill(); } }
    if (k === 'i') { g2.strokeStyle = '#fff'; g2.lineWidth = 1.6; g2.beginPath(); for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; g2.moveTo(Math.cos(a) * 7, Math.sin(a) * 7); g2.lineTo(-Math.cos(a) * 7, -Math.sin(a) * 7); } g2.stroke(); }
    if (k === 'x') { g2.fillStyle = '#fff'; g2.fillRect(-6, -1.8, 12, 3.6); }
    g2.restore();
  }
  function drawTrunk(tree) {
    g2.fillStyle = 'rgba(0,0,0,.15)'; g2.beginPath(); g2.ellipse(tree.x + 10, tree.y + 12, 60, 26, 0, 0, 7); g2.fill();
    g2.fillStyle = '#8a5a2e'; g2.beginPath(); g2.arc(tree.x, tree.y, TRUNK, 0, 7); g2.fill();
    g2.strokeStyle = '#5e3a1a'; g2.lineWidth = 2; g2.beginPath(); g2.arc(tree.x, tree.y, TRUNK - 5, 0, 7); g2.stroke();
  }
  function drawCrown(tree, t, i) {
    g2.save(); g2.translate(tree.x, tree.y - 20);
    for (let k = 0; k < 7; k++) {
      const a = k * Math.PI * 2 / 7 + Math.sin(t * 1.3 + i + k) * 0.06;
      g2.save(); g2.rotate(a);
      g2.fillStyle = k % 2 ? '#2f9e44' : '#37b24d';
      g2.beginPath(); g2.ellipse(34, 0, 36, 11, 0, 0, 7); g2.fill();
      g2.strokeStyle = 'rgba(0,60,0,.35)'; g2.lineWidth = 1.5; g2.beginPath(); g2.moveTo(4, 0); g2.lineTo(66, 0); g2.stroke();
      g2.restore();
    }
    for (const [x, y] of [[-6, -3], [6, -3], [0, 6]]) drawNut(x, y, 'n', 0.7);
    g2.restore();
  }
  function drawPlayer(p, t) {
    const { x, y } = p;
    g2.fillStyle = 'rgba(0,0,0,.18)'; g2.beginPath(); g2.ellipse(x, y + R - 2, R, 6, 0, 0, 7); g2.fill();
    // Feet that step while walking.
    const step = p.moving ? Math.sin(p.walk * 16) * 5 : 0;
    g2.fillStyle = DARK[p.slot];
    g2.beginPath(); g2.ellipse(x - 8, y + R - 3 + step * 0.3, 6, 4, 0, 0, 7); g2.fill();
    g2.beginPath(); g2.ellipse(x + 8, y + R - 3 - step * 0.3, 6, 4, 0, 0, 7); g2.fill();
    g2.fillStyle = COLORS[p.slot]; g2.strokeStyle = DARK[p.slot]; g2.lineWidth = 3;
    g2.beginPath(); g2.arc(x, y, R, 0, 7); g2.fill(); g2.stroke();
    // Eyes look the way they're walking.
    const ex = Math.cos(p.face) * 5, ey = Math.sin(p.face) * 4;
    for (const s of [-1, 1]) {
      g2.fillStyle = '#fff'; g2.beginPath(); g2.arc(x + s * 6 + ex * 0.4, y - 4 + ey * 0.4, 5, 0, 7); g2.fill();
      g2.fillStyle = '#111'; g2.beginPath(); g2.arc(x + s * 6 + ex * 0.7, y - 4 + ey * 0.7, 2.4, 0, 7); g2.fill();
    }
    g2.strokeStyle = '#111'; g2.lineWidth = 2; g2.beginPath(); g2.arc(x, y + 5, 5, 0.2, Math.PI - 0.2); g2.stroke();
    if (p.hold) {
      // Arms up, coconut over the head.
      g2.strokeStyle = DARK[p.slot]; g2.lineWidth = 4; g2.lineCap = 'round';
      g2.beginPath(); g2.moveTo(x - R + 2, y - 4); g2.lineTo(x - 9, y - R - 8); g2.moveTo(x + R - 2, y - 4); g2.lineTo(x + 9, y - R - 8); g2.stroke();
      drawNut(x, y - R - 12, p.hold, 1.1);
    }
    if (frozen(p)) {
      g2.fillStyle = 'rgba(190,235,255,.6)'; g2.strokeStyle = '#fff'; g2.lineWidth = 2;
      g2.beginPath(); g2.roundRect(x - R - 7, y - R - (p.hold ? 26 : 8), R * 2 + 14, R * 2 + (p.hold ? 32 : 14), 8); g2.fill(); g2.stroke();
      g2.fillStyle = '#fff'; g2.font = '700 13px Fredoka, sans-serif'; g2.textAlign = 'center';
      g2.fillText(Math.ceil((p.frozen - now()) / 1000), x, y + R + 18);
    } else if (now() < p.guard && Math.floor(t * 10) % 2) {
      g2.strokeStyle = 'rgba(255,255,255,.8)'; g2.lineWidth = 2; g2.beginPath(); g2.arc(x, y, R + 6, 0, 7); g2.stroke();
    }
  }
  function drawFallingNut(n, t) {
    const k = clamp((now() - n.at) / FALL, 0, 1), tree = TREES[n.tree];
    if (k >= 1) { drawNut(n.x, n.y, n.k, 1); return; }
    // A shadow grows where it'll land, and the coconut drops from the tree in a little arc.
    g2.fillStyle = `rgba(0,0,0,${0.1 + 0.15 * k})`; g2.beginPath(); g2.ellipse(n.x, n.y + 6, 8 + 4 * k, 3 + 2 * k, 0, 0, 7); g2.fill();
    const x = tree.x + (n.x - tree.x) * k, y = tree.y - 20 + (n.y - tree.y + 20) * k - Math.sin(k * Math.PI) * 50;
    drawNut(x, y, n.k, 1);
  }
  function drawFx(dt) {
    for (const f of game.fx) {
      f.t += dt;
      g2.globalAlpha = Math.max(0, 1 - f.t);
      g2.font = '700 24px Fredoka, sans-serif'; g2.textAlign = 'center';
      g2.lineWidth = 4; g2.strokeStyle = 'rgba(0,0,0,.5)'; g2.strokeText(f.s, f.x, f.y - f.t * 40);
      g2.fillStyle = f.c; g2.fillText(f.s, f.x, f.y - f.t * 40);
    }
    g2.globalAlpha = 1;
    game.fx = game.fx.filter(f => f.t < 1);
  }
  function drawHud() {
    const [a, b] = game.players, left = Math.max(0, Math.ceil((game.endAt - Math.max(now(), game.startAt)) / 1000));
    const label = p => `${p.slot === 0 ? '🔴' : '🔵'} ${p.name} ${p.score}`;
    const set = (id, v) => { if ($(id).textContent !== v) $(id).textContent = v; };
    set('score0', label(a)); set('score1', label(b));
    set('timer', `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
  }

  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - lastFrame) / 1000); lastFrame = t;
    if (!game || $('game').hidden) return;
    update(dt);
    if (!game) return;
    const time = t / 1000;
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.clearRect(0, 0, canvas.width, canvas.height);
    g2.setTransform(S, 0, 0, S, 0, 0);
    drawBeach(time);
    drawBelt(0, time); drawBelt(1, time);
    for (const tree of TREES) drawTrunk(tree);
    for (const n of game.nuts) if (now() >= n.at + FALL) drawNut(n.x, n.y, n.k, 1);
    for (const p of [...game.players].sort((p, q) => p.y - q.y)) drawPlayer(p, time);
    TREES.forEach((tree, i) => drawCrown(tree, time, i));
    for (const n of game.nuts) if (now() < n.at + FALL) drawFallingNut(n, time);
    drawFx(dt);
    drawHud();
    // Countdown at the start, and "TIME!" at the end.
    const toStart = game.startAt - now(), toEnd = game.endAt - now();
    const txt = toStart > 0 ? String(Math.ceil(toStart / 1000)) : toStart > -700 ? 'GO!' : toEnd <= 0 && $('over').hidden ? 'TIME!' : toEnd < 5000 && toEnd > 0 ? String(Math.ceil(toEnd / 1000)) : '';
    $('count').hidden = !txt || !$('over').hidden;
    if (txt && $('count').textContent !== txt) { $('count').textContent = txt; sfx.beep(txt === 'GO!' || txt === 'TIME!'); }
  }
  requestAnimationFrame(frame);

  // ── Sounds ───────────────────────────────────────────────────────────────
  // Made on the fly with Web Audio, so there are no sound files. Phones only allow sound after a tap.
  const sfx = (() => {
    let ac = null, muted = store.get('coconutcraze-mute') === '1';
    function ctx() {
      if (muted) return null;
      if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ac = new AC(); }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(f, dur, type = 'square', vol = 0.08, slide = 1) {
      const a = ctx(); if (!a) return;
      const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
      o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * slide, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur);
    }
    return {
      pickup() { tone(420, 0.08, 'sine', 0.1, 1.6); },
      point() { tone(880, 0.1, 'square', 0.07); setTimeout(() => tone(1320, 0.15, 'square', 0.07), 80); },
      freeze() { [1800, 2200, 2600, 3000].forEach((f, k) => setTimeout(() => tone(f, 0.12, 'sine', 0.06), k * 50)); },
      minus() { tone(300, 0.4, 'sawtooth', 0.08, 0.5); },
      snatch() { tone(1200, 0.15, 'triangle', 0.1, 0.3); },
      beep(go) { tone(go ? 880 : 440, go ? 0.35 : 0.15, 'square', 0.08); },
      win() { [523, 659, 784, 1047].forEach((f, k) => setTimeout(() => tone(f, 0.25, 'square', 0.09), k * 120)); },
      unlock() { ctx(); },
      get muted() { return muted; },
      toggle() { muted = !muted; store.set('coconutcraze-mute', muted ? '1' : '0'); },
    };
  })();

  // ── Screens ──────────────────────────────────────────────────────────────
  function showOver() {
    const [s0, s1] = game.over.scores, [a, b] = game.players;
    $('over').hidden = false;
    keys.clear();
    const w = s0 === s1 ? null : s0 > s1 ? a : b;
    const iWin = w && game.mode !== 'local' && w.slot === game.me;
    $('winner').innerHTML = !w ? "It's a tie! 🥥" : iWin ? `${swatch(w.slot)} You win! 🏆` : `${swatch(w.slot)} ${esc(w.name)} wins! 🏆`;
    $('place').textContent = `${a.name} ${s0} · ${b.name} ${s1}`;
    if (w && (iWin || game.mode === 'local')) sfx.win();
    const canAgain = game.mode !== 'online' || (room && room.meta && room.meta.host === myId);
    $('again').hidden = !canAgain;
    $('again-wait').hidden = canAgain;
  }

  function render() {
    const meta = room && room.meta;
    if (!room) { show('menu'); return; }
    if (!meta || !meta.host) { leaveRoom(); show('menu'); $('menu-error').textContent = 'The host left, so the room closed.'; return; }
    if (!meta.players || !meta.players[myId]) { leaveRoom(); show('menu'); $('menu-error').textContent = 'You left the room.'; return; }
    const players = playerList(meta), host = meta.host === myId;
    // If the other player leaves in the middle, go back to the lobby to wait for someone new.
    if (meta.phase !== 'lobby' && players.length < 2 && host) { room.ref.child('meta').update({ phase: 'lobby', scores: null }); return; }

    if (meta.phase === 'lobby') {
      game = null;
      show('lobby');
      $('code').textContent = room.code;
      $('lobby-players').innerHTML = players.map(p => `<li>${swatch(p.slot)}<span class="pname">${esc(p.name)}</span>
        <span class="muted">${COLOR_NAMES[p.slot]}${p.id === meta.host ? ' · host' : ''}${p.id === myId ? ' · you' : ''}</span></li>`).join('');
      $('start').hidden = !host;
      $('start').disabled = players.length < 2;
      $('start').textContent = players.length > 1 ? 'Start' : 'Start (needs 2 players)';
      $('lobby-wait').hidden = host;
      return;
    }

    if (!game || game.mode !== 'online' || game.startAt !== meta.startAt) {
      const names = [0, 1].map(s => { const p = players.find(q => q.slot === s); return p ? p.name : '?'; });
      newGame('online', meta.startAt, names, meta.players[myId].slot);
      applyState();
    }
    show('game');
    fit();
    if (meta.phase === 'over' && !game.over) {
      applyState();
      game.over = { scores: meta.scores || game.players.map(p => p.score) };
      showOver();
    }
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  const inGame = () => !$('game').hidden && $('over').hidden;
  document.addEventListener('keydown', e => {
    if (!inGame() || !(e.code in WASD || e.code in ARROWS)) return;
    e.preventDefault(); keys.add(e.code);
  });
  document.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); for (const s of sticks) s.on = false; });

  // A stick for each player: push the way you want to walk.
  [0, 1].forEach(i => {
    const el = $('stick' + i), knob = el.querySelector('.knob'), st = sticks[i];
    let pid = null;
    function move(e) {
      const r = el.getBoundingClientRect(), rad = r.width / 2;
      let dx = (e.clientX - r.left - rad) / rad, dy = (e.clientY - r.top - rad) / rad;
      const d = Math.hypot(dx, dy); if (d > 1) { dx /= d; dy /= d; }
      st.x = dx; st.y = dy; st.on = true;
      knob.style.transform = `translate(${dx * rad * 0.6}px, ${dy * rad * 0.6}px)`;
    }
    el.addEventListener('pointerdown', e => { e.preventDefault(); pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch {} move(e); });
    el.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, e => {
      if (e.pointerId !== pid) return;
      pid = null; st.on = false; st.x = st.y = 0; knob.style.transform = '';
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
  });

  // Some touchscreens say they have a mouse, so show the sticks whenever there's a touchscreen at all.
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) document.body.classList.add('touch');

  $('practice').onclick = startPractice;
  $('local').onclick = startLocal;
  $('name').value = store.get('coconutcraze-name') || '';
  $('create').onclick = () => { const n = myName(); if (n) createRoom(n); };
  $('join').onclick = () => {
    const n = myName(); if (!n) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { $('menu-error').textContent = 'Room codes are 4 letters.'; return; }
    joinRoom(code, n);
  };
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  $('start').onclick = startRound;
  $('again').onclick = () => { if (!game) return; if (game.mode === 'practice') startPractice(); else if (game.mode === 'local') startLocal(); else startRound(); };
  for (const id of ['lobby-leave', 'game-leave', 'over-leave']) $(id).onclick = () => { leaveRoom(); show('menu'); };
  const drawMute = () => { $('mute').textContent = sfx.muted ? '🔇' : '🔊'; };
  $('mute').onclick = () => { sfx.toggle(); drawMute(); };
  drawMute();
  window.addEventListener('pagehide', leaveRoom);
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) document.addEventListener(ev, () => sfx.unlock(), { capture: true, passive: true });

  // For testing: ?debug lets a test script reach the game.
  if (/[?&]debug\b/.test(location.search)) window.cocoGame = () => game;

  if (!db) $('menu-error').textContent = NO_SERVER;
  show('menu');
})();

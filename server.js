const http = require('http'), fs = require('fs'), path = require('path'), { WebSocketServer } = require('ws');
const server = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
});
const wss = new WebSocketServer({ server });

// armas: dano, cooldown(ms), espalhamento, projéteis, alcance
const W = [
  { d: 18, cd: 350, sp: .01, pe: 1, r: 120 },  // pistola
  { d: 12, cd: 110, sp: .03, pe: 1, r: 140 },  // rifle
  { d: 11, cd: 900, sp: .09, pe: 6, r: 50 },   // shotgun
  { d: 80, cd: 1500, sp: 0, pe: 1, r: 300 }    // sniper
];
const PLANE = 20000, GRACE = 15000, LOBBY = 15000;
let players = new Map(), nid = 1, state = 'lobby', lobbyEnd = 0, match = null, loot = [];

const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const each = (f, o) => { for (const p of players.values()) if (f(p)) send(p, o); };
const R = (a, b) => a + Math.random() * (b - a);
const alive = () => [...players.values()].filter(p => p.in && p.alive);

function die(v, k) {
  v.alive = false;
  if (k && k !== v) k.k++;
  send(v, { t: 'dead', place: alive().length + 1, k: v.k });
  each(p => p.in, { t: 'feed', a: k && k !== v ? k.nick : 'Zona', v: v.nick });
}

function hit(o, d, r, skip) {
  let best = null, bt = r;
  for (const q of players.values()) {
    if (!q.alive || !q.in || q.id === skip || q.ph === 'plane') continue;
    const cx = q.x - o[0], cy = q.y + 0.9 - o[1], cz = q.z - o[2];
    const t = cx * d[0] + cy * d[1] + cz * d[2];
    if (t < 0 || t > bt) continue;
    const px = cx - d[0] * t, py = cy - d[1] * t, pz = cz - d[2] * t;
    if (px * px + py * py + pz * pz < 0.64) { best = q; bt = t; }
  }
  return best;
}

function start() {
  state = 'playing';
  const plane = { ax: -230, az: R(-100, 100), bx: 230, bz: R(-100, 100) };
  match = { t0: Date.now(), n: 0 };
  loot = [];
  for (let i = 0; i < 90; i++) loot.push({ id: i, x: R(-200, 200), z: R(-200, 200), w: [0, 0, 1, 1, 2, 3, 4, 4][i % 8] });
  const seed = (Math.random() * 1e9) | 0;
  for (const p of players.values()) if (p.joined) {
    Object.assign(p, { joined: false, in: true, alive: true, hp: 100, ph: 'plane', w: -1, k: 0, x: 0, y: 130, z: 0 });
    match.n++;
  }
  each(p => p.in, { t: 'start', seed, plane, loot, dur: PLANE });
}

setInterval(() => {
  const now = Date.now();
  if (state === 'lobby') {
    const j = [...players.values()].filter(p => p.joined).length;
    if (!j) lobbyEnd = 0; else if (!lobbyEnd) lobbyEnd = now + LOBBY;
    each(p => p.joined, { t: 'lobby', n: j, left: lobbyEnd ? Math.max(0, Math.ceil((lobbyEnd - now) / 1000)) : 0 });
    if (lobbyEnd && now >= lobbyEnd) { lobbyEnd = 0; start(); }
    return;
  }
  if (state === 'ended') { if (now > match.endAt) state = 'lobby'; return; }

  const el = now - match.t0, zt = el - GRACE;
  const r = zt < 0 ? 230 : Math.max(8, 230 - zt / 1000 * 1.8);
  if (el >= PLANE) for (const p of players.values()) if (p.in && p.ph === 'plane') p.ph = 'air';
  for (const p of alive()) {
    if (p.ph !== 'plane' && Math.hypot(p.x, p.z) > r) {
      p.hp -= (2 + Math.max(0, zt) / 30000) * .05;
      if (p.hp <= 0) die(p, null);
    }
  }
  const a = alive();
  const rows = [...players.values()].filter(p => p.in).map(p =>
    [p.id, p.nick, p.x, p.y, p.z, p.ry, Math.max(0, Math.round(p.hp)), p.alive ? 1 : 0, p.skin, p.w, p.ph === 'plane' ? 1 : 0]);
  each(p => p.in, { t: 's', p: rows, r, a: a.length });

  if (a.length === 0 || (match.n > 1 && a.length <= 1)) {
    if (a[0]) { send(a[0], { t: 'dead', place: 1, k: a[0].k }); a[0].alive = false; }
    each(p => p.in, { t: 'end', w: a[0] ? a[0].nick : '' });
    for (const p of players.values()) p.in = false;
    state = 'ended'; match.endAt = now + 6000;
  }
}, 50);

wss.on('connection', ws => {
  const p = { id: nid++, ws, nick: '', skin: 0, x: 0, y: 0, z: 0, ry: 0, hp: 100, alive: false, ph: 'lobby', w: -1, k: 0, last: 0, joined: false, in: false };
  players.set(p.id, p);
  send(p, { t: 'init', id: p.id });

  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 'join') {
      if (state !== 'lobby') { send(p, { t: 'wait' }); return; }
      p.nick = String(m.nick || 'Jogador').slice(0, 14); p.skin = m.skin | 0; p.joined = true;
    } else if (m.t === 'leave') {
      p.joined = false; p.in = false; p.alive = false;
    } else if (!p.in || !p.alive) {
      return;
    } else if (m.t === 'jump') {
      if (p.ph === 'plane') p.ph = 'air';
    } else if (m.t === 'pos') {
      if ([m.x, m.y, m.z, m.ry].every(Number.isFinite) && p.ph !== 'plane') {
        p.x = Math.max(-250, Math.min(250, m.x)); p.z = Math.max(-250, Math.min(250, m.z));
        p.y = Math.max(0, Math.min(140, m.y)); p.ry = m.ry;
        if (p.ph === 'air' && p.y <= 0.1) p.ph = 'ground';
      }
    } else if (m.t === 'pick') {
      const i = loot.findIndex(l => l.id === m.id); if (i < 0) return;
      const l = loot[i]; if (Math.hypot(l.x - p.x, l.z - p.z) > 4) return;
      loot.splice(i, 1);
      if (l.w === 4) p.hp = Math.min(100, p.hp + 40); else p.w = l.w;
      each(q => q.in, { t: 'pick', id: l.id });
      send(p, { t: 'got', w: l.w });
    } else if (m.t === 'shoot') {
      const w = W[p.w], n = Date.now();
      if (!w || p.ph === 'plane' || n - p.last < w.cd * .9) return;
      if (!Array.isArray(m.d) || m.d.length !== 3 || !m.d.every(Number.isFinite)) return;
      p.last = n;
      const o = [p.x, p.y + 1.6, p.z];
      for (let i = 0; i < w.pe; i++) {
        let v = m.d.map(c => c + R(-w.sp, w.sp));
        const l = Math.hypot(...v) || 1; v = v.map(c => c / l);
        const q = hit(o, v, w.r, p.id);
        if (q) { q.hp -= w.d; send(p, { t: 'hit' }); if (q.hp <= 0 && q.alive) die(q, p); }
      }
    }
  });

  ws.on('close', () => { if (p.in && p.alive) die(p, null); players.delete(p.id); });
});

server.listen(process.env.PORT || 3000, () => console.log('Servidor rodando'));

// The 3D office campus. In the middle, a glass stand-up room with a round table and a holographic
// globe; around it, one office floor per project; further out, one big café & lounge where the
// crews of every project meet: coffee counter, café tables, plants everywhere, sofas and a small
// play area (ping-pong, foosball). Every crew member has an emoji head that shows how they are:
//   green and smiling = free, red and focused = busy, amber = waiting for your review,
//   purple and dizzy = needs attention.
// Free people go to the café & lounge, visit a teammate or the water cooler; when work arrives
// they walk back to their desk. When a stand-up is being written, free people gather round the
// stand-up table.
// Click someone and the camera flies to them; they turn to you and wave, and the app pins a card.
import * as THREE from '/vendor/three.module.min.js';

// Desks follow the role list from the server (built-in roles first, then custom ones): two rows
// facing each other, with as many columns as it takes, squeezed to fit inside the walkway.
const deskRoles = (p, roles) => roles.filter(r => !p.activeRoles || !p.activeRoles.length || p.activeRoles.includes(r.id));
function deskSpot(i, n) {
  const cols = Math.max(3, Math.ceil(n / 2));
  const spacing = Math.min(3.2, 7.6 / (cols - 1));
  const c = i % cols;
  return { x: (c - (cols - 1) / 2) * spacing, side: i < cols ? -1 : 1, scale: Math.min(1, spacing / 2.7) };
}

// one project floor (zone-local units; the back wall is at -z, the way out at +z)
const ZONE_W = 12;
const ZONE_D = 9;
const FLOOR = 0.14;
const RING_A = 5.0;            // walkway round the desks (half width / half depth)
const RING_B = 3.2;
const RING_P = 4 * RING_A + 4 * RING_B;
// the campus
const ROOM_R = 4.3;            // stand-up room
const PLAZA_R = 6.6;           // walkway round the stand-up room
const SEAT_DROP = -0.25;
const WALK = 1.7;

const STATE_COLOR = { idle: '#22c55e', working: '#ef4444', queued: '#ef4444', review: '#f59e0b', failed: '#8b5cf6' };

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const mix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);
const rand = (a, b) => a + Math.random() * (b - a);
const pickOne = list => list[Math.floor(Math.random() * list.length)];
const angleLerp = (a, b, t) => { const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };
const angDiff = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
// The Settings page's motion choice (globalThis.devcrewUi, set by app.js) or the system setting.
const motionSetting = () => ((globalThis.devcrewUi || {}).motion) || 'full';
const reducedMotion = () => motionSetting() !== 'full' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionOff = () => motionSetting() === 'off';

/* ---------- the walkway ring inside a project floor (zone-local x/z) ---------- */

function ringParam(x, z) {
  const d = [Math.abs(z + RING_B), Math.abs(x - RING_A), Math.abs(z - RING_B), Math.abs(x + RING_A)];
  const e = d.indexOf(Math.min(...d));
  const cx = Math.max(-RING_A, Math.min(RING_A, x));
  const cz = Math.max(-RING_B, Math.min(RING_B, z));
  if (e === 0) return cx + RING_A;
  if (e === 1) return 2 * RING_A + (cz + RING_B);
  if (e === 2) return 2 * RING_A + 2 * RING_B + (RING_A - cx);
  return 4 * RING_A + 2 * RING_B + (RING_B - cz);
}
function ringPoint(t) {
  t = ((t % RING_P) + RING_P) % RING_P;
  if (t < 2 * RING_A) return [t - RING_A, -RING_B];
  t -= 2 * RING_A;
  if (t < 2 * RING_B) return [RING_A, t - RING_B];
  t -= 2 * RING_B;
  if (t < 2 * RING_A) return [RING_A - t, RING_B];
  t -= 2 * RING_A;
  return [-RING_A, RING_B - t];
}
const CORNERS = [0, 2 * RING_A, 2 * RING_A + 2 * RING_B, 4 * RING_A + 2 * RING_B];
function ringPath(t1, t2) {
  const fwd = (t2 - t1 + RING_P) % RING_P;
  const back = (t1 - t2 + RING_P) % RING_P;
  const out = [];
  if (fwd <= back) {
    CORNERS.map(c => [c, (c - t1 + RING_P) % RING_P]).filter(([, d]) => d > 0.01 && d < fwd).sort((a, b) => a[1] - b[1]).forEach(([c]) => out.push(ringPoint(c)));
  } else {
    CORNERS.map(c => [c, (t1 - c + RING_P) % RING_P]).filter(([, d]) => d > 0.01 && d < back).sort((a, b) => a[1] - b[1]).forEach(([c]) => out.push(ringPoint(c)));
  }
  out.push(ringPoint(t2));
  return out;
}

/* ---------- textures drawn on a canvas ---------- */

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** An emoji face, drawn so it sits on the front (+z) of a sphere. */
function faceTexture(state) {
  return canvasTex(512, 256, (g, W, H) => {
    g.fillStyle = STATE_COLOR[state];
    g.fillRect(0, 0, W, H);
    const cx = W * 0.25;
    const ey = H * 0.43;
    const ink = '#3b2314';
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineCap = 'round';
    g.lineWidth = 7;
    const eye = dx => { g.beginPath(); g.ellipse(cx + dx, ey, 7, 10, 0, 0, Math.PI * 2); g.fill(); };
    if (state === 'idle') {
      eye(-24); eye(24);
      g.beginPath(); g.arc(cx, H * 0.53, 26, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.fillStyle = 'rgba(255,120,120,0.45)';
      g.beginPath(); g.arc(cx - 42, H * 0.55, 9, 0, Math.PI * 2); g.arc(cx + 42, H * 0.55, 9, 0, Math.PI * 2); g.fill();
    } else if (state === 'working' || state === 'queued') {
      eye(-24); eye(24);
      g.lineWidth = 6;
      g.beginPath(); g.moveTo(cx - 38, ey - 22); g.lineTo(cx - 12, ey - 14); g.moveTo(cx + 38, ey - 22); g.lineTo(cx + 12, ey - 14); g.stroke();
      g.beginPath(); g.moveTo(cx - 18, H * 0.66); g.lineTo(cx + 18, H * 0.66); g.stroke();
      g.fillStyle = '#7dd3fc';
      g.beginPath(); g.moveTo(cx + 50, ey - 10); g.quadraticCurveTo(cx + 60, ey + 8, cx + 50, ey + 12); g.quadraticCurveTo(cx + 40, ey + 8, cx + 50, ey - 10); g.fill();
    } else if (state === 'review') {
      g.beginPath(); g.ellipse(cx - 24, ey, 9, 11, 0, 0, Math.PI * 2); g.ellipse(cx + 24, ey, 9, 11, 0, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.fillStyle = ink; g.beginPath(); g.arc(cx - 20, ey + 2, 5, 0, Math.PI * 2); g.arc(cx + 28, ey + 2, 5, 0, Math.PI * 2); g.fill();
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(cx + 12, ey - 24); g.quadraticCurveTo(cx + 26, ey - 32, cx + 38, ey - 22); g.stroke();
      g.beginPath(); g.arc(cx, H * 0.64, 9, 0, Math.PI * 2); g.stroke();
    } else {
      g.lineWidth = 6;
      for (const dx of [-24, 24]) { g.beginPath(); g.moveTo(cx + dx - 9, ey - 9); g.lineTo(cx + dx + 9, ey + 9); g.moveTo(cx + dx + 9, ey - 9); g.lineTo(cx + dx - 9, ey + 9); g.stroke(); }
      g.beginPath(); g.moveTo(cx - 24, H * 0.66);
      for (let i = 1; i <= 6; i++) g.lineTo(cx - 24 + i * 8, H * 0.66 + (i % 2 ? -6 : 6));
      g.stroke();
    }
  });
}

/** A monitor screen for a state: code while working, a tick for review, a warning, or idle. */
function screenTexture(kind) {
  return canvasTex(256, 160, (g, W, H) => {
    g.fillStyle = kind === 'failed' ? '#2a0f14' : '#0d1424';
    g.fillRect(0, 0, W, H);
    if (kind === 'code') {
      const cols = ['#7dd3fc', '#a5b4fc', '#86efac', '#fcd34d', '#f9a8d4', '#cbd5e1'];
      for (let y = 8; y < H; y += 9) {
        let x = 10 + Math.floor(Math.random() * 4) * 9;
        for (let i = 0; i < 1 + Math.floor(Math.random() * 4) && x < W - 12; i++) {
          const w = 10 + Math.random() * 46;
          g.fillStyle = pickOne(cols);
          g.fillRect(x, y, Math.min(w, W - 12 - x), 4);
          x += w + 6;
        }
      }
    } else if (kind === 'review') {
      g.strokeStyle = '#f59e0b'; g.lineWidth = 12; g.lineCap = 'round';
      g.beginPath(); g.moveTo(W * 0.36, H * 0.52); g.lineTo(W * 0.47, H * 0.64); g.lineTo(W * 0.66, H * 0.38); g.stroke();
    } else if (kind === 'failed') {
      g.fillStyle = '#f87171';
      g.beginPath(); g.moveTo(W / 2, H * 0.22); g.lineTo(W * 0.68, H * 0.74); g.lineTo(W * 0.32, H * 0.74); g.closePath(); g.fill();
      g.fillStyle = '#2a0f14'; g.fillRect(W / 2 - 4, H * 0.38, 8, H * 0.2); g.fillRect(W / 2 - 4, H * 0.62, 8, 8);
    } else {
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, '#1e3a8a'); grd.addColorStop(1, '#0f766e');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.fillText('>_', W / 2, H / 2 + 10);
    }
  });
}

function signTexture(text) {
  return canvasTex(512, 96, (g, W, H) => {
    g.fillStyle = '#1f2937'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff'; g.font = 'bold 46px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(text).slice(0, 22), W / 2, H / 2 + 2);
  });
}

/** The whiteboard: sticky notes for queued, running and review work. */
function boardTexture(todo, doing, review) {
  return canvasTex(512, 256, (g, W, H) => {
    g.fillStyle = '#f8fafc'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#94a3b8'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
    const cols = [['To do', todo, '#fde68a'], ['Doing', doing, '#fca5a5'], ['Review', review, '#bbf7d0']];
    g.font = 'bold 26px sans-serif'; g.textAlign = 'center';
    cols.forEach(([label, n, color], i) => {
      const x0 = 12 + i * (W - 24) / 3;
      g.fillStyle = '#334155'; g.fillText(label, x0 + (W - 24) / 6, 40);
      for (let k = 0; k < Math.min(n, 6); k++) {
        g.fillStyle = color;
        g.fillRect(x0 + 14 + (k % 2) * 70, 60 + Math.floor(k / 2) * 62, 58, 52);
      }
      if (n > 6) { g.fillStyle = '#334155'; g.fillText(`+${n - 6}`, x0 + (W - 24) / 6, 240); }
    });
  });
}

/* ---------- small geometry helpers ---------- */

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function slab(w, d, h, r, mat) {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, d, r), { depth: h, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}
const GEO = new Map();
const geo = (key, make) => { if (!GEO.has(key)) GEO.set(key, make()); return GEO.get(key); };
function box(w, h, d, mat, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 16, cast = true) {
  const m = new THREE.Mesh(geo(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
function ball(r, mat, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(geo(`s${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4))), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export function createOffice(host, { onAgent, onZone, onHub, quality = 'high' }) {
  // high: sharp, soft shadows; medium: standard resolution, plain shadows; low: no shadows or
  // antialiasing, for slow laptops and remote desktops.
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.domElement.className = 'office-canvas';
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'The 3D office. Tab to a name tag to open that person, floor or room; Settings has a simple 2D view.');
  host.appendChild(renderer.domElement);

  const labels = document.createElement('div');
  labels.className = 'office-labels';
  host.appendChild(labels);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -800, 800);
  const OFFSET = new THREE.Vector3(1, 0.95, 1).normalize().multiplyScalar(200);
  const target = new THREE.Vector3();
  let halfH = 20;
  let zoomGoal = null;

  scene.add(new THREE.HemisphereLight('#ffffff', '#8b93a6', 1.55));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.3);
  sun.position.set(-40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 220 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const M = {
    grass: new THREE.MeshStandardMaterial({ color: '#a7d39a', roughness: 1 }),
    paving: new THREE.MeshStandardMaterial({ color: '#e7e2d8', roughness: 0.95 }),
    path: new THREE.MeshStandardMaterial({ color: '#d8d2c6', roughness: 0.95 }),
    desk: new THREE.MeshStandardMaterial({ color: '#efe6d6', roughness: 0.6 }),
    oak: new THREE.MeshStandardMaterial({ color: '#c79a63', roughness: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ color: '#9ca3af', roughness: 0.35, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.4, metalness: 0.2 }),
    white: new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.6 }),
    carpet: new THREE.MeshStandardMaterial({ color: '#dbe2ea', roughness: 1 }),
    glass: new THREE.MeshStandardMaterial({ color: '#bfe3ff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.28 }),
    frame: new THREE.MeshStandardMaterial({ color: '#64748b', roughness: 0.4, metalness: 0.5 }),
    pot: new THREE.MeshStandardMaterial({ color: '#e7e5e4', roughness: 0.8 }),
    terracotta: new THREE.MeshStandardMaterial({ color: '#c2410c', roughness: 0.9 }),
    leaf: new THREE.MeshStandardMaterial({ color: '#3f8f4f', roughness: 0.9, flatShading: true }),
    leaf2: new THREE.MeshStandardMaterial({ color: '#65a30d', roughness: 0.9, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: '#7c5a3a', roughness: 1 }),
    water: new THREE.MeshStandardMaterial({ color: '#7cc4f5', roughness: 0.1, transparent: true, opacity: 0.8 }),
    orange: new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.45 }),
    green: new THREE.MeshStandardMaterial({ color: '#16a34a', roughness: 0.4 }),
    paper: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }),
    trousers: new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.8 }),
    shoe: new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.6 }),
    hand: new THREE.MeshStandardMaterial({ color: '#f1c9a5', roughness: 0.7 }),
    field: new THREE.MeshStandardMaterial({ color: '#7fbf6a', roughness: 1 }),   // foosball pitch
    bat: new THREE.MeshStandardMaterial({ color: '#e9cf9b', roughness: 0.6 }),     // paddle handle
    tile: new THREE.MeshStandardMaterial({ color: '#f1e9dc', roughness: 0.9 }),
    red: new THREE.MeshStandardMaterial({ color: '#dc2626', roughness: 0.5 }),
    flowers: ['#f472b6', '#facc15', '#a78bfa', '#fb7185', '#f97316'].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })),
    lampGlow: new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: '#ffe9a8', emissiveIntensity: 0.9 }),
  };
  const FACE = { idle: faceTexture('idle'), working: faceTexture('working'), queued: faceTexture('queued'), review: faceTexture('review'), failed: faceTexture('failed') };
  const SCREEN = { code: screenTexture('code'), review: screenTexture('review'), failed: screenTexture('failed'), idle: screenTexture('idle') };
  const screenMat = Object.fromEntries(Object.entries(SCREEN).map(([k, t]) => [k, new THREE.MeshBasicMaterial({ map: t })]));
  SCREEN.code.wrapS = SCREEN.code.wrapT = THREE.RepeatWrapping;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), M.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  /* ---------------- furniture ---------------- */

  function makeDesk(roleColor, i) {
    const g = new THREE.Group();
    g.add(box(2.3, 0.07, 1.1, M.desk, 0, 0.78, 0));
    for (const sx of [-1.05, 1.05]) g.add(box(0.06, 0.75, 0.95, M.metal, sx, 0.38, 0));
    // The person sits on the desk's +z side: keyboard near them, monitors at the back facing them.
    g.add(box(0.62, 0.03, 0.2, M.white, 0, 0.83, 0.22, false));
    g.add(box(0.1, 0.03, 0.14, M.white, 0.48, 0.83, 0.22, false));
    const screens = [];
    for (const [sx, ry] of [[-0.5, -0.18], [0.5, 0.18]]) {
      const mon = new THREE.Group();
      mon.position.set(sx, 0.82, -0.3);
      mon.rotation.y = ry;
      mon.add(box(0.08, 0.28, 0.08, M.dark, 0, 0.14, -0.04));
      mon.add(box(0.92, 0.56, 0.05, M.dark, 0, 0.55, 0));
      const screen = new THREE.Mesh(geo('screen', () => new THREE.PlaneGeometry(0.84, 0.48)), screenMat.idle);
      screen.position.set(0, 0.55, 0.03);
      mon.add(screen);
      g.add(mon);
      screens.push(screen);
    }
    // personal touches: a mug, a lamp on some desks, a little cactus on others
    g.add(cyl(0.06, 0.05, 0.12, new THREE.MeshStandardMaterial({ color: roleColor, roughness: 0.5 }), -0.85, 0.88, 0.25, 12));
    if (i % 2 === 0) {
      g.add(cyl(0.12, 0.12, 0.03, M.dark, 0.95, 0.83, -0.3, 12));
      g.add(box(0.03, 0.42, 0.03, M.dark, 0.95, 1.04, -0.3));
      g.add(cyl(0.05, 0.14, 0.14, M.lampGlow, 0.95, 1.26, -0.2, 12));
    } else {
      g.add(cyl(0.07, 0.06, 0.08, M.terracotta, 0.95, 0.86, -0.3, 10));
      g.add(cyl(0.045, 0.045, 0.16, M.leaf, 0.95, 0.98, -0.3, 8));
    }
    return { group: g, screens };
  }

  /** An office chair like the stand-up room's: cushioned seat and back, five wheels. */
  function makeChair(color) {
    const g = new THREE.Group();
    const cushion = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const seat = slab(0.66, 0.66, 0.12, 0.12, cushion);
    seat.position.y = 0.5;
    seat.castShadow = true;
    g.add(seat);
    const back = slab(0.62, 0.7, 0.1, 0.12, cushion);
    back.rotation.x = Math.PI / 2 - 0.12;
    back.position.set(0, 1.0, -0.34);
    back.castShadow = true;
    g.add(back);
    for (const sx of [-0.35, 0.35]) g.add(box(0.04, 0.04, 0.42, M.metal, sx, 0.72, -0.04));
    g.add(cyl(0.04, 0.04, 0.42, M.metal, 0, 0.28, 0, 8));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const leg = box(0.32, 0.03, 0.05, M.metal, Math.cos(a) * 0.16, 0.07, Math.sin(a) * 0.16, false);
      leg.rotation.y = -a;
      g.add(leg);
      g.add(ball(0.04, M.dark, Math.cos(a) * 0.32, 0.04, Math.sin(a) * 0.32, 8));
    }
    return g;
  }

  function makePlant(kind = 0) {
    const g = new THREE.Group();
    if (kind === 1) {
      g.add(cyl(0.3, 0.24, 0.5, M.pot, 0, 0.25, 0, 14));
      for (let k = 0; k < 6; k++) {
        const leaf = new THREE.Mesh(geo('leafblade', () => new THREE.ConeGeometry(0.08, 0.9, 5)), M.leaf2);
        const a = (k / 6) * Math.PI * 2;
        leaf.position.set(Math.cos(a) * 0.1, 0.9, Math.sin(a) * 0.1);
        leaf.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
        leaf.castShadow = true;
        g.add(leaf);
      }
    } else {
      g.add(cyl(0.28, 0.22, 0.45, M.pot, 0, 0.22, 0, 14));
      for (let k = 0; k < 3; k++) {
        const leaf = new THREE.Mesh(geo(`bush${k}`, () => new THREE.IcosahedronGeometry(0.34 - k * 0.06, 0)), M.leaf);
        leaf.position.set((k - 1) * 0.12, 0.66 + k * 0.24, (k % 2) * 0.08);
        leaf.castShadow = true;
        g.add(leaf);
      }
    }
    g.userData.sway = true;
    return g;
  }
  function makeTree(h = 2.6) {
    const g = new THREE.Group();
    g.add(cyl(0.12, 0.18, h * 0.5, M.trunk, 0, h * 0.25, 0, 8));
    for (let k = 0; k < 3; k++) {
      const c = new THREE.Mesh(geo(`tree${k}`, () => new THREE.IcosahedronGeometry(0.9 - k * 0.2, 0)), k % 2 ? M.leaf2 : M.leaf);
      c.position.set(rand(-0.15, 0.15), h * 0.55 + k * 0.5, rand(-0.15, 0.15));
      c.castShadow = true;
      g.add(c);
    }
    g.userData.sway = true;
    return g;
  }
  function makeCooler() {
    const g = new THREE.Group();
    g.add(box(0.5, 0.95, 0.45, M.white, 0, 0.475, 0));
    g.add(cyl(0.2, 0.2, 0.5, M.water, 0, 1.2, 0, 16));
    return g;
  }
  function makeBench() {
    const g = new THREE.Group();
    for (let k = 0; k < 3; k++) g.add(box(1.6, 0.05, 0.14, M.oak, 0, 0.45, -0.18 + k * 0.18));
    g.add(box(1.6, 0.36, 0.05, M.oak, 0, 0.75, -0.3));
    for (const sx of [-0.7, 0.7]) g.add(box(0.06, 0.45, 0.5, M.dark, sx, 0.22, -0.05));
    return g;
  }

  /* ---------------- people with emoji heads ---------------- */

  function makeFigure(color) {
    const root = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const legs = [];
    for (const sx of [-0.12, 0.12]) {
      const hip = new THREE.Group();
      hip.position.set(sx, 0.82, 0);
      const leg = new THREE.Mesh(geo('leg', () => new THREE.CapsuleGeometry(0.09, 0.48, 4, 10)), M.trousers);
      leg.position.y = -0.34;
      leg.castShadow = true;
      hip.add(leg);
      hip.add(box(0.15, 0.08, 0.26, M.shoe, 0, -0.77, 0.05));
      root.add(hip);
      legs.push(hip);
    }
    const body = new THREE.Mesh(geo('torso', () => {
      const g = new THREE.CapsuleGeometry(0.26, 0.4, 6, 16);
      g.scale(1, 1, 0.82);
      return g;
    }), bodyMat);
    body.position.y = 1.24;
    body.castShadow = true;
    root.add(body);
    // a lanyard badge in a lighter shade of the role colour
    const badge = box(0.12, 0.15, 0.02, new THREE.MeshStandardMaterial({ color: mix(color, '#ffffff', 0.6) }), 0.1, 1.28, 0.22, false);
    root.add(badge);
    const head = new THREE.Group();
    head.position.y = 1.97;
    root.add(head);
    const faceMat = new THREE.MeshStandardMaterial({ map: FACE.idle, roughness: 0.45 });
    const skull = new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.31, 32, 20)), faceMat);
    skull.castShadow = true;
    head.add(skull);
    const arms = [];
    for (const sx of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(sx * 0.31, 1.56, 0.02);
      const arm = new THREE.Mesh(geo('arm', () => new THREE.CapsuleGeometry(0.07, 0.38, 4, 8)), bodyMat);
      arm.position.y = -0.25;
      arm.castShadow = true;
      sh.add(arm);
      sh.add(ball(0.075, M.hand, 0, -0.5, 0, 10));
      root.add(sh);
      arms.push(sh);
    }
    // things they hold
    const cup = cyl(0.06, 0.05, 0.13, M.white, 0, -0.56, 0.08, 10);
    cup.visible = false;
    arms[1].add(cup);
    // a table-tennis paddle: red face on a wooden handle
    const paddle = new THREE.Group();
    const face = cyl(0.11, 0.11, 0.02, M.red, 0, -0.14, 0, 16);
    face.rotation.x = Math.PI / 2;
    paddle.add(face);
    paddle.add(box(0.035, 0.12, 0.025, M.bat, 0, -0.01, 0));
    paddle.position.set(0, -0.52, 0.06);
    paddle.visible = false;
    arms[1].add(paddle);
    return { root, legs, body, head, arms, bodyMat, faceMat, cup, paddle };
  }

  /* ---------------- the stand-up room and its globe ---------------- */

  const room = new THREE.Group();
  scene.add(room);
  const plaza = slab(2 * (PLAZA_R + 1.3), 2 * (PLAZA_R + 1.3), 0.06, PLAZA_R + 1.29, M.paving);
  room.add(plaza);
  const roomFloor = new THREE.Mesh(new THREE.CylinderGeometry(ROOM_R, ROOM_R, 0.12, 64), M.oak);
  roomFloor.position.y = 0.06;
  roomFloor.receiveShadow = true;
  room.add(roomFloor);
  // glass walls with four doors (at 45°, 135°, 225°, 315°)
  const DOORS = [0.25, 0.75, 1.25, 1.75].map(k => k * Math.PI);
  for (let k = 0; k < 4; k++) {
    // angles here are measured like the rest of the campus: x = cos(a), z = sin(a)
    const from = DOORS[k] + 0.28;
    const to = DOORS[(k + 1) % 4] + (k === 3 ? 2 * Math.PI : 0) - 0.28;
    // a cylinder measures its angle from +z towards +x (x = sin θ, z = cos θ): θ = π/2 − a
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(ROOM_R, ROOM_R, 1.5, 40, 1, true, Math.PI / 2 - to, to - from), M.glass);
    wall.position.y = 0.87;
    room.add(wall);
    // a torus lies in the xy plane from angle 0; turned flat (x = cos, z = sin) and started at "from"
    const rail = new THREE.Mesh(new THREE.TorusGeometry(ROOM_R, 0.03, 6, 40, to - from), M.frame);
    rail.rotation.set(Math.PI / 2, 0, from);
    rail.position.y = 1.62;
    room.add(rail);
  }
  // the round orange table on an X base, with green chairs round it (as in the stand-up room
  // reference: mugs, papers and a pencil cup on the table)
  const table = cyl(1.3, 1.3, 0.12, M.orange, 0, 1.0, 0, 48);
  room.add(table);
  for (const r of [0, Math.PI / 2]) {
    const foot = box(1.6, 0.5, 0.18, M.orange, 0, 0.25, 0);
    foot.rotation.y = r;
    room.add(foot);
  }
  room.add(cyl(0.22, 0.22, 0.75, M.orange, 0, 0.6, 0, 16));
  const STAND_SEATS = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const chair = makeChair('#16a34a');
    chair.position.set(Math.cos(a) * 2.05, 0.12, Math.sin(a) * 2.05);
    chair.rotation.y = -a - Math.PI / 2;
    room.add(chair);
    const paper = box(0.42, 0.01, 0.32, M.paper, Math.cos(a) * 0.95, 1.065, Math.sin(a) * 0.95, false);
    paper.rotation.y = -a;
    room.add(paper);
    if (k % 2) room.add(cyl(0.06, 0.05, 0.12, new THREE.MeshStandardMaterial({ color: ['#38bdf8', '#a3e635', '#fde047', '#f472b6'][k % 4] }), Math.cos(a + 0.3) * 0.7, 1.12, Math.sin(a + 0.3) * 0.7, 10));
    STAND_SEATS.push({ area: 'room', pos: new THREE.Vector3(Math.cos(a) * 2.05, 0, Math.sin(a) * 2.05), facing: Math.atan2(-Math.cos(a), -Math.sin(a)), sit: true, pose: 'sit', taken: null, ang: a });
  }
  room.add(cyl(0.16, 0.14, 0.26, new THREE.MeshStandardMaterial({ color: '#a855f7' }), 0.35, 1.19, -0.25, 12));
  for (let k = 0; k < 5; k++) {
    const pencil = cyl(0.018, 0.018, 0.34, M.flowers[k], 0.35 + Math.cos(k * 1.3) * 0.07, 1.33, -0.25 + Math.sin(k * 1.3) * 0.07, 6);
    pencil.rotation.z = (k - 2) * 0.08;
    room.add(pencil);
  }
  // the holographic globe above the table
  const globe = new THREE.Group();
  globe.position.set(0, 2.55, 0);
  room.add(globe);
  const projector = cyl(0.32, 0.38, 0.12, M.dark, 0, 1.12, 0, 24);
  room.add(projector);
  const beamMat = new THREE.MeshBasicMaterial({ color: '#60a5fa', transparent: true, opacity: 0.12, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.3, 1.05, 24, 1, true), beamMat);
  beam.position.y = 1.7;
  room.add(beam);
  const coreMat = new THREE.MeshStandardMaterial({ color: '#2563eb', emissive: '#3b82f6', emissiveIntensity: 0.45, roughness: 0.2, transparent: true, opacity: 0.55 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.62, 40, 28), coreMat);
  globe.add(core);
  const gridMat = new THREE.MeshBasicMaterial({ color: '#93c5fd', wireframe: true, transparent: true, opacity: 0.55 });
  const grid = new THREE.Mesh(new THREE.SphereGeometry(0.66, 18, 12), gridMat);
  globe.add(grid);
  const equator = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.018, 8, 64), new THREE.MeshBasicMaterial({ color: '#a5b4fc', transparent: true, opacity: 0.8 }));
  equator.rotation.x = Math.PI / 2 - 0.35;
  globe.add(equator);
  let orbits = []; // one glowing light per project, in its stand-up health colour
  const hubPick = { kind: 'hub' };
  for (const o of [table, roomFloor, core, grid, projector]) o.userData.pick = hubPick;

  /* ---------------- zones, places and agents ---------------- */

  let zones = [];
  let places = {};   // the café & lounge
  let zoneKey = '';
  const agents = new Map();
  const pickables = [];
  const agentLabels = new Map();
  const zoneLabels = new Map();
  const placeLabels = [];
  const hubLabel = document.createElement('div');
  hubLabel.className = 'ol-hub';
  hubLabel.addEventListener('click', () => onHub && onHub());
  keyable(hubLabel);
  labels.appendChild(hubLabel);
  const builtStatic = [];

  /** Project floors on a ring round the stand-up room. */
  function layout(n) {
    if (n === 1) return [-Math.PI / 2];
    return Array.from({ length: n }, (_, i) => -Math.PI / 2 - Math.PI / 4 + (i * 2 * Math.PI) / n);
  }
  const zoneRadius = n => Math.max(15, 8.2 / Math.sin(Math.PI / Math.max(n, 2)));

  /** Angles for shared places: as far as possible from the project floors. */
  function placeAngles(zoneAngs) {
    const used = [...zoneAngs];
    const out = [];
    for (let k = 0; k < 3; k++) {
      let best = 0;
      let bestD = -1;
      for (let s = 0; s < 72; s++) {
        const a = (s / 72) * Math.PI * 2;
        const d = Math.min(...used.map(u => angDiff(a, u)));
        if (d > bestD) { bestD = d; best = a; }
      }
      used.push(best);
      out.push(best);
    }
    return out;
  }

  // Zone and place groups are rotated; these convert between their local plan and the world.
  const rotXZ = (x, z, r) => [x * Math.cos(r) + z * Math.sin(r), -x * Math.sin(r) + z * Math.cos(r)];
  const W = (area, lx, lz) => { const [x, z] = rotXZ(lx, lz, area.rot); return new THREE.Vector3(area.pos.x + x, 0, area.pos.z + z); };
  const toLocal = (area, p) => rotXZ(p.x - area.pos.x, p.z - area.pos.z, -area.rot);

// Name tags that open something are buttons for the keyboard too (Tab to them, Enter opens).
  function keyable(el) { el.tabIndex = 0; el.setAttribute('role', 'button'); }

  const collect = root => { const out = []; root.traverse(o => { if (o.isMesh) out.push(o); }); return out; };

  function label(className, html, onClick) {
    const d = document.createElement('div');
    d.className = className;
    d.innerHTML = html;
    if (onClick) { d.addEventListener('click', onClick); keyable(d); }
    else d.style.pointerEvents = 'none';
    labels.appendChild(d);
    return d;
  }

  function buildZones(projects, roles) {
    for (const z of zones) scene.remove(z.group);
    for (const p of Object.values(places)) scene.remove(p.group);
    for (const o of builtStatic) scene.remove(o);
    builtStatic.length = 0;
    for (const a of agents.values()) scene.remove(a.fig.root);
    for (const o of orbits) globe.remove(o.mesh);
    orbits = [];
    zones = [];
    places = {};
    agents.clear();
    pickables.length = 0;
    pickables.push(...collect(room).filter(m => m.userData.pick));
    for (const d of [...agentLabels.values(), ...zoneLabels.values(), ...placeLabels]) d.remove();
    agentLabels.clear();
    zoneLabels.clear();
    placeLabels.length = 0;
    for (const s of STAND_SEATS) s.taken = null;

    const angs = layout(projects.length);
    const R = zoneRadius(projects.length);
    projects.forEach((p, pi) => {
      const ang = angs[pi];
      const zpos = new THREE.Vector3(Math.cos(ang) * R, 0, Math.sin(ang) * R);
      // turn the floor so its back wall faces away from the stand-up room (in quarter turns)
      let rot = 0;
      let best = -2;
      for (const r of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) {
        const d = -Math.sin(r) * Math.cos(ang) + -Math.cos(r) * Math.sin(ang);
        if (d > best) { best = d; rot = r; }
      }
      const group = new THREE.Group();
      group.position.copy(zpos);
      group.rotation.y = rot;
      scene.add(group);
      const rimMat = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.6 });
      const floorMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.95 });
      const rim = slab(ZONE_W + 0.35, ZONE_D + 0.35, 0.1, 0.9, rimMat);
      const floor = slab(ZONE_W, ZONE_D, FLOOR, 0.75, floorMat);
      const carpet = slab(2 * RING_A - 0.4, 2 * RING_B - 0.6, 0.02, 0.4, M.carpet);
      carpet.position.y = FLOOR;
      group.add(rim, floor, carpet);
      const zonePick = { kind: 'zone', projectId: p.id };
      for (const m of [rim, floor, carpet]) { m.userData.pick = zonePick; pickables.push(m); }

      // the back wall: glass partition, the project's sign and the task whiteboard
      const bz = -ZONE_D / 2 + 0.12;
      const wall = box(ZONE_W - 0.6, 1.9, 0.08, M.glass, 0, FLOOR + 0.95, bz, false);
      group.add(wall);
      group.add(box(ZONE_W - 0.6, 0.06, 0.1, M.frame, 0, FLOOR + 1.9, bz, false));
      const signMat = new THREE.MeshBasicMaterial({ map: signTexture(p.name) });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.52), signMat);
      sign.position.set(-2.6, FLOOR + 1.55, bz + 0.06);
      group.add(sign);
      const boardMat = new THREE.MeshBasicMaterial({ map: boardTexture(0, 0, 0) });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), boardMat);
      board.position.set(2.4, FLOOR + 1.15, bz + 0.06);
      group.add(board);
      group.add(box(2.5, 0.06, 0.12, M.frame, 2.4, FLOOR + 0.52, bz + 0.06));
      // corner furniture: plants, water cooler, printer, bookshelf
      const plantA = makePlant(0);
      plantA.position.set(-ZONE_W / 2 + 0.5, FLOOR, -ZONE_D / 2 + 0.6);
      const plantB = makePlant(1);
      plantB.position.set(ZONE_W / 2 - 0.5, FLOOR, ZONE_D / 2 - 0.5);
      const plantC = makePlant(1);
      plantC.position.set(-ZONE_W / 2 + 0.5, FLOOR, ZONE_D / 2 - 0.5);
      const cooler = makeCooler();
      cooler.position.set(ZONE_W / 2 - 0.5, FLOOR, -ZONE_D / 2 + 0.6);
      group.add(plantA, plantB, plantC, cooler);
      const printer = new THREE.Group();
      printer.add(box(0.7, 0.6, 0.55, M.white, 0, 0.3, 0));
      printer.add(box(0.5, 0.04, 0.3, M.dark, 0, 0.62, 0.05));
      printer.position.set(-ZONE_W / 2 + 0.5, FLOOR, 0.9);
      printer.rotation.y = Math.PI / 2;
      group.add(printer);
      const shelf = new THREE.Group();
      shelf.add(box(1.2, 1.4, 0.4, M.oak, 0, 0.7, 0));
      for (let s = 0; s < 3; s++) for (let b = 0; b < 6; b++) {
        shelf.add(box(0.12, 0.3, 0.3, M.flowers[(b + s) % 5], -0.45 + b * 0.18, 0.28 + s * 0.42, 0.06, false));
      }
      shelf.position.set(ZONE_W / 2 - 0.45, FLOOR, -0.6);
      shelf.rotation.y = -Math.PI / 2;
      group.add(shelf);

      const zone = { id: p.id, kind: 'zone', ang, pos: zpos, rot, group, rimMat, floorMat, boardMat, boardSig: '', cooler: [RING_A + 0.2, -RING_B - 0.55] };
      const [ex, ez] = toLocal(zone, new THREE.Vector3(0, 0, 0));
      zone.exitT = ringParam(ex, ez);
      zones.push(zone);

      // A role the project does not use gets no desk.
      const crew = deskRoles(p, roles);
      crew.forEach((role, i) => {
        const roleId = role.id;
        const { x, side, scale } = deskSpot(i, crew.length);
        const desk = makeDesk(role.color, i);
        desk.group.position.set(x, FLOOR, side * 0.78);
        desk.group.rotation.y = side === -1 ? Math.PI : 0;
        desk.group.scale.setScalar(scale);
        group.add(desk.group);
        const localFacing = side === -1 ? 0 : Math.PI;
        const chair = makeChair(role.color);
        chair.position.set(x, FLOOR, side * 2.0);
        chair.rotation.y = localFacing;
        group.add(chair);

        const fig = makeFigure(role.color);
        scene.add(fig.root);
        const seatW = W(zone, x, side * 2.0);
        const a = {
          key: `${p.id}:${roleId}`, pid: p.id, role: roleId, zone, fig, screens: desk.screens,
          seat: { x, z: side * 2.0, facing: localFacing + rot, aisleT: ringParam(x, side * RING_B) },
          pos: seatW.clone(), heading: localFacing + rot, sit: 1, sitGoal: 1,
          where: 'zone', loc: 'seat', spot: null,
          path: [], dest: null, timer: rand(1, 5), phase: Math.random() * 10, walkPhase: 0,
          state: 'idle', prevState: 'idle', focused: false, wave: 0, lookAt: null, pose: null,
        };
        const pick = { kind: 'agent', projectId: p.id, role: roleId };
        for (const g of [fig.root, desk.group, chair]) g.traverse(o => { o.userData.pick = pick; });
        pickables.push(...collect(fig.root), ...collect(desk.group), ...collect(chair));
        agents.set(a.key, a);

        const lab = document.createElement('div');
        lab.className = 'ol-agent';
        lab.style.setProperty('--rc', role.color);
        lab.addEventListener('click', () => onAgent && onAgent(p.id, roleId));
        keyable(lab);
        labels.appendChild(lab);
        agentLabels.set(a.key, lab);
      });

      const zl = document.createElement('div');
      zl.className = 'ol-zone';
      zl.addEventListener('click', () => onZone && onZone(p.id));
      keyable(zl);
      labels.appendChild(zl);
      zoneLabels.set(p.id, zl);

      const orb = { id: p.id, mesh: ball(0.09, new THREE.MeshBasicMaterial({ color: '#94a3b8' }), 0, 0, 0, 12), offset: (pi / Math.max(1, projects.length)) * Math.PI * 2 };
      globe.add(orb.mesh);
      orbits.push(orb);

      // a paved path from the plaza to the floor's way out
      addPath(ang, PLAZA_R + 1.2, R - 4.8);
    });

    const pAngs = placeAngles(angs);
    const RP = R + 15;
    places.lounge = buildLounge(pAngs[0], RP + 3);
    for (const pl of Object.values(places)) {
      addPath(pl.ang, PLAZA_R + 1.2, pl.radius - pl.depth / 2 - 0.2);
      placeLabels.push(label('ol-zone ol-place', pl.label));
      pl.labelEl = placeLabels[placeLabels.length - 1];
    }
    buildCat();
    swayers = [];
    scene.traverse(o => { if (o.userData.sway) swayers.push(o); });
    fit();
  }
  let swayers = [];

  function addPath(ang, r0, r1) {
    const len = r1 - r0;
    if (len <= 0) return;
    const p = box(1.6, 0.04, len, M.path, 0, 0.02, 0, false);
    p.castShadow = false;
    const mid = (r0 + r1) / 2;
    p.position.set(Math.cos(ang) * mid, 0.02, Math.sin(ang) * mid);
    p.rotation.y = -ang + Math.PI / 2;
    scene.add(p);
    builtStatic.push(p);
  }

  /** A place on the outer ring, turned so its entrance (local +z) faces the plaza. */
  function placeBase(ang, radius, w, d) {
    const pos = new THREE.Vector3(Math.cos(ang) * radius, 0, Math.sin(ang) * radius);
    const rot = Math.atan2(-Math.cos(ang), -Math.sin(ang));
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = rot;
    scene.add(group);
    return { ang, radius, pos, rot, group, depth: d, width: w, spots: [] };
  }
  const spotAt = (pl, lx, lz, facingLocal, sit, pose) => ({ area: pl.kind, place: pl, pos: W(pl, lx, lz), facing: facingLocal + pl.rot, sit, pose, taken: null });

  /**
   * The café & lounge: one big shared place where the crews of every project meet. A coffee
   * counter, café tables, plants everywhere, a lounge corner and a small play area with a
   * ping-pong table and a foosball table. Local plan: entrance at +z, counter at the back (-z).
   */
  function buildLounge(ang, radius) {
    const pl = placeBase(ang, radius, 20, 14);
    pl.kind = 'lounge';
    pl.label = '☕ Café &amp; lounge';
    pl.group.add(slab(20, 14, 0.08, 0.8, M.tile));
    const rug = slab(6.4, 5.2, 0.02, 0.4, new THREE.MeshStandardMaterial({ color: '#c4b5fd', roughness: 1 }));
    rug.position.set(4.2, 0.08, -2.4);
    pl.group.add(rug);
    const playMat = slab(5.6, 9.6, 0.02, 0.4, new THREE.MeshStandardMaterial({ color: '#93c5fd', roughness: 1 }));
    playMat.position.set(7.0, 0.08, 1.2);
    pl.group.add(playMat);

    // the coffee counter along the back, with a coffee machine, a fridge and a menu board
    pl.group.add(box(8, 1.0, 0.8, M.oak, -4.5, 0.5, -6.1));
    pl.group.add(box(8.1, 0.06, 0.9, M.white, -4.5, 1.03, -6.1));
    const machine = new THREE.Group();
    machine.add(box(0.6, 0.7, 0.5, M.dark, 0, 0.35, 0));
    machine.add(box(0.4, 0.08, 0.3, M.metal, 0, 0.12, 0.1));
    machine.position.set(-7.4, 1.06, -6.15);
    pl.group.add(machine);
    for (let k = 0; k < 4; k++) pl.group.add(cyl(0.06, 0.05, 0.12, M.white, -6.5 + k * 0.3, 1.12, -5.9, 10));
    pl.group.add(box(1.0, 2.0, 0.8, M.white, -9.2, 1.0, -6.1));
    pl.group.add(box(0.04, 0.8, 0.04, M.metal, -8.8, 1.2, -5.68));
    const menu = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.9), new THREE.MeshBasicMaterial({ map: signTexture('COFFEE · CHAI · SNACKS') }));
    menu.position.set(-4.5, 2.2, -6.62);
    pl.group.add(menu);
    pl.group.add(box(3.3, 1.0, 0.06, M.dark, -4.5, 2.2, -6.66));
    pl.spots.push(spotAt(pl, -5.8, -5.2, Math.PI, false, 'cafe'));
    pl.spots.push(spotAt(pl, -3.6, -5.2, Math.PI, false, 'cafe'));
    pl.spots.push(spotAt(pl, -1.8, -5.2, Math.PI, false, 'cafe'));

    // café tables with stools, a pendant lamp over each
    for (const [tx, tz] of [[-7, -2.2], [-3.4, -2.2], [-7, 1.8], [-3.4, 1.8]]) {
      pl.group.add(cyl(0.6, 0.6, 0.05, M.white, tx, 0.78, tz, 24));
      pl.group.add(cyl(0.05, 0.05, 0.74, M.metal, tx, 0.4, tz, 8));
      pl.group.add(cyl(0.012, 0.012, 1.4, M.dark, tx, 2.7, tz, 4));
      pl.group.add(cyl(0.08, 0.28, 0.22, M.lampGlow, tx, 1.95, tz, 14));
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const sx = tx + Math.cos(a) * 1.0;
        const sz = tz + Math.sin(a) * 1.0;
        pl.group.add(cyl(0.22, 0.2, 0.06, M.red, sx, 0.52, sz, 14));
        pl.group.add(cyl(0.04, 0.04, 0.5, M.metal, sx, 0.26, sz, 6));
        pl.spots.push(spotAt(pl, sx, sz, Math.atan2(tx - sx, tz - sz), true, 'cafe'));
      }
      pl.group.add(cyl(0.06, 0.05, 0.12, M.white, tx + 0.2, 0.86, tz, 10));
    }

    // plants everywhere: trees in big pots in the corners, planter boxes along the sides, and a
    // tree in the middle with a round bench
    for (const [px, pz] of [[-9.2, 6.2], [9.2, 6.2], [9.2, -6.2], [-0.4, -6.2]]) {
      const pot = cyl(0.55, 0.45, 0.7, M.terracotta, px, 0.35, pz, 16);
      pl.group.add(pot);
      const tree = makeTree(2.4);
      tree.position.set(px, 0.7, pz);
      tree.scale.setScalar(0.8);
      pl.group.add(tree);
    }
    for (const [bx, bz, len, rot] of [[-9.6, 0, 8, Math.PI / 2], [2.6, 6.4, 3.6, 0]]) {
      const planter = new THREE.Group();
      planter.add(box(len, 0.5, 0.6, M.oak, 0, 0.25, 0));
      for (let k = 0; k < Math.round(len / 0.7); k++) {
        const bush = new THREE.Mesh(geo(`bush${k % 3}`, () => new THREE.IcosahedronGeometry(0.34 - (k % 3) * 0.06, 0)), k % 2 ? M.leaf : M.leaf2);
        bush.position.set(-len / 2 + 0.35 + k * 0.7, 0.7, 0);
        bush.castShadow = true;
        planter.add(bush);
        if (k % 2 === 0) planter.add(ball(0.08, M.flowers[k % 5], -len / 2 + 0.35 + k * 0.7, 0.95, 0.12, 6));
      }
      planter.position.set(bx, 0.08, bz);
      planter.rotation.y = rot;
      planter.userData.sway = true;
      pl.group.add(planter);
    }
    pl.group.add(cyl(1.0, 1.0, 0.45, M.oak, -5.2, 0.3, 4.9, 24));
    const midTree = makeTree(2.8);
    midTree.position.set(-5.2, 0.5, 4.9);
    pl.group.add(midTree);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      pl.spots.push(spotAt(pl, -5.2 + Math.cos(a) * 1.25, 4.9 + Math.sin(a) * 1.25, Math.atan2(Math.cos(a), Math.sin(a)), true, 'cafe'));
    }

    // the lounge corner: two sofas over a coffee table, and bean bags
    const sofaMat = new THREE.MeshStandardMaterial({ color: '#4f46e5', roughness: 0.7 });
    for (const [sz, face] of [[-4.2, 0], [-0.6, Math.PI]]) {
      const sofa = new THREE.Group();
      sofa.add(box(2.6, 0.45, 0.9, sofaMat, 0, 0.32, 0));
      sofa.add(box(2.6, 0.6, 0.25, sofaMat, 0, 0.75, -0.42));
      for (const sx of [-1.25, 1.25]) sofa.add(box(0.2, 0.55, 0.9, sofaMat, sx, 0.45, 0));
      sofa.position.set(4.2, 0.08, sz);
      sofa.rotation.y = face;
      pl.group.add(sofa);
      for (const ox of [-0.6, 0.6]) {
        const [dx, dz] = rotXZ(ox, 0.1, face);
        pl.spots.push(spotAt(pl, 4.2 + dx, sz + dz, face, true, 'cafe'));
      }
    }
    pl.group.add(box(1.6, 0.35, 0.9, M.oak, 4.2, 0.25, -2.4));
    pl.group.add(cyl(0.16, 0.12, 0.2, M.terracotta, 4.5, 0.52, -2.4, 10));
    pl.group.add(ball(0.18, M.leaf2, 4.5, 0.72, -2.4, 8));
    const beanColors = ['#f97316', '#22c55e', '#ec4899'];
    for (const [k, [bx, bz]] of [[1.4, 2.6], [2.8, 3.6], [1.2, 4.6]].entries()) {
      const bag = ball(0.45, new THREE.MeshStandardMaterial({ color: beanColors[k], roughness: 0.9 }), bx, 0.32, bz, 14);
      bag.scale.set(1, 0.7, 1);
      pl.group.add(bag);
      pl.spots.push(spotAt(pl, bx, bz, Math.atan2(-bx, -bz + 1), true, 'cafe'));
    }

    // the play area: ping-pong (players at each end) and foosball (players at each side)
    const pong = new THREE.Group();
    pong.add(box(1.5, 0.05, 2.74, new THREE.MeshStandardMaterial({ color: '#1d4ed8', roughness: 0.5 }), 0, 0.76, 0));
    pong.add(box(1.52, 0.012, 0.02, M.white, 0, 0.79, 0, false));
    pong.add(box(1.6, 0.16, 0.02, M.white, 0, 0.86, 0, false));
    for (const [lx, lz] of [[-0.65, -1.2], [0.65, -1.2], [-0.65, 1.2], [0.65, 1.2]]) pong.add(box(0.05, 0.74, 0.05, M.dark, lx, 0.37, lz));
    pong.position.set(7.0, 0.08, 3.2);
    pl.group.add(pong);
    pl.pong = { center: [7.0, 3.2] };
    pl.spots.push(spotAt(pl, 7.0, 3.2 - 2.0, 0, false, 'pong'));
    pl.spots.push(spotAt(pl, 7.0, 3.2 + 2.0, Math.PI, false, 'pong'));
    pl.pongSpots = pl.spots.slice(-2);
    pl.pongBall = ball(0.05, M.white, 0, 0, 0, 8);
    pl.pongBall.castShadow = false;
    scene.add(pl.pongBall);
    builtStatic.push(pl.pongBall);

    const foos = new THREE.Group();
    foos.add(box(1.2, 0.5, 0.75, M.oak, 0, 0.7, 0));
    foos.add(box(1.1, 0.02, 0.65, M.field, 0, 0.96, 0, false));
    for (const [lx, lz] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]]) foos.add(box(0.08, 0.5, 0.08, M.dark, lx, 0.25, lz));
    pl.rods = [];
    for (let k = 0; k < 4; k++) {
      const rod = new THREE.Group();
      rod.position.set(-0.42 + k * 0.28, 1.0, 0);
      rod.add(box(0.025, 0.025, 1.1, M.metal, 0, 0, 0, false));
      for (const fz of [-0.18, 0, 0.18]) rod.add(box(0.05, 0.14, 0.04, k % 2 ? M.red : M.dark, 0, -0.06, fz, false));
      foos.add(rod);
      pl.rods.push(rod);
    }
    foos.position.set(7.0, 0.08, -3.4);
    pl.group.add(foos);
    pl.spots.push(spotAt(pl, 7.0, -3.4 - 0.85, 0, false, 'foos'));
    pl.spots.push(spotAt(pl, 7.0, -3.4 + 0.85, Math.PI, false, 'foos'));
    pl.foosSpots = pl.spots.slice(-2);

    // standing spots for a chat, in pairs facing each other: by the entrance and between the
    // café and the lounge
    pl.chatPairs = [];
    for (const [cx, cz, along] of [[1.4, 5.8, 'x'], [0.2, 0.2, 'z'], [-1.6, -4.4, 'x']]) {
      const d = 0.55;
      const pair = along === 'x'
        ? [spotAt(pl, cx - d, cz, Math.PI / 2, false, 'chat'), spotAt(pl, cx + d, cz, -Math.PI / 2, false, 'chat')]
        : [spotAt(pl, cx, cz - d, 0, false, 'chat'), spotAt(pl, cx, cz + d, Math.PI, false, 'chat')];
      pl.spots.push(...pair);
      pl.chatPairs.push(pair);
    }
    return pl;
  }

  /* ---------------- the office cat ---------------- */

  let cat = null;
  function buildCat() {
    if (cat) scene.remove(cat.root);
    const root = new THREE.Group();
    const fur = new THREE.MeshStandardMaterial({ color: '#f59e42', roughness: 0.8 });
    const body = new THREE.Mesh(geo('catbody', () => new THREE.CapsuleGeometry(0.13, 0.32, 4, 8)), fur);
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.24;
    body.castShadow = true;
    root.add(body);
    const head = ball(0.12, fur, 0, 0.36, 0.26, 10);
    root.add(head);
    for (const sx of [-0.06, 0.06]) {
      const ear = new THREE.Mesh(geo('ear', () => new THREE.ConeGeometry(0.04, 0.08, 4)), fur);
      ear.position.set(sx, 0.48, 0.26);
      root.add(ear);
    }
    const tail = new THREE.Group();
    tail.position.set(0, 0.28, -0.24);
    const tailMesh = new THREE.Mesh(geo('tail', () => new THREE.CapsuleGeometry(0.03, 0.3, 3, 6)), fur);
    tailMesh.position.y = 0.16;
    tail.add(tailMesh);
    root.add(tail);
    scene.add(root);
    cat = { root, tail, ang: Math.random() * Math.PI * 2, dir: 1, rest: 0 };
  }

  /* ---------------- walking about ---------------- */

  const plazaPt = ang => new THREE.Vector3(Math.cos(ang) * PLAZA_R, 0, Math.sin(ang) * PLAZA_R);
  /** Points round the plaza walkway from one angle to another, the short way. */
  function arc(a1, a2, out) {
    let d = ((a2 - a1 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / 0.3));
    for (let k = 1; k <= steps; k++) out.push(plazaPt(a1 + (d * k) / steps));
  }
  const nearestDoor = ang => DOORS.reduce((b, d) => (angDiff(d, ang) < angDiff(b, ang) ? d : b), DOORS[0]);
  const doorPt = (ang, r) => new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);

  function release(a) {
    if (a.spot) { a.spot.taken = null; a.spot = null; }
  }

  /** Path from wherever the agent is to the plaza walkway; returns the plaza angle. */
  function leave(a, path) {
    if (a.where === 'zone') {
      const z = a.zone;
      const t0 = toRing(a, path);
      for (const [x, zz] of ringPath(t0, z.exitT)) path.push(W(z, x, zz));
      path.push(plazaPt(z.ang));
      return z.ang;
    }
    if (a.where === 'room') {
      const d = nearestDoor(Math.atan2(a.pos.z, a.pos.x));
      path.push(doorPt(d, ROOM_R - 0.6), doorPt(d, ROOM_R + 0.6), plazaPt(d));
      return d;
    }
    if (a.where === 'plaza') {
      const ang = Math.atan2(a.pos.z, a.pos.x);
      path.push(plazaPt(ang));
      return ang;
    }
    const pl = a.spot ? a.spot.place : places[a.where];
    path.push(W(pl, 0, pl.depth / 2 + 0.4), plazaPt(pl.ang));
    return pl.ang;
  }

  /** Path from wherever the agent is to their zone's walkway; returns the ring param. */
  function toRing(a, path) {
    const z = a.zone;
    if (a.loc === 'seat') {
      const [x, zz] = ringPoint(a.seat.aisleT);
      path.push(W(z, x, zz));
      return a.seat.aisleT;
    }
    const [lx, lz] = toLocal(z, a.pos);
    const t = ringParam(lx, lz);
    const [x, zz] = ringPoint(t);
    path.push(W(z, x, zz));
    return t;
  }

  function plan(a, dest) {
    const z = a.zone;
    const path = [];
    release(a);
    const inZone = a.where === 'zone';
    if (dest.kind === 'seat' || dest.kind === 'ring' || dest.kind === 'cooler') {
      let t0;
      if (inZone) t0 = toRing(a, path);
      else {
        const pa = leave(a, path);
        arc(pa, z.ang, path);
        const [x, zz] = ringPoint(z.exitT);
        path.push(W(z, x, zz));
        t0 = z.exitT;
      }
      if (dest.kind === 'seat') {
        for (const [x, zz] of ringPath(t0, a.seat.aisleT)) path.push(W(z, x, zz));
        path.push(W(z, a.seat.x, a.seat.z));
      } else if (dest.kind === 'ring') {
        for (const [x, zz] of ringPath(t0, dest.t)) path.push(W(z, x, zz));
      } else {
        const t = ringParam(z.cooler[0], z.cooler[1]);
        for (const [x, zz] of ringPath(t0, t)) path.push(W(z, x, zz));
        path.push(W(z, z.cooler[0] - 0.6, z.cooler[1] + 0.15));
      }
    } else if (dest.kind === 'spot') {
      const s = dest.spot;
      const pa = leave(a, path); // from where they are now, before taking the new spot
      s.taken = a;
      a.spot = s;
      if (s.area === 'room') {
        const d = nearestDoor(s.ang);
        arc(pa, d, path);
        path.push(doorPt(d, ROOM_R + 0.6), doorPt(d, ROOM_R - 0.6));
      } else {
        arc(pa, s.place.ang, path);
        path.push(W(s.place, 0, s.place.depth / 2 + 0.4));
      }
      path.push(s.pos.clone());
    } else if (dest.kind === 'plaza') {
      // a stroll round the plaza walkway to somewhere else on it
      arc(leave(a, path), dest.ang, path);
    }
    a.path = path;
    a.dest = dest;
    a.sitGoal = 0;
    a.pose = null;
    a.arrived = false; // not at the new spot yet (the games wait for real arrivals)
  }

  const freeSpot = (list, pose) => {
    const free = list.filter(s => !s.taken && (!pose || s.pose === pose));
    return free.length ? pickOne(free) : null;
  };

  /**
   * Where a free crew member goes next. Free people do not hang about at their desks: they spend
   * their time in the café & lounge (coffee, sofas, a chat, a game) or take a walk round the
   * plaza, and only now and then drop by a busy teammate. Work brings them back to their desk.
   */
  function pickOuting(a) {
    if (hubBusy) {
      const s = freeSpot(STAND_SEATS);
      if (s && Math.random() < 0.8) return { kind: 'spot', spot: s };
    }
    const r = Math.random();
    const L = places.lounge;
    if (L && r < 0.25) {
      // a game: join someone waiting at a table first, so games actually start
      const waiting = [L.pongSpots, L.foosSpots].find(pair => pair.some(s => s.taken) && pair.some(s => !s.taken));
      const s = waiting ? waiting.find(x => !x.taken) : freeSpot(L.spots.filter(x => x.pose === 'pong' || x.pose === 'foos'));
      if (s) return { kind: 'spot', spot: s, stay: rand(24, 40) };
    }
    if (L && r < 0.42) {
      // a chat: join someone already standing at a chat spot
      const pairs = L.chatPairs || [];
      const waiting = pairs.find(pair => pair.some(s => s.taken) && pair.some(s => !s.taken));
      const s = waiting ? waiting.find(x => !x.taken) : freeSpot(L.spots, 'chat');
      if (s) return { kind: 'spot', spot: s, stay: rand(14, 26) };
    }
    if (L && r < 0.85) { const s = freeSpot(L.spots, 'cafe'); if (s) return { kind: 'spot', spot: s, stay: rand(20, 45) }; }
    if (r < 0.95) return { kind: 'plaza', ang: Math.random() * Math.PI * 2 };
    const busy = [...agents.values()].filter(m => m.zone === a.zone && m !== a && m.state === 'working');
    if (busy.length) { const mate = pickOne(busy); return { kind: 'ring', t: mate.seat.aisleT + rand(-0.4, 0.4), visit: mate }; }
    return { kind: 'plaza', ang: Math.random() * Math.PI * 2 };
  }

  function floorY(p) {
    const r = Math.hypot(p.x, p.z);
    if (r < ROOM_R) return 0.12;
    if (r < PLAZA_R + 1.3) return 0.06;
    for (const z of zones) {
      const [lx, lz] = toLocal(z, p);
      if (Math.abs(lx) < ZONE_W / 2 && Math.abs(lz) < ZONE_D / 2) return FLOOR;
    }
    for (const pl of Object.values(places)) {
      const [lx, lz] = toLocal(pl, p);
      if (Math.abs(lx) < pl.width / 2 && Math.abs(lz) < pl.depth / 2) return 0.08;
    }
    return 0.02;
  }

  function think(a, dt) {
    const wantDesk = a.state === 'working' || a.state === 'queued';
    if (a.focused) return;
    const walking = a.path.length > 0;
    if (wantDesk && a.loc !== 'seat' && (!walking || a.dest.kind !== 'seat')) { plan(a, { kind: 'seat' }); return; }
    if (walking) return;
    a.timer -= dt;
    if (a.timer > 0) return;
    if (a.loc === 'seat' && a.where === 'zone') {
      if (wantDesk) { a.timer = rand(5, 10); return; }
      plan(a, pickOuting(a));               // nothing to do: off they go
    } else if (wantDesk) {
      plan(a, { kind: 'seat' });
    } else {
      plan(a, pickOuting(a));               // still free: somewhere else, never back to the desk
    }
  }

  const tmp = new THREE.Vector3();
  function move(a, dt, t) {
    const f = a.fig;
    a.sit += (a.sitGoal - a.sit) * Math.min(1, dt * 5);
    const standing = a.sit < 0.06;
    let speed = 0;
    if (a.path.length && standing && !a.focused) {
      const next = a.path[0];
      tmp.subVectors(next, a.pos).setY(0);
      const d = tmp.length();
      const step = WALK * dt;
      if (d <= step) {
        a.pos.copy(next);
        a.path.shift();
        if (!a.path.length) arrive(a);
      } else {
        a.pos.addScaledVector(tmp.normalize(), step);
        a.heading = angleLerp(a.heading, Math.atan2(tmp.x, tmp.z), Math.min(1, dt * 10));
        speed = 1;
      }
    }
    if (a.focused) {
      a.heading = angleLerp(a.heading, Math.PI / 4, Math.min(1, dt * 6));
    } else if (!speed && a.spot && a.arrived) {
      a.heading = angleLerp(a.heading, a.spot.facing, Math.min(1, dt * 6));
    } else if (!speed && a.lookAt) {
      tmp.subVectors(a.lookAt, a.pos);
      a.heading = angleLerp(a.heading, Math.atan2(tmp.x, tmp.z), Math.min(1, dt * 4));
    } else if (!speed && a.loc === 'seat') {
      a.heading = angleLerp(a.heading, a.seat.facing, Math.min(1, dt * 6));
    }

    a.walkPhase += dt * 9 * speed;
    const swing = Math.sin(a.walkPhase) * 0.55 * speed;
    const s = a.sit;
    f.root.position.set(a.pos.x, floorY(a.pos) + SEAT_DROP * s + Math.abs(Math.sin(a.walkPhase)) * 0.04 * speed, a.pos.z);
    f.root.rotation.y = a.heading;
    f.legs[0].rotation.x = -Math.PI / 2 * s + swing * (1 - s);
    f.legs[1].rotation.x = -Math.PI / 2 * s - swing * (1 - s);

    const typing = a.state === 'working' && s > 0.9 && !a.focused && a.loc === 'seat';
    let armL = -0.08 - swing * 0.8;
    let armR = -0.08 + swing * 0.8;
    let armZ = 0;
    if (s > 0.5) { armL = -0.95; armR = -0.95; }
    if (typing) {
      armL = -1.05 + Math.sin(t * 16 + a.phase) * 0.12;
      armR = -1.05 + Math.sin(t * 16 + a.phase + 1.7) * 0.12;
    }
    const pose = a.arrived && !speed ? a.pose : null;
    if (pose === 'cafe') armR = -1.5 + Math.sin(t * 0.8 + a.phase) * 0.25; // sipping coffee
    if (pose === 'pong') { const sw = a.paddleSwing || 0; armR = -0.9 - sw * 0.7; armZ = 0.25 - sw * 0.6; armL = -0.3; }
    if (pose === 'foos') { armL = -1.25 + Math.sin(t * 6 + a.phase) * 0.12; armR = -1.25 + Math.sin(t * 6 + a.phase + 2) * 0.12; }
    if (pose === 'chat') { armR = -0.5 + Math.max(0, Math.sin(t * 1.7 + a.phase)) * 0.6; armZ = 0.15; } // talking with their hands
    f.arms[0].rotation.x = armL;
    f.arms[1].rotation.x = armR;
    a.wave += ((a.focused ? 1 : 0) - a.wave) * Math.min(1, dt * 6);
    f.arms[1].rotation.z = a.wave * (2.5 + Math.sin(t * 9) * 0.35) + armZ;
    f.arms[0].rotation.z = -armZ;
    f.cup.visible = pose === 'cafe';
    f.paddle.visible = pose === 'pong';

    f.head.rotation.x = typing ? 0.12 + Math.sin(t * 2 + a.phase) * 0.04 : -0.05;
    f.head.rotation.y = a.focused || speed ? 0 : Math.sin(t * 0.5 + a.phase) * 0.3;
    f.head.position.y = 1.97 + (a.state === 'idle' && !speed ? Math.abs(Math.sin(t * 1.5 + a.phase)) * 0.02 : 0);
  }

  function arrive(a) {
    const d = a.dest || {};
    a.lookAt = null;
    a.arrived = false;
    if (d.kind === 'seat') {
      a.where = 'zone';
      a.loc = 'seat';
      a.sitGoal = 1;
      a.timer = rand(10, 30);
    } else if (d.kind === 'spot') {
      a.where = d.spot.area;
      a.loc = 'away';
      a.arrived = true;
      a.pose = d.spot.pose;
      a.sitGoal = d.spot.sit ? 1 : 0;
      a.timer = d.stay || rand(8, 16);
    } else if (d.kind === 'cooler') {
      a.where = 'zone';
      a.loc = 'spot';
      a.lookAt = W(a.zone, a.zone.cooler[0], a.zone.cooler[1]);
      a.timer = rand(4, 8);
    } else if (d.kind === 'plaza') {
      a.where = 'plaza';
      a.loc = 'away';
      a.lookAt = new THREE.Vector3(0, 0, 0); // a look at the stand-up room's globe
      a.timer = rand(3, 8);
    } else {
      a.where = 'zone';
      a.loc = 'ring';
      if (d.visit) a.lookAt = d.visit.pos.clone();
      a.timer = rand(3, 7);
    }
  }

  /* ---------------- the play area ---------------- */

  const here = s => (s.taken && s.taken.arrived ? s.taken : null);

  /** Ping-pong: once both players are at the table, the ball goes back and forth with a bounce. */
  function playGames(t) {
    const pl = places.lounge;
    if (!pl) return;
    const [a, b] = pl.pongSpots.map(here);
    const [cx, cz] = pl.pong.center;
    const ballM = pl.pongBall;
    if (a && b) {
      const period = 1.4;
      const p = (t % period) / period;              // 0..1: a to b, then b to a
      const there = p < 0.5;
      const k = there ? p * 2 : (p - 0.5) * 2;
      const z0 = there ? -1.25 : 1.25;
      const z1 = -z0;
      const lz = z0 + (z1 - z0) * k;
      // one bounce on the far half of the table
      const h = k < 0.6 ? Math.sin((k / 0.6) * Math.PI) * 0.35 : Math.sin(((k - 0.6) / 0.4) * Math.PI) * 0.22;
      ballM.position.copy(W(pl, cx + Math.sin(t * 2.3) * 0.25, cz + lz)).setY(0.08 + 0.81 + h);
      a.paddleSwing = there ? Math.max(0, 1 - k * 4) : Math.max(0, (k - 0.75) * 4);
      b.paddleSwing = there ? Math.max(0, (k - 0.75) * 4) : Math.max(0, 1 - k * 4);
    } else {
      ballM.position.copy(W(pl, cx + 0.4, cz)).setY(0.08 + 0.81);
      if (a) a.paddleSwing = 0;
      if (b) b.paddleSwing = 0;
    }
    // foosball: the rods slide and spin while two people play
    const [f1, f2] = pl.foosSpots.map(here);
    pl.rods.forEach((rod, i) => {
      const on = f1 && f2;
      rod.position.z = on ? Math.sin(t * 3 + i * 1.3) * 0.12 : 0;
      rod.rotation.z = on ? Math.sin(t * 5 + i) * 0.6 : 0;
    });
  }

  /* ---------------- confetti ---------------- */

  const confetti = [];
  const confettiGeo = new THREE.PlaneGeometry(0.09, 0.06);
  const confettiMats = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#facc15'].map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
  function burst(at) {
    if (reducedMotion()) return;
    for (let k = 0; k < 40; k++) {
      const m = new THREE.Mesh(confettiGeo, pickOne(confettiMats));
      m.position.copy(at);
      scene.add(m);
      confetti.push({ m, v: new THREE.Vector3(rand(-1.4, 1.4), rand(2.5, 4.5), rand(-1.4, 1.4)), spin: rand(-8, 8), life: rand(1.6, 2.4) });
    }
  }
  function stepConfetti(dt) {
    for (let k = confetti.length - 1; k >= 0; k--) {
      const c = confetti[k];
      c.life -= dt;
      c.v.y -= 6 * dt;
      c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.spin * dt;
      c.m.rotation.y += c.spin * 0.7 * dt;
      if (c.life <= 0 || c.m.position.y < 0) { scene.remove(c.m); confetti.splice(k, 1); }
    }
  }

  /* ---------------- state from the app ---------------- */

  let hubBusy = false;
  let themeKey = '';
  function update(S, activity) {
    const bg = cssVar('--bg') || '#f6f7f9';
    const dark = new THREE.Color(bg).getHSL({}).l < 0.3;
    scene.background = new THREE.Color(bg);
    const tk = `${bg}`;
    if (tk !== themeKey) {
      themeKey = tk;
      M.grass.color = dark ? new THREE.Color('#1f3a2a') : new THREE.Color('#b5dba6');
      M.paving.color = dark ? new THREE.Color('#3a3d45') : new THREE.Color('#ebe6dc');
      M.path.color = dark ? new THREE.Color('#33363d') : new THREE.Color('#ddd6c9');
      M.carpet.color = dark ? new THREE.Color('#2c3442') : new THREE.Color('#dde4ec');
      M.field.color = dark ? new THREE.Color('#2f5a2f') : new THREE.Color('#86c46e');
    }

    const key = S.projects.map(p => `${p.id}:${p.name}:${(p.activeRoles || []).join(',')}`).join('|')
      + '#' + S.roles.map(r => `${r.id}:${r.color}`).join(',');
    if (key !== zoneKey) { zoneKey = key; buildZones(S.projects, S.roles); }

    for (const z of zones) {
      const p = S.projects.find(x => x.id === z.id);
      const tasks = S.tasks.filter(t => t.projectId === z.id);
      const rep = S.reports.find(r => r.projectId === z.id && r.status === 'done');
      const hc = rep && { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[rep.health];
      z.rimMat.color = hc ? new THREE.Color(hc) : mix(bg, dark ? '#ffffff' : '#94a3b8', dark ? 0.18 : 0.45);
      z.floorMat.color = mix(bg, '#ffffff', dark ? 0.08 : 0.85);
      const orb = orbits.find(o => o.id === z.id);
      if (orb) orb.mesh.material.color.set(hc || '#cbd5e1');
      const live = tasks.filter(t => t.status === 'running' || t.status === 'queued').length;
      const zl = zoneLabels.get(z.id);
      const zHtml = `<span class="dot ${rep ? rep.health : ''}"></span><b>${esc(p.name)}</b>${live ? `<span class="count live">${live}</span>` : ''}`;
      if (zl.innerHTML !== zHtml) zl.innerHTML = zHtml;

      // the whiteboard: queued, running and review counts as sticky notes
      const todo = tasks.filter(t => t.status === 'queued' || t.status === 'blocked').length;
      const doing = tasks.filter(t => t.status === 'running').length;
      const review = tasks.filter(t => t.mode === 'change' && t.status === 'done' && !t.cleaned && t.git && t.git.commits.length).length;
      const sig = `${todo}/${doing}/${review}`;
      if (sig !== z.boardSig) {
        z.boardSig = sig;
        z.boardMat.map.dispose();
        z.boardMat.map = boardTexture(todo, doing, review);
        z.boardMat.needsUpdate = true;
      }

      for (const { id: roleId } of S.roles) {
        const a = agents.get(`${z.id}:${roleId}`);
        if (!a) continue;
        const mine = tasks.filter(t => t.role === roleId);
        const run = mine.find(t => t.status === 'running');
        const queued = mine.filter(t => t.status === 'queued').length;
        const rv = mine.filter(t => t.mode === 'change' && t.status === 'done' && !t.cleaned && t.git && t.git.commits.length).length;
        const last = mine.find(t => t.status !== 'queued' && t.status !== 'running');
        const failed = last && (last.status === 'failed' || last.status === 'blocked');
        a.state = run ? 'working' : queued ? 'queued' : failed ? 'failed' : rv ? 'review' : 'idle';
        if (a.prevState === 'working' && (a.state === 'review' || a.state === 'idle')) burst(a.fig.root.position.clone().setY(2.6));
        a.prevState = a.state;
        a.fig.faceMat.map = FACE[a.state];
        const role = S.roles.find(r => r.id === roleId);
        const lab = agentLabels.get(a.key);
        let text;
        if (run) text = `<b>${esc(role.short)}</b> ${esc(activity[run.id] || run.title)}`;
        else if (a.state === 'failed') text = `<b>${esc(role.short)}</b> needs attention: ${esc(last.title)}`;
        else if (rv) text = `<b>${esc(role.short)}</b> ${rv} to review`;
        else if (queued) text = `<b>${esc(role.short)}</b> ${queued} queued`;
        else text = `<b>${esc(role.short)}</b> ${esc(role.name)}${a.where !== 'zone' ? ` · ${{ lounge: a.pose === 'pong' ? 'playing ping-pong' : a.pose === 'foos' ? 'playing foosball' : a.pose === 'chat' ? 'chatting in the lounge' : 'at the café', plaza: 'taking a walk', room: 'in the stand-up room' }[a.where] || ''}` : ''}`;
        if (lab.innerHTML !== text) lab.innerHTML = text;
        lab.dataset.state = a.state;
        lab.title = run ? `${role.name}: ${run.title}` : `${role.name} — click to talk`;
      }
    }
    hubBusy = S.reports.some(r => r.status === 'running' || r.status === 'queued');
    const dr = S.settings.dailyReport;
    const next = S.nextDaily ? new Date(S.nextDaily).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'off';
    const hHtml = hubBusy ? '<b>Stand-up room</b> writing stand-ups…' : `<b>Stand-up room</b> next: ${dr.enabled ? next : 'off'}`;
    if (hubLabel.innerHTML !== hHtml) hubLabel.innerHTML = hHtml;
  }

  /* ---------------- camera ---------------- */

  function applyCamera() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const aspect = w / h;
    Object.assign(camera, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
    camera.position.copy(target).add(OFFSET);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function fit() {
    follow = null;
    zoomGoal = null;
    target.set(0, 0, 0);
    camera.zoom = 1;
    halfH = 20;
    applyCamera();
    const pts = [];
    const corners = (area, w, d) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 2.8]) pts.push(W(area, (sx * w) / 2, (sz * d) / 2).setY(y)); };
    for (const z of zones) corners(z, ZONE_W, ZONE_D);
    for (const pl of Object.values(places)) corners(pl, pl.width, pl.depth);
    for (const a of [0, 1, 2, 3]) pts.push(new THREE.Vector3(Math.cos(a * Math.PI / 2) * PLAZA_R, 3.5, Math.sin(a * Math.PI / 2) * PLAZA_R));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const v = p.applyMatrix4(camera.matrixWorldInverse);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const aspect = (host.clientWidth || 1) / (host.clientHeight || 1);
    halfH = Math.max((maxY - minY) / 2, (maxX - minX) / 2 / aspect) * 1.08;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, (minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2);
    applyCamera();
  }

  function pan(dx, dy) {
    follow = null;
    zoomGoal = null;
    const per = (2 * halfH) / camera.zoom / (host.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, -dx * per).addScaledVector(up, dy * per);
    applyCamera();
  }

  function zoomBy(f) {
    zoomGoal = null;
    camera.zoom = Math.min(8, Math.max(0.5, camera.zoom * f));
    camera.updateProjectionMatrix();
  }

  /* ---------------- focus + pinned card ---------------- */

  let follow = null;
  let focused = null;
  let card = null;

  function focus(pid, role, { zoom = 3.2 } = {}) {
    const a = agents.get(`${pid}:${role}`);
    if (!a) return false;
    if (focused && focused !== a) focused.focused = false;
    focused = a;
    a.focused = true;
    follow = a;
    zoomGoal = Math.max(camera.zoom, zoom);
    return true;
  }
  function releaseFocus() {
    if (focused) { focused.focused = false; focused.timer = rand(2, 6); }
    focused = null;
    follow = null;
  }
  function attachCard(el, pid, role) {
    detachCard();
    const a = agents.get(`${pid}:${role}`);
    if (!a) return;
    el.classList.add('ol-card');
    labels.appendChild(el);
    card = { el, agent: a };
  }
  function detachCard() {
    if (card) card.el.remove();
    card = null;
  }

  /* ---------------- pointer ---------------- */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointers = new Map();
  let down = null;
  let hovered = null;
  let pinch = 0;

  function pickAt(x, y) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.pick : null;
  }
  function setHover(pick) {
    const key = pick ? `${pick.kind}:${pick.projectId || ''}:${pick.role || ''}` : '';
    if (key === (hovered && hovered.key)) return;
    if (hovered && hovered.agent) hovered.agent.fig.bodyMat.emissive.set('#000000');
    hovered = null;
    for (const d of agentLabels.values()) d.classList.remove('hover');
    for (const d of zoneLabels.values()) d.classList.remove('hover');
    renderer.domElement.style.cursor = pick ? 'pointer' : 'grab';
    if (!pick) return;
    hovered = { key };
    if (pick.kind === 'agent') {
      const a = agents.get(`${pick.projectId}:${pick.role}`);
      if (a) { a.fig.bodyMat.emissive.set('#333333'); hovered.agent = a; }
      const l = agentLabels.get(`${pick.projectId}:${pick.role}`);
      if (l) l.classList.add('hover');
    } else if (pick.kind === 'zone') {
      const l = zoneLabels.get(pick.projectId);
      if (l) l.classList.add('hover');
    }
  }

  const el = renderer.domElement;
  el.style.cursor = 'grab';
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY, moved: false };
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinch = Math.hypot(p.x - q.x, p.y - q.y);
    }
  });
  el.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) { setHover(pickAt(e.clientX, e.clientY)); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (pinch) zoomBy(d / pinch);
      pinch = d;
      if (down) down.moved = true;
      return;
    }
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
    if (down && down.moved) { el.style.cursor = 'grabbing'; pan(e.clientX - prev.x, e.clientY - prev.y); }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (down && !down.moved && e.type === 'pointerup') {
      const pick = pickAt(e.clientX, e.clientY);
      if (pick && pick.kind === 'agent') onAgent && onAgent(pick.projectId, pick.role);
      else if (pick && pick.kind === 'zone') onZone && onZone(pick.projectId);
      else if (pick && pick.kind === 'hub') onHub && onHub();
    }
    if (!pointers.size) { down = null; el.style.cursor = hovered ? 'pointer' : 'grab'; }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { if (!pointers.size) setHover(null); });
  el.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.pow(1.0015, -e.deltaY)); }, { passive: false });
  el.addEventListener('dblclick', () => fit());

  /* ---------------- frame loop ---------------- */

  const clock = new THREE.Clock();
  const v = new THREE.Vector3();
  let raf = 0;
  let running = false;

  function place(div, world, lift = 0) {
    v.copy(world).project(camera);
    const x = (v.x * 0.5 + 0.5) * host.clientWidth;
    const y = (-v.y * 0.5 + 0.5) * host.clientHeight - lift;
    div.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, clock.getDelta());
    // Motion "off": everything holds still. "Reduced": people stay at their desks.
    const off = motionOff();
    const t = off ? 0 : clock.elapsedTime;
    const still = reducedMotion();
    SCREEN.code.offset.y = (t * 0.12) % 1;

    // the globe turns faster and pulses while a stand-up is being written
    globe.rotation.y = t * (hubBusy ? 0.9 : 0.25);
    grid.rotation.y = -t * 0.1;
    coreMat.emissiveIntensity = hubBusy ? 0.7 + Math.sin(t * 5) * 0.3 : 0.4;
    beamMat.opacity = hubBusy ? 0.18 + Math.sin(t * 5) * 0.06 : 0.1;
    globe.position.y = 2.55 + Math.sin(t * 1.2) * 0.05;
    orbits.forEach((o, i) => {
      const a = t * 0.8 + o.offset;
      o.mesh.position.set(Math.cos(a) * 0.95, Math.sin(a * 1.3 + i) * 0.25, Math.sin(a) * 0.95);
    });

    for (const a of agents.values()) {
      if (!still) think(a, dt);
      else if (a.loc !== 'seat' && !a.path.length) plan(a, { kind: 'seat' });
      move(a, still && !a.path.length ? 1 : dt, t);
      const seated = a.loc === 'seat' && !a.path.length;
      const kind = a.state === 'working' && seated ? 'code' : a.state === 'review' ? 'review' : a.state === 'failed' ? 'failed' : 'idle';
      for (const sc of a.screens) if (sc.material !== screenMat[kind]) sc.material = screenMat[kind];
    }

    playGames(t);
    stepConfetti(off ? 0 : dt);
    // the cat strolls round the plaza
    if (cat && !still) {
      if (cat.rest > 0) cat.rest -= dt;
      else {
        cat.ang += cat.dir * dt * 0.08;
        if (Math.random() < 0.002) { cat.rest = rand(3, 8); if (Math.random() < 0.3) cat.dir *= -1; }
      }
      const r = PLAZA_R + 0.7;
      cat.root.position.set(Math.cos(cat.ang) * r, 0.06, Math.sin(cat.ang) * r);
      cat.root.rotation.y = -cat.ang + (cat.dir > 0 ? 0 : Math.PI);
      cat.tail.rotation.x = -0.6 + Math.sin(t * 3) * 0.3;
    }
    // plants and trees sway a little
    if (!still) for (const o of swayers) o.rotation.z = Math.sin(t * 0.8 + o.position.x) * 0.02;

    if (follow) {
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      v.copy(follow.pos).setY(1.2).addScaledVector(up, (halfH / camera.zoom) * 0.4);
      target.lerp(v, Math.min(1, dt * 4));
      applyCamera();
    }
    if (zoomGoal) {
      camera.zoom += (zoomGoal - camera.zoom) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
      if (Math.abs(zoomGoal - camera.zoom) < 0.01) zoomGoal = null;
    }

    const showAll = camera.zoom > 1.6;
    for (const a of agents.values()) {
      const lab = agentLabels.get(a.key);
      const pinned = card && card.agent === a;
      const show = !pinned && (a.state !== 'idle' || showAll || lab.classList.contains('hover'));
      lab.style.display = show ? '' : 'none';
      if (show) place(lab, v.copy(a.fig.root.position).setY(a.fig.root.position.y + 2.75));
    }
    if (card) {
      v.copy(card.agent.fig.root.position).setY(card.agent.fig.root.position.y + 2.6).project(camera);
      const W0 = host.clientWidth, H0 = host.clientHeight, cw = card.el.offsetWidth, ch = card.el.offsetHeight;
      const x = Math.min(W0 - cw / 2 - 8, Math.max(cw / 2 + 8, (v.x * 0.5 + 0.5) * W0));
      const y = Math.min(H0 - 8, Math.max(ch + 8, (-v.y * 0.5 + 0.5) * H0 - 6));
      card.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const z of zones) place(zoneLabels.get(z.id), W(z, 0, ZONE_D / 2 + 0.6).setY(0.3));
    for (const pl of Object.values(places)) place(pl.labelEl, W(pl, 0, pl.depth / 2 + 0.6).setY(0.3));
    place(hubLabel, v.set(0, 3.6, 0));
    renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(() => {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    applyCamera();
  });
  ro.observe(host);

  return {
    update, fit, zoomBy, focus, release: releaseFocus, attachCard, detachCard,
    start() {
      if (running) return;
      running = true;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      applyCamera();
      clock.getDelta();
      frame();
    },
    stop() { running = false; cancelAnimationFrame(raf); },
    // Tear down completely (e.g. to rebuild with another 3D quality).
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
      labels.remove();
    },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function startSplash({ onEnter } = {}) {
  const splash = document.getElementById('splash');
  const canvas = document.getElementById('splashCanvas');
  const enterBtn = document.getElementById('splashEnter');
  if (!splash || !canvas || !enterBtn) return () => {};

  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;
  let rafId = null;
  let running = true;
  let t = 0;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();

  const rand = mulberry32(1337);

  const STARS = [];
  for (let i = 0; i < 150; i++) {
    STARS.push({
      x: rand() * W, y: rand() * H,
      r: 0.4 + rand() * 1.3,
      speed: 0.2 + rand() * 0.9,
      phase: rand() * Math.PI * 2,
      base: 0.25 + rand() * 0.4,
    });
  }

  const NODE_COUNT = 34;
  const nodes = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1) - Math.PI / 2;
    nodes.push({
      u: { x: Math.cos(phi) * Math.cos(theta), y: Math.sin(phi), z: Math.cos(phi) * Math.sin(theta) },
      phase: rand() * Math.PI * 2,
      size: 1.4 + rand() * 1.2,
    });
  }

  const LINKS = [];
  const arcAngle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const ang = arcAngle(nodes[i].u, nodes[j].u);
      if (ang > 0.42 && ang < 1.75) {
        const hot = rand() < 0.16;
        LINKS.push({ i, j, ang, hot, speed: 0.12 + rand() * 0.22, phase: rand() });
      }
    }
  }
  // cap so arcs stay readable
  LINKS.sort(() => rand() - 0.5);
  LINKS.splice(34);

  const RADAR_BLIPS = [];
  const radPhase = rand() * Math.PI * 2;

  function galaxyNodes() {
    for (const n of nodes) {
      ctx.save();
      ctx.translate(W / 2, H * 0.46);
      ctx.rotate(t * 0.02 + n.phase);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.beginPath();
      ctx.arc(rand() * 600 - 300, rand() * 600 - 300, 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  const rot = () => t * 0.14;

  function transform(p) {
    const r = rot();
    const x = p.x * Math.cos(r) + p.z * Math.sin(r);
    const y = p.y;
    const z = -p.x * Math.sin(r) + p.z * Math.cos(r);
    const R = Math.min(W, H) * 0.34;
    return { x: W / 2 + x * R, y: H * 0.46 - y * R, z };
  }

  const sampleArc = (u, v, s) => {
    const a = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y + u.z * v.z)));
    if (a < 1e-4) return transform(u);
    const su = Math.sin(a);
    const t1 = 1 - s;
    let x = (u.x * Math.sin(a * t1) + v.x * Math.sin(a * s)) / su;
    let y = (u.y * Math.sin(a * t1) + v.y * Math.sin(a * s)) / su;
    let z = (u.z * Math.sin(a * t1) + v.z * Math.sin(a * s)) / su;
    return transform({ x, y, z });
  };

  function drawStars() {
    for (const s of STARS) {
      const a = (s.base + Math.sin(t * s.speed * 2 + s.phase) * 0.35) * (W / 900);
      ctx.fillStyle = `rgba(226, 240, 255, ${Math.max(0.05, a)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGlobe() {
    const cx = W / 2, cy = H * 0.46, R = Math.min(W, H) * 0.34;

    // far-side arcs (behind)
    for (const L of LINKS) {
      const a = nodes[L.i].u, b = nodes[L.j].u;
      const fa = transform(a).z, fb = transform(b).z;
      if (fa > 0 || fb > 0) continue;
      const depth = Math.max(fa, fb);
      const alpha = 0.05 + depth * 0.05;
      ctx.strokeStyle = `rgba(103, 232, 249, ${Math.max(0.02, Math.min(0.14, alpha))})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let s = 0; s <= 12; s++) {
        const p = sampleArc(a, b, s / 12);
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // near-side arcs
    for (const L of LINKS) {
      const a = nodes[L.i].u, b = nodes[L.j].u;
      const fa = transform(a).z, fb = transform(b).z;
      if (fa < 0 || fb < 0) continue;
      const depth = (fa + fb) / 2;
      const alpha = 0.1 + depth * 0.34;
      ctx.strokeStyle = `rgba(45, 212, 191, ${Math.max(0.05, Math.min(0.55, alpha))})`;
      ctx.lineWidth = L.hot ? 1.4 : 1;
      ctx.beginPath();
      for (let s = 0; s <= 16; s++) {
        const p = sampleArc(a, b, s / 16);
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // equator + latitude ring hints
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.10)';
    ctx.lineWidth = 1;
    for (const [theta, phi] of [[0, 0], [Math.PI / 2, 0], [Math.PI, 0], [0, -0.75]]) {
      ctx.beginPath();
      const steps = 60;
      for (let s = 0; s <= steps; s++) {
        const u = { x: Math.cos(phi) * Math.cos(theta + (s / steps) * Math.PI * 2), y: Math.sin(phi), z: Math.cos(phi) * Math.sin(theta + (s / steps) * Math.PI * 2) };
        const p = transform(u);
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // nodes + glow
    for (const n of nodes) {
      const p = transform(n.u);
      const pulse = 1 + 0.35 * Math.sin(t * 1.8 + n.phase);
      const r = n.size * pulse * (0.35 + p.z * 0.3 + 0.3);
      const alpha = 0.35 + p.z * 0.55;
      if (p.z < -0.55) continue;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
      grad.addColorStop(0, `rgba(125, 211, 252, ${alpha})`);
      grad.addColorStop(0.4, `rgba(34, 211, 238, ${alpha * 0.45})`);
      grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(224, 250, 255, ${alpha + 0.2})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      void cx; void R;
    }
  }

  function drawPackets() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const L of LINKS) {
      const a = nodes[L.i].u, b = nodes[L.j].u;
      const s = (L.phase + t * L.speed) % 1;
      const head = sampleArc(a, b, s);
      if (head.z < 0) continue; // only draw packets on the visible hemisphere
      const hot = L.hot;
      const hue = hot ? '244, 114, 182' : '165, 243, 252';
      const tail = 5;
      for (let k = 0; k < tail; k++) {
        const q = sampleArc(a, b, Math.max(0, s - k * 0.015));
        const f = 1 - k / tail;
        ctx.fillStyle = `rgba(${hue}, ${(f * 0.65).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (2.6 - k * 0.4) * f, 0, Math.PI * 2);
        ctx.fill();
      }
      const grad = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 9);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      grad.addColorStop(0.35, `rgba(${hue}, 0.55)`);
      grad.addColorStop(1, `rgba(${hue}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRadar() {
    const bx = 46, by = H - 54, R = 30;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.28)';
    ctx.lineWidth = 1;
    for (const rr of [R, R * 0.66, R * 0.33]) {
      ctx.beginPath();
      ctx.arc(bx, by, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
    ctx.beginPath();
    ctx.moveTo(bx - R, by); ctx.lineTo(bx + R, by);
    ctx.moveTo(bx, by - R); ctx.lineTo(bx, by + R);
    ctx.stroke();

    const ang = t * 1.4 + radPhase;
    ctx.globalCompositeOperation = 'lighter';
    const wedge = ctx.createRadialGradient(bx, by, 0, bx, by, R);
    wedge.addColorStop(0, 'rgba(34, 211, 238, 0.25)');
    wedge.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = wedge;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.arc(bx, by, R, ang - 0.6, ang);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(165, 243, 252, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(ang) * R, by + Math.sin(ang) * R);
    ctx.stroke();

    if (t - radPhase * 3 > 0 && Math.random() < 0.002) {
      RADAR_BLIPS.push({ a: rand() * Math.PI * 2, d: R * (0.3 + rand() * 0.6), born: t });
    }
    for (let i = RADAR_BLIPS.length - 1; i >= 0; i--) {
      const b = RADAR_BLIPS[i];
      if (t - b.born > 4) { RADAR_BLIPS.splice(i, 1); continue; }
      const fade = 1 - (t - b.born) / 4;
      ctx.fillStyle = `rgba(45, 212, 191, ${0.9 * fade})`;
      ctx.beginPath();
      ctx.arc(bx + Math.cos(b.a) * b.d, by + Math.sin(b.a) * b.d, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - (frame._last || now)) / 1000);
    t += dt;
    frame._last = now;

    ctx.clearRect(0, 0, W, H);
    drawStars();
    drawGlobe();
    drawPackets();
    drawRadar();
    galaxyNodes();

    rafId = requestAnimationFrame(frame);
  }

  function dismiss() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    splash.classList.add('splash-leaving');
    splash.addEventListener('animationend', () => {
      splash.style.display = 'none';
      if (onEnter) onEnter();
    }, { once: true });
  }

  enterBtn.addEventListener('click', dismiss);
  window.addEventListener('resize', resize);

  if (reduced) {
    frame(500);
    running = false;
  } else {
    rafId = requestAnimationFrame(frame);
  }

  return () => {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
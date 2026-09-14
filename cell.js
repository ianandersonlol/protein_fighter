// The inside of a cell, behind the fight: a 2D canvas under the proteins, drawn in world
// units so it scrolls and zooms with the camera. The floor the fighters stand on is a
// lipid bilayer and another arches overhead; between them vesicles and a mitochondrion
// drift past at different depths (the deeper, the slower they pass), ribosomes are
// scattered through, and microtubules run far back. Nothing here touches the game.
(function () {
  const TAU = Math.PI * 2;
  // A fixed field of things, in world Å, repeating every SPAN Å so the floor runs on.
  const SPAN = 1600;
  const rnd = (seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)(7);
  const vesicles = Array.from({ length: 22 }, () => ({ x: rnd() * SPAN, y: 0.12 + rnd() * 0.6, r: 12 + rnd() * 34, d: 0.25 + rnd() * 0.45, ph: rnd() * TAU, w: 0.6 + rnd() * 0.8 }));
  const ribosomes = Array.from({ length: 140 }, () => ({ x: rnd() * SPAN, y: 0.05 + rnd() * 0.9, d: 0.35 + rnd() * 0.55, ph: rnd() * TAU }));
  const tubules = Array.from({ length: 6 }, () => ({ x: rnd() * SPAN, y: 0.1 + rnd() * 0.8, a: (rnd() - 0.5) * 0.5, l: 500 + rnd() * 700, d: 0.18 + rnd() * 0.12 }));
  const mitos = Array.from({ length: 2 }, (_, i) => ({ x: (i + 0.5) * SPAN / 2, y: 0.28 + rnd() * 0.3, rx: 90 + rnd() * 40, ry: 34 + rnd() * 12, a: (rnd() - 0.5) * 0.6, d: 0.42, ph: rnd() * TAU }));

  const PALETTE = {
    dark: { cyto: ['#050a12', '#0a1526', '#08111c'], ink: '210,230,255', warm: '255,180,120', membrane: '150,205,255', tubule: '120,160,220', vesicle: '120,190,255', ribo: '255,210,150', mito: '255,150,110' },
    light: { cyto: ['#f4f8fc', '#e8f1fa', '#eef4fa'], ink: '40,60,90', warm: '200,120,70', membrane: '60,110,180', tubule: '90,120,170', vesicle: '70,130,210', ribo: '180,110,60', mito: '210,100,70' },
  };

  // Screen x of a world x at depth d (0 far … 1 the fighters' plane): the camera's
  // shift is scaled by the depth, so far things pass slowly. Wrapped to the span.
  function sx(x, d, camX, scale, W) {
    const span = SPAN * scale * d, off = ((x - camX * d) * scale * d) % span;
    return W / 2 + (off < -span / 2 ? off + span : off > span / 2 ? off - span : off);
  }
  // Each thing is drawn at every repeat that falls on screen.
  function repeats(x, d, camX, scale, W, fn) {
    const span = SPAN * scale * d, base = sx(x, d, camX, scale, W);
    for (let k = Math.floor((-base - 200) / span); k <= Math.ceil((W - base + 200) / span); k++) fn(base + k * span);
  }

  function bilayer(ctx, y, W, scale, camX, c, alpha, wave, t) {
    // Two leaflets of lipids: round heads, two short tails each, tails inward.
    const head = Math.max(2.5, 3.2 * scale), pitch = 9 * scale, gap = 17 * scale, tail = 6.5 * scale;
    const x0 = -((camX * scale) % pitch) - pitch;
    ctx.lineWidth = Math.max(1, 1.1 * scale);
    ctx.strokeStyle = `rgba(${c},${alpha * 0.9})`; ctx.fillStyle = `rgba(${c},${alpha})`;
    for (let x = x0; x < W + pitch; x += pitch) {
      const yy = y + (wave ? Math.sin(x / (60 * scale) + t * 0.4) * 2.5 * scale : 0);
      for (const s of [-1, 1]) {
        const hy = yy + s * gap / 2;
        ctx.beginPath(); ctx.arc(x, hy, head, 0, TAU); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - head * 0.45, hy - s * head); ctx.lineTo(x - head * 0.6, hy - s * (head + tail));
        ctx.moveTo(x + head * 0.45, hy - s * head); ctx.lineTo(x + head * 0.6, hy - s * (head + tail));
        ctx.stroke();
      }
    }
  }

  function draw(canvas, { camX, scale, floorFar, floorDepth, theme, t }) {
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = Math.min(1.5, devicePixelRatio || 1);
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = PALETTE[theme] || PALETTE.dark, dark = theme !== 'light';
    // Cytoplasm: a soft gradient, a little brighter toward the membranes.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, P.cyto[1]); g.addColorStop(0.45, P.cyto[0]); g.addColorStop(1, P.cyto[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const top = H * 0.07;   // the membrane overhead
    // Below the floor's near edge the cell wall in section: a darker (or paler) strip.
    ctx.fillStyle = dark ? 'rgba(20,40,70,0.35)' : 'rgba(160,190,225,0.25)';
    ctx.fillRect(0, floorFar + floorDepth, W, H - floorFar - floorDepth);
    const zone = y => top + y * (floorFar - top);   // a fraction of the space between the membranes

    // Microtubules, far back: long faint lines, slightly off level.
    ctx.lineCap = 'round';
    for (const m of tubules) repeats(m.x, m.d, camX, scale, W, x => {
      const y = zone(m.y), l = m.l * scale * m.d;
      ctx.strokeStyle = `rgba(${P.tubule},${dark ? 0.12 : 0.14})`; ctx.lineWidth = Math.max(1, 2.2 * scale * m.d);
      ctx.beginPath(); ctx.moveTo(x - l / 2, y - Math.sin(m.a) * l / 2); ctx.lineTo(x + l / 2, y + Math.sin(m.a) * l / 2); ctx.stroke();
      ctx.strokeStyle = `rgba(${P.tubule},${dark ? 0.05 : 0.06})`; ctx.lineWidth = Math.max(1, 6 * scale * m.d);
      ctx.beginPath(); ctx.moveTo(x - l / 2, y - Math.sin(m.a) * l / 2); ctx.lineTo(x + l / 2, y + Math.sin(m.a) * l / 2); ctx.stroke();
    });

    // Mitochondria: a rounded capsule with cristae folded inside, gently breathing.
    for (const m of mitos) repeats(m.x, m.d, camX, scale, W, x => {
      const y = zone(m.y) + Math.sin(t * 0.3 + m.ph) * 6 * scale * m.d, rx = m.rx * scale * m.d, ry = m.ry * scale * m.d * (1 + 0.04 * Math.sin(t * 0.8 + m.ph));
      ctx.save(); ctx.translate(x, y); ctx.rotate(m.a);
      ctx.fillStyle = `rgba(${P.mito},${dark ? 0.10 : 0.12})`; ctx.strokeStyle = `rgba(${P.mito},${dark ? 0.35 : 0.4})`; ctx.lineWidth = Math.max(1, 1.6 * scale * m.d);
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.86, ry * 0.72, 0, 0, TAU); ctx.stroke();
      ctx.strokeStyle = `rgba(${P.mito},${dark ? 0.28 : 0.32})`;
      for (let k = -0.7; k <= 0.7; k += 0.2) {   // cristae: folds reaching in from both sides
        const cx = k * rx, up = Math.round(k * 5) % 2 === 0;
        ctx.beginPath(); ctx.moveTo(cx, up ? -ry * 0.72 : ry * 0.72); ctx.bezierCurveTo(cx + rx * 0.06, 0, cx - rx * 0.06, 0, cx, up ? ry * 0.35 : -ry * 0.35); ctx.stroke();
      }
      ctx.restore();
    });

    // Vesicles: rings drifting and bobbing, brighter the nearer.
    for (const v of vesicles) repeats(v.x, v.d, camX, scale, W, x => {
      const y = zone(v.y) + Math.sin(t * v.w + v.ph) * 8 * scale * v.d, r = v.r * scale * v.d;
      const a = (dark ? 0.16 : 0.2) * (0.4 + v.d);
      ctx.fillStyle = `rgba(${P.vesicle},${a * 0.35})`; ctx.strokeStyle = `rgba(${P.vesicle},${a * 2.2})`; ctx.lineWidth = Math.max(1, 1.4 * scale * v.d);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
      if (r > 14) { ctx.strokeStyle = `rgba(${P.vesicle},${a * 0.9})`; ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, TAU); ctx.stroke(); }
    });

    // Ribosomes: small dark grains everywhere, a few glinting.
    for (const r of ribosomes) repeats(r.x, r.d, camX, scale, W, x => {
      const y = zone(r.y) + Math.sin(t * 0.5 + r.ph) * 3 * scale, rr = Math.max(1, 2.2 * scale * r.d);
      const tw = 0.6 + 0.4 * Math.sin(t * 1.3 + r.ph * 3);
      ctx.fillStyle = `rgba(${P.ribo},${(dark ? 0.35 : 0.4) * r.d * tw})`;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    });

    // The membranes: one overhead, waving a little, and the one they stand on. The floor
    // band is that membrane's top surface, seen from above; its bilayer shows in section
    // along the band's near edge, below the feet, so the feet stay clear against the band.
    bilayer(ctx, top, W, scale, camX * 0.9, P.membrane, dark ? 0.45 : 0.5, true, t);
    bilayer(ctx, floorFar + floorDepth + 11 * scale, W, scale, camX, P.membrane, dark ? 0.4 : 0.45, false, t);
  }

  window.Cell = { draw };
})();

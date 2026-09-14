// Protein Fighter: two proteins, one py2Dmol scene, live coordinates. P1 is the beta
// barrel humanoid from ../dance; P2 the helical fighter (scripts/build_helix_fighter.py):
// a helix bundle with hairpin arms and helix legs. Both hang off the same joints.
// World units are Ångström. x runs across the arena, y is up, the floor is y = 0.
(function () {
  const { DomainRig, rotX: X, rotY: Y, matMul3: mul, mat3Eye: eye, CA_STEP } = window.Rig;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- combat rules
  // The arena has no walls: the floor runs on, the camera follows, and the two fighters
  // can only get this far apart (torso to torso), which is where the screen's edge
  // becomes the wall once the camera has pulled back as far as it goes.
  const MAX_GAP = 300;
  const WALK = 130, JUMP_V = 655, JUMP_VX = 240, GRAVITY = 2400, FRICTION = 9;
  // Jumps: a knee bend to push off, falling faster than rising, a little air drag,
  // letting go of up early cuts it to a short hop, and the knees soak up the landing.
  // The torso rides the arc and the legs tuck up under it, so ~93 Å clears a fighter.
  const SQUAT = 0.07, FALL_BOOST = 1.35, AIR_DRAG = 0.4, SHORT_HOP = 0.65, LANDING = 0.2;
  // Street Fighter style: punch or kick, standing, crouching (low) or in the air.
  // push: knockback speed in Å/s, slid out by ground friction.
  // low: it unfolds only the legs. air: can only be thrown while airborne.
  const MOVES = {
    punch:    { duration: 0.24, active: 0.07, window: 0.07, damage: 7,  stun: 0.16, push: 120, fist: 'rarm',      text: 'HIT' },
    kick:     { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
    lowpunch: { duration: 0.22, active: 0.06, window: 0.07, damage: 5,  stun: 0.14, push: 90,  fist: 'rarm',      text: 'JAB' },
    lowkick:  { duration: 0.42, active: 0.14, window: 0.10, damage: 7,  stun: 0.22, push: 130, fist: 'rleg_foot', text: 'LOW KICK', low: true },
    airpunch: { duration: 0.30, active: 0.06, window: 0.14, damage: 8,  stun: 0.20, push: 140, fist: 'rarm',      text: 'HIT', air: true, overhead: true },
    airkick:  { duration: 0.40, active: 0.08, window: 0.22, damage: 10, stun: 0.26, push: 180, fist: 'rleg_foot', text: 'DROP KICK', air: true, overhead: true },
  };
  const REACH = 13;           // Å from striking residues to any defender residue
  const REFOLD = 0.02, REFOLD_DELAY = 2;   // unfolding recovered per residue per second, after this long unhit
  const DAMAGE_SCALE = 0.55;               // every hit softened, so a round takes about twice as many

  // ---------------------------------------------------------------------- forms
  // A form is a protein to fight as: its rig (the scaffold, joints and rigid domains),
  // the motion that drives it, and every index set the game reads off the chain. The
  // two fighters are different proteins, so each carries its own.
  const PAE_BIN = 4;   // residues per PAE pixel, each way
  function makeForm(name, data) {
    const rig = new DomainRig(data), n = rig.n, D = rig.domains;
    const motion = window.Motion.create(rig, { MOVES, JUMP_V, JUMP_VX, SQUAT, LANDING });
    // Leg residues: each leg from where it leaves the torso to where it returns (or, a
    // leg at a chain end, to the end).
    const legs = new Uint8Array(n);
    for (const side of ['lleg', 'rleg']) {
      const idx = [...D[side + '_thigh'], ...D[side + '_shin'], ...D[side + '_foot']];
      let lo = Math.min(...idx), hi = Math.max(...idx);
      while (lo > 0 && rig.owner[lo - 1] === null) lo--;
      while (hi < n - 1 && rig.owner[hi + 1] === null) hi++;
      for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) legs[i] = 1;
    }
    const legIdx = [...legs.keys()].filter(i => legs[i]);
    // The striking end of each limb, not only its tip. Point-blank, a kick's foot has
    // gone clean through the other torso's hollow by the time it is out, 13 Å from every
    // residue, and only the shin is still against the body: counting the foot alone made
    // a kick at contact whiff. The outer third of the arm, likewise, for a punch: the
    // last dozen residues of a helix arm, the outer stretch of both strands of a hairpin.
    const reach = rig.armParam('rarm');
    const fist = D.rarm.filter((_, k) => reach[k] > 0.64);
    const torso = D.torso;
    return {
      name, rig, n, motion, legs, legIdx, fist,
      armIdx: [...D.larm, ...D.rarm], kick: [...D.rleg_shin, ...D.rleg_foot], torso,
      mid: torso[torso.length >> 1],   // a residue in the middle of the body
      // Deterministic per-residue direction, so jitter is stable frame to frame.
      jitterDir: Array.from({ length: n }, (_, i) => {
        const h = k => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
        return [h(1), h(2), h(3)];
      }),
      // The folded chain's own spacing two residues apart: enough stiffness that a
      // collapsing body crumples as a heavy chain rather than pouring out like a liquid,
      // while leaving helices and strands (set by spacing three and four apart) free to
      // come undone.
      localShape: [2].map(gap => [gap, Float32Array.from({ length: n - gap }, (_, i) => {
        const a = rig.bind[i], b = rig.bind[i + gap];
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      })]),
      // PAE map: residue pairs pooled into each pixel, and scratch space.
      pb: Math.ceil(n / PAE_BIN),
      paeCount: null, paeSum: null, paeFrames: new Float64Array(n * 12),
    };
  }
  const FORMS = { barrel: makeForm('barrel', window.HUMANOID_V8_RIG), helix: makeForm('helix', window.HELIX_FIGHTER_RIG) };
  for (const form of Object.values(FORMS)) {
    const { n, pb } = form;
    form.paeCount = new Float32Array(pb * pb); form.paeSum = new Float32Array(pb * pb);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) form.paeCount[(i / PAE_BIN | 0) * pb + (j / PAE_BIN | 0)]++;
  }

  // Which protein each player fights as: the picks on the title screen. A guest picks its
  // own (P2) and tells the host; the host's picks reach the guest with each new round.
  const pick = ['barrel', 'helix'];

  function newFighter(x, facing, form) {
    const N = form.n;
    return {
      form,                          // which protein this is: rig, motion and index sets
      x, y: 0, vx: 0, vy: 0, facing, hp: 100, crouch: false, queued: null, sinceHit: 99,
      squat: 0, jumpDir: 0, upReleased: false, landing: 0, landPower: 0,
      motion: null,                  // motion.js: pose springs, planted feet, the walk cycle
      brain: null,                   // the CPU's footwork, when it is the CPU
      dents: [],                     // recent impacts, springing back
      lastHit: null,                 // where the latest blow landed; a knockout unfolds from there
      fatigue: 0,                    // winded from attacking: deeper breathing, fades over time
      koWave: null, koLoose: null, koBurst: false,
      shock: new Float32Array(N),    // knocked loose by a blow, per residue, fading
      soft: new Float32Array(N),     // the unfolding as shown, easing after the real one
      jit: 5,
      settle: 0,                     // 1 → 0 while a new round's body gathers itself up
      action: 'idle', t: 0, hit: false, stun: 0, cooldown: 0,
      blockStun: 0,                  // braced behind a block, briefly unable to act
      blockHold: 0,                  // the CPU holding back to block, for this long
      unfold: new Float32Array(N),   // 0 folded … 1 denatured, per residue
      limp: 0.8,                     // how loose a fully unfolded residue hangs off the pose
      seed: Math.random() * 100,
      coords: null,
    };
  }

  function attack(f, move) {
    const m = MOVES[move];
    if (!m || f.stun > 0 || f.blockStun > 0 || MOVES[f.action] || f.cooldown > 0) return false;
    if (!!m.air !== f.y > 0) return false;
    Object.assign(f, { action: move, t: 0, hit: false, cooldown: m.duration });
    f.fatigue = Math.min(1, f.fatigue + 0.12);
    return true;
  }

  // ------------------------------------------------------------------- animation
  const clamp01 = n => Math.max(0, Math.min(1, n));
  // How a body moves is motion.js - pose, hips, planted feet, leg IK, the rig - in one
  // pass. The game hands it the fighter and what damage has done to its bearing, and gets
  // back where every residue belongs; what damage does to the chain itself is added here.
  // The more of it has unfolded, the heavier it carries itself: it slumps (sag), nearly
  // gone it tips further forward (crawl), and winded it breathes deeper (tired).
  function bearing(f) {
    const m = meanUnfold(f);
    return { sag: 0.55 * clamp01((m - 0.2) / 0.8), crawl: clamp01((m - 0.7) / 0.3),
      tired: Math.max(0.15, f.fatigue, m), mean: m, kickRange: kickRange(f) };
  }

  // Where each residue belongs this tick: the moving body (motion.js), then what damage
  // does to it. A blow dents it, and unfolded residues get a jitter that breaks the i→i+4
  // geometry, so py2Dmol's own secondary-structure assignment stops calling them helix or
  // strand.
  function targets(f, clock) {
    const { n: N, jitterDir } = f.form;
    const p = f.form.motion.update(f, { clock, dt: TICK, ...bearing(f) });
    // A foot set down sends a ripple through the cytoplasm.
    const M = f.motion;
    if (M && M.stepSeq && M.stepSeq !== f.stepSeen) { f.stepSeen = M.stepSeq; if (f.y === 0) window.Cell?.ripple(M.stepX, f.action === 'walk' ? 1 : 0.6); }
    // A hit breaks the helices over a few frames rather than in one.
    for (let i = 0; i < N; i++) f.soft[i] += (f.unfold[i] - f.soft[i]) * 0.2;
    f.jit += ((f.hp === 0 ? 11 : 5) - f.jit) * 0.05;
    for (let i = 0; i < N; i++) {
      const q = p[i], d = f.soft[i];
      // The dent grows in over a few frames, then bounces back.
      for (const hit of f.dents) q[0] += hit.dir * hit.amp * Math.exp(-DENT_DECAY * hit.t) * Math.sin(DENT_BOUNCE * hit.t) * hit.w[i];
      if (d < 0.01) continue;
      // A fixed offset, not a wobble: it breaks the helix, then holds still. Stronger once
      // knocked out, so the heap is a tangle rather than a tidy kneel.
      const j = jitterDir[i], amp = f.jit * d;
      q[0] += j[0] * amp; q[1] += j[1] * amp; q[2] += j[2] * amp;
    }
    return p;
  }

  // The body. A folded residue sits on its target; an unfolded one is a bead on a
  // chain under gravity, so a denatured protein falls apart onto the floor. Every CA–CA
  // bond ends each tick at exactly CA_STEP. Mid-fight a residue only goes partway limp
  // (f.limp), so a battered protein still stands; a knockout lets go completely.
  const TICK = 1 / 60;

  function body(f, clock) {
    const { n: N, localShape: LOCAL_SHAPE } = f.form;
    const T = targets(f, clock), P = f.coords, u = f.unfold;
    f.targets = T;   // where the pose wanted each residue this tick (for inspection)
    if (!P) { f.prev = T.map(q => q.slice()); return T; }
    // Denatured chain is heavy: the pull on each unfolded residue grows with how unfolded
    // the whole protein is, and a knocked-out protein drops hardest of all.
    const collapsing = f.hp === 0;
    f.settle = Math.max(0, f.settle - TICK / 1.5);
    const fall = GRAVITY * TICK * TICK * (1 + 2 * meanUnfold(f)) * (collapsing ? 1.6 : 1);
    const loose = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // How loosely a residue hangs off its pose: nothing while folded, rising steeply as
      // it unfolds, so only the low-pLDDT stretches swing and sag when the body moves.
      const p = P[i], o = f.prev[i], t = T[i], du = u[i];
      // Knocked out: half-held to the heap while it collapses, then let go as the unfolding
      // wave reaches this residue.
      let d = f.koLoose ? 0.5 + 0.42 * f.koLoose[i] : f.limp * (1 - (1 - du) * (1 - du));
      // A hard blow knocks chain loose for a moment, to fly and swing before it is pulled
      // back; a new round's body gathers itself back up from where the last one left it.
      d = Math.max(d, 0.97 * f.shock[i], 0.96 * Math.sqrt(f.settle));
      f.shock[i] *= 0.955;
      const k = 1 - d, heat = 0;   // no random shaking: unfolded chain moves only when the body does
      loose[i] = d;
      const vx = (p[0] - o[0]) * 0.96, vy = (p[1] - o[1]) * 0.96, vz = (p[2] - o[2]) * 0.96;
      o[0] = p[0]; o[1] = p[1]; o[2] = p[2];
      p[0] += vx + (Math.random() - 0.5) * heat;
      p[1] += vy + (Math.random() - 0.5) * heat - fall * d;
      p[2] += vz + (Math.random() - 0.5) * heat;
      p[0] += (t[0] - p[0]) * k; p[1] += (t[1] - p[1]) * k; p[2] += (t[2] - p[2]) * k;
    }
    // Relax bonds, unfolded residues doing the moving; the floor pushes back with friction.
    for (let it = 0; it < 16; it++) {
      for (let i = 0; i < N - 1; i++) {
        const a = P[i], b = P[i + 1], wa = u[i] * f.limp + 1e-3, wb = u[i + 1] * f.limp + 1e-3;
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz) || 1e-9, s = (l - CA_STEP) / l / (wa + wb);
        a[0] += dx * s * wa; a[1] += dy * s * wa; a[2] += dz * s * wa;
        b[0] -= dx * s * wb; b[1] -= dy * s * wb; b[2] -= dz * s * wb;
      }
      // In a knockout the chain keeps its local shape (helix turns, strand pleats) as it
      // falls, so it crumples under its own weight instead of flowing out like a liquid.
      if (collapsing) for (const [gap, rest] of LOCAL_SHAPE) for (let i = 0; i < N - gap; i++) {
        const a = P[i], b = P[i + gap];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz) || 1e-9, s = 0.25 * (l - rest[i]) / l;
        a[0] += dx * s; a[1] += dy * s; a[2] += dz * s;
        b[0] -= dx * s; b[1] -= dy * s; b[2] -= dz * s;
      }
      const grip = collapsing ? 0.7 : 0.4;
      for (let i = 0; i < N; i++) {
        const p = P[i];
        if (p[1] >= 1) continue;
        const o = f.prev[i];
        p[1] = 1; o[1] = 1; o[0] += (p[0] - o[0]) * grip; o[2] += (p[2] - o[2]) * grip;
      }
    }
    // Bond lengths back to CA_STEP. Intact residues stay exactly where the pose put them:
    // walking the whole chain from one anchor let a dangling loop drag everything after it,
    // folded torso included. Instead each loose stretch is solved on its own. Between two
    // intact residues that is FABRIK (inward from both ends, a few rounds); a stretch that
    // runs off a chain end, or a chain that is loose throughout, is laid out exactly.
    const place = (ref, q) => {
      const dx = q[0] - ref[0], dy = q[1] - ref[1], dz = q[2] - ref[2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) { q[0] = ref[0] + CA_STEP; return; }
      const s = CA_STEP / l;
      q[0] = ref[0] + dx * s; q[1] = ref[1] + dy * s; q[2] = ref[2] + dz * s;
    };
    const LOOSE = 0.02;
    for (let i = 0; i < N;) {
      if (loose[i] < LOOSE) { i++; continue; }
      const a = i;
      while (i < N && loose[i] >= LOOSE) i++;
      const b = i - 1, left = a - 1, right = b + 1;
      if (left < 0 && right >= N) for (let j = 1; j < N; j++) place(P[j - 1], P[j]);
      else if (left < 0) for (let j = b; j >= 0; j--) place(P[j + 1], P[j]);
      else if (right >= N) for (let j = a; j < N; j++) place(P[j - 1], P[j]);
      else for (let round = 0; round < 10; round++) {
        for (let j = b; j >= a; j--) place(P[j + 1], P[j]);
        for (let j = a; j <= b; j++) place(P[j - 1], P[j]);
      }
    }
    return P;
  }

  // The striking end of the limb (see makeForm), where it is now.
  function strikePoints(f, move) {
    const c = f.coords, idx = MOVES[move].fist === 'rarm' ? f.form.fist : f.form.kick;
    return idx.map(i => c[i]);
  }

  // Where a strike lands: the defender's residue closest to any striking residue, if it
  // is within reach. Damage, the dent and the callout all centre on that residue, so the
  // hit shows on the part that was actually struck rather than at the attacker's fist.
  function contact(a, b) {
    let best = null, bestD = REACH;
    for (const s of strikePoints(a, a.action)) for (const q of b.coords) {
      const d = Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]);
      if (d < bestD) { bestD = d; best = q; }
    }
    return best && best.slice();
  }

  // ------------------------------------------------------------------ damage
  const partDamage = (f, idx) => idx.reduce((s, i) => s + f.unfold[i], 0) / idx.length;
  // Unfolded legs still carry a fighter, just slowly: down to a third of the pace.
  const mobility = f => Math.max(0.2, 1 - 0.65 * partDamage(f, f.form.legIdx) - 0.25 * meanUnfold(f));
  // A strike comes from a limb: the more that limb, and the protein as a whole, has
  // unfolded, the slower it plays out (up to ~2.4x) and the less it hurts (down to a quarter).
  const limbOf = (f, move) => MOVES[move]?.fist === 'rarm' ? f.form.armIdx : f.form.legIdx;
  const strikeSlow = f => 1 + 0.9 * partDamage(f, limbOf(f, f.action)) + 0.5 * meanUnfold(f);
  const strikePower = (f, move) => Math.max(0.25, 1 - 0.6 * partDamage(f, limbOf(f, move)) - 0.3 * meanUnfold(f));
  // ...and how far a kick can swing at all: the leg lift and the lean back, as a fraction
  // of a healthy kick. Down to half with the legs and the protein gone: at a third the
  // limp leg never left the floor (the foot peaked 1.7 Å up at 90% unfolded).
  const kickRange = f => Math.max(0.5, 1 - 0.5 * partDamage(f, f.form.legIdx) - 0.3 * meanUnfold(f));

  // Health is how folded the protein still is: 100 intact, 0 fully denatured. It is
  // read off the unfolding, not kept alongside it, so the bar, the colours and the
  // knockout always agree.
  const meanUnfold = f => f.unfold.reduce((s, v) => s + v, 0) / f.unfold.length;
  const health = f => Math.max(0, Math.round(100 * (1 - meanUnfold(f))));
  // pLDDT 100 is intact; fully denatured lands just under 50, AlphaFold's line for
  // disordered, so it reaches the orange band (the palette calls exactly 50 yellow).
  const toPlddt = d => 100 - 50.2 * d;

  // A hit unfolds `amount` percent of the protein, concentrated near the impact.
  // Residues that are already fully unfolded pass their share on. A low hit unfolds
  // the legs, until there is no leg left to unfold.
  function wound(b, at, amount, legsOnly, dir = 0) {
    const { n: N, legs: LEGS } = b.form;
    let budget = amount / 100 * N;
    const weight = new Float32Array(N);
    for (let pass = 0; pass < 8 && budget > 1e-6; pass++) {
      const legsLeft = legsOnly && [...b.unfold].some((v, i) => LEGS[i] && v < 1);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        if (b.unfold[i] >= 1 || (legsLeft && !LEGS[i])) { weight[i] = 0; continue; }
        const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
        weight[i] = Math.exp(-(r * r) / (2 * 26 * 26)) + 0.01;
        sum += weight[i];
      }
      if (sum === 0) break;
      let used = 0;
      for (let i = 0; i < N; i++) {
        if (!weight[i]) continue;
        const add = Math.min(1 - b.unfold[i], budget * weight[i] / sum);
        b.unfold[i] += add; used += add;
      }
      budget -= used;
    }
    // The blow itself: unfolded residues near the impact are knocked along the strike
    // (and a little up) and shaken loose for a moment, so a battered stretch of chain
    // whips instead of just recolouring. The more of the protein has unfolded, the harder
    // and wider the blow throws it. Folded residues sit on their targets and barely notice.
    if (b.prev) {
      const mess = 1 + 1.2 * meanUnfold(b), radius = 30 * (1 + 0.5 * meanUnfold(b));
      const push = Math.min(9, amount * 1.2 * mess), lift = Math.min(4, amount * 0.4 * mess);
      for (let i = 0; i < N; i++) {
        const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
        const w = Math.exp(-(r * r) / (2 * radius * radius)) * b.unfold[i];
        if (w < 0.02) continue;
        b.prev[i][0] -= dir * push * w;   // verlet: velocity is position minus previous
        b.prev[i][1] -= lift * w;
        b.shock[i] = Math.max(b.shock[i], Math.min(0.6, w * (mess - 1) * 0.6));
      }
    }
    b.hp = health(b);
    b.sinceHit = 0;
  }

  // The struck spot gives way: residues around it are pushed in along the blow, then
  // spring back through a couple of shrinking bounces, so it is plain where it landed.
  const DENT_RADIUS = 22, DENT_DECAY = 6, DENT_BOUNCE = 26, DENT_LIFE = 0.8;
  function dentWeights(b, at) {
    const N = b.form.n, w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      w[i] = Math.exp(-(r * r) / (2 * DENT_RADIUS * DENT_RADIUS));
    }
    return w;
  }
  function dent(b, at, dir, power) {
    b.dents.push({ w: dentWeights(b, at), at, dir, amp: 4 + power * 0.45, t: 0 });
    if (b.dents.length > 4) b.dents.shift();
  }

  // ------------------------------------------------------------------- the scene
  let viewer, template;

  // Light: hand-drawn richardson cartoons on white. Dark: solid 3d shading on black.
  // Dark unless this browser has chosen light before.
  const THEME_KEY = 'protein-fighter-theme';
  let theme = (() => {
    try { if (localStorage.getItem(THEME_KEY) === 'light') return 'light'; } catch {}
    return 'dark';
  })();
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      const on = b.dataset.themeChoice === theme;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  // Colouring: pLDDT (damage, as AlphaFold would colour confidence) or a rainbow along
  // the chain, which shows how each protein is threaded. pLDDT unless chosen otherwise.
  const COLOUR_KEY = 'protein-fighter-colour';
  let colour = (() => {
    try { if (localStorage.getItem(COLOUR_KEY) === 'rainbow') return 'rainbow'; } catch {}
    return 'plddt';
  })();
  function applyColour() {
    for (const b of document.querySelectorAll('[data-colour-choice]')) {
      const on = b.dataset.colourChoice === colour;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (viewer) viewer.setColor(colour === 'rainbow' ? 'rainbow' : 'deepmind');   // deepmind: AlphaFold DB pLDDT colours
  }

  function pdbText(a, b) {
    let s = '', n = 1;
    for (const [chain, coords] of [['A', a], ['B', b]]) {
      coords.forEach((q, i) => {
        s += `ATOM  ${String(n++).padStart(5)}  CA  GLY ${chain}${String(i + 1).padStart(4)}    ` +
          q.map(v => v.toFixed(3).padStart(8)).join('') + '  1.00 90.00           C\n';
      });
      s += 'TER\n';
    }
    return s + 'END\n';
  }

  // Ribbons a third wider than the style's own default, so the fighters read at a glance.
  const RIBBON_WIDTH = 1.35;
  function startViewer(a, b) {
    const style = theme === 'dark' ? '3d' : 'richardson';
    const presetWidth = window.py2dmolCartoon?.LOOK_DEFAULTS?.[style]?.width ?? 3;
    viewer = window.py2Dmol.show($('stage'), pdbText(a, b), {
      name: 'arena', style, orient: false, controls: false, play: false,
      select: false, box: false, biounit: false,
      rendering: { width: presetWidth * RIBBON_WIDTH, ortho: 0.4 },   // ortho under 0.5: a touch more perspective
    });
    applyColour();
    // No ground of its own: the page's floor sits behind the proteins, not over them.
    viewer.setClearColor(true);
    // py2Dmol's fast path: a frame whose secondary structure is unchanged updates the
    // cartoon mesh in place instead of rebuilding it (a quarter off each draw here).
    window.py2dmolCartoonGPU?.setStationDraw?.(true);
    template = viewer.objectsData.arena.frames[0];
  }


  // The camera frames the fight. Left unset, py2Dmol centres on the running mean of
  // every frame it has been given, so the view would drift with the fight; instead it
  // is placed here every frame: between the two fighters, close when they are close and
  // pulled back as they part, never past the arena walls, and eased so it glides.
  // Straight on, so neither side looks to have the high ground, and tilted well down
  // onto the arena so the proteins' depth shows. The vertical extent is fixed, so on a
  // landscape screen the fight fills the height as it always did; on a narrow one the
  // width is what binds, and following the fighters is what keeps them on screen.
  // Tilted down enough to give the proteins depth, and no more, so the heads stand clear
  // of the shoulders rather than being looked down onto.
  const CAMERA = { pitch: 0.5, yaw: 0, centerY: 70, x: 0, halfW: 240, minHalfW: 105, room: 80, halfH: 100, shake: 0, bx: 0, by: 0 };
  function frameCamera(dt) {
    const [a, b] = fighters, xa = barrelX(a), xb = barrelX(b);
    let want = Math.min(MAX_GAP / 2 + CAMERA.room, Math.max(CAMERA.minHalfW, Math.abs(xa - xb) / 2 + CAMERA.room));
    let mid = (xa + xb) / 2;
    // A knockout: push in on the loser as it comes apart.
    const loser = phase === 'ko' || phase === 'over' ? fighters.find(f => f.hp === 0) : null;
    if (loser) { want = CAMERA.minHalfW * 0.85; mid = barrelX(loser); }
    const k = 1 - Math.exp(-dt * 5), kz = 1 - Math.exp(-dt * 3);
    CAMERA.x += (mid - CAMERA.x) * k;
    CAMERA.halfW += (want - CAMERA.halfW) * kz;
    // A bump from a heavy blow: the view is knocked a few Å off and settles in a moment.
    CAMERA.shake *= Math.exp(-dt * 9);
    CAMERA.bx = (Math.random() - 0.5) * 2 * CAMERA.shake; CAMERA.by = (Math.random() - 0.5) * 2 * CAMERA.shake;
  }
  // py2Dmol fits the extent into 85% of the stage, whichever of width and height binds:
  // an aspect of halfW by halfH asks for that many Ångström each way.
  function pinCamera() {
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch), cy = Math.cos(CAMERA.yaw), sy = Math.sin(CAMERA.yaw);
    const hx = 0.85 * CAMERA.halfW, hy = CAMERA.halfH, extent = Math.max(hx, hy);
    for (const v of [viewer.viewerState, viewer.objectsData.arena?.viewerState]) {
      if (!v) continue;
      v.center = { x: CAMERA.x + CAMERA.bx, y: CAMERA.centerY + CAMERA.by, z: 0 };
      v.extent = extent;
      v.extentAspect = { x: hx / extent, y: hy / extent };
      v.zoom = 1;
      v.rotation = [[cy, 0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]];   // pitch · yaw
    }
  }
  // The floor is drawn by the page, as a band: its far edge some way behind the feet,
  // its near edge in front. Where those lines fall on screen follows the camera, so the
  // feet stand on the floor at any size of screen.
  // The feet stand between 20 Å behind the pelvis and 25 Å in front of it.
  const FLOOR_FAR_Z = -30, FLOOR_NEAR_Z = 28, GRID = 20;   // Å between the floor's lines
  // py2Dmol's projection, so the page can draw to the same camera: a world point turned
  // into the camera's frame, then, with its partial perspective, scaled by focal / (focal
  // - depth). Returns [screen x, screen y, that scale factor] in stage pixels.
  function view() {
    const stage = $('stage'), W = stage.clientWidth, H = stage.clientHeight;
    const hx = 0.85 * CAMERA.halfW, hy = CAMERA.halfH;
    const scale = Math.min(0.85 * W / (2 * hx), 0.85 * H / (2 * hy));   // px per Å, as py2Dmol fits it
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
    const fl = viewer.viewerState.focalLength || 200, ortho = viewer.viewerState.ortho;
    const cx = CAMERA.x + CAMERA.bx, cy = CAMERA.centerY + CAMERA.by;
    const project = (x, y, z) => {
      const dx = x - cx, dy = y - cy, ry = cp * dy - sp * z, rz = sp * dy + cp * z;
      const c = ortho < 1 ? fl / (fl - rz) : 1;
      return [W / 2 + dx * scale * c, H / 2 - ry * scale * c, c];
    };
    return { W, H, scale, project };
  }
  let floorShown = '';
  function placeFloor() {
    const { W, H, scale, project } = view();
    if (!W || !H) return;
    const line = z => project(CAMERA.x + CAMERA.bx, 0, z)[1];
    const far = line(FLOOR_FAR_Z), depth = line(FLOOR_NEAR_Z) - far;
    // The cell behind everything, and the effects over it, drawn to the same camera.
    window.Cell?.draw($('cell'), $('fx'), { camX: CAMERA.x, scale, project, floorFar: far, floorDepth: depth, theme, t: clock, dt: DT,
      bodies: fighters.map(f => ({ x: barrelX(f), y: f.y, w: 30 })) });
    // The floor's grid is drawn in the world: a line every GRID Å, scrolling with the camera.
    const step = GRID * scale, gridX = W / 2 - (CAMERA.x % GRID) * scale;
    const key = `${far.toFixed(1)}|${depth.toFixed(1)}|${step.toFixed(2)}|${gridX.toFixed(1)}`;
    if (key === floorShown) return;
    floorShown = key;
    const arena = document.querySelector('.arena');
    arena.style.setProperty('--floor-far', far.toFixed(1) + 'px');
    arena.style.setProperty('--floor-depth', depth.toFixed(1) + 'px');
    arena.style.setProperty('--grid-step', step.toFixed(2) + 'px');
    arena.style.setProperty('--grid-x', gridX.toFixed(1) + 'px');
  }

  function draw() {
    const [a, b] = fighters;
    // replaceFrame draws the frame, and (py2Dmol's animation rule) keeps the camera
    // and the mesh where they are, so the cartoon is updated in place, not rebuilt.
    pinCamera();
    placeFloor();
    viewer.replaceFrame({
      ...template,
      coords: a.coords.concat(b.coords),
      plddts: Array.from(a.unfold, toPlddt).concat(Array.from(b.unfold, toPlddt)),
    }, 'arena');
  }

  // ------------------------------------------------------------------- the match
  const held = [new Set(), new Set()];   // directions each player is holding
  let mode = 1;                           // 1: you vs the CPU · 2: two players, one keyboard · 3: a remote challenger (net.js)
  // Remote play. Hosting: `link` streams state to the guest, who drives P2 through held[1].
  // A guest page (?join=…) runs no game of its own: it draws the host's state and sends keys.
  const net = { link: null, guest: !!window.Net?.joinId(), events: [], seq: 0, lastUnfold: null, pkts: 0, bytes: 0, tick: 0 };
  const netEvent = (...e) => { if (net.link) net.events.push(e); };
  let fighters, wins = [0, 0], round = 1, time = 60, phase = 'ready', clock = 0, koTimer = 0, ai = 0, hitstop = 0;
  const names = () => ['P1', 'P2'];   // the CPU is P2 too

  function resetRound() {
    const old = fighters;
    fighters = [newFighter(-80, 1, FORMS[pick[0]]), newFighter(80, -1, FORMS[pick[1]])];
    CAMERA.x = 0;
    clearFinisher();
    netEvent('reset', pick.slice());
    time = 99; koTimer = 0; ai = 1.5; hitstop = 0;
    for (const h of held) h.clear();
    for (const f of fighters) f.coords = body(f, clock);
    // The PAE reference is each fighter as it stands at the bell: healthy, in its stance.
    for (const f of fighters) { f.paeLocal = localPositions(f.coords); f.pae = new Float32Array(f.form.pb * f.form.pb); }
    // Then each body starts from wherever the last round left it, heap and all, and pulls
    // itself back together, rather than popping into place.
    if (old) fighters.forEach((f, i) => {
      if (old[i].form !== f.form) return;
      f.coords = old[i].coords.map(q => q.slice()); f.prev = old[i].coords.map(q => q.slice()); f.settle = 1;
    });
    if (viewer && old && (old[0].form !== fighters[0].form || old[1].form !== fighters[1].form)) startViewer(fighters[0].coords, fighters[1].coords);
  }

  // button: the one way on (resume, next round), or none to offer a choice of mode.
  function overlay(title, msg, button) {
    $('qr').hidden = true; $('joinbox').hidden = true;   // only the REMOTE code shows these
    $('title').textContent = title; $('title').hidden = !title;
    $('msg').textContent = msg; $('msg').hidden = !msg;
    $('go').hidden = !button;
    if (button) $('go').textContent = button;
    $('modes').hidden = !!button;
    $('overlay').hidden = false;
  }

  function start(newMode) {
    startMusic();
    if (phase === 'paused' && !newMode) { phase = 'playing'; $('overlay').hidden = true; return; }
    if (newMode === 3 && !net.link) return hostRemote();   // show the code; the fight starts when the challenger arrives
    if (newMode && newMode !== 3 && net.link) { window.Net.stop(); net.link = null; }
    if (newMode) { mode = newMode; wins = [0, 0]; round = 1; }
    if (phase !== 'ready' || newMode) resetRound();
    phase = 'playing'; $('overlay').hidden = true; $('overlay').classList.remove('ended');
    announce(`ROUND ${Math.min(round, 3)} · FIGHT!`);
    sfx.round();
  }

  function endRound() {
    const [p, c] = fighters;
    const winner = p.hp === c.hp ? -1 : p.hp > c.hp ? 0 : 1;
    if (winner >= 0) wins[winner]++;
    phase = 'over';
    const match = wins.includes(2);
    overlay(winner < 0 ? 'DRAW' : `${names()[winner]} WINS`, '', match ? null : 'REFOLD');
    $('overlay').classList.add('ended');   // no veil: the heap keeps settling behind it
    duckMusic(0.12);
    round++;
  }

  function walk(f, dir, dt, speed = 1) {
    if (f.stun > 0 || f.blockStun > 0 || MOVES[f.action] || f.y > 0) return;
    const pace = (dir === -f.facing ? 0.6 : 1) * mobility(f) * speed;   // backing off is slower; bad legs slower still
    const dx = dir * WALK * pace * dt;
    f.x += dx;
    f.action = dir ? 'walk' : 'idle';
  }

  function jump(f, dir) {
    const legs = mobility(f);   // unfolded legs jump lower and shorter
    f.vy = JUMP_V * (0.55 + 0.45 * legs); f.vx = dir * JUMP_VX * legs; f.y = 0.01; f.crouch = false;
    sfx.jump();
  }

  // Gravity in the air; on the ground, knockback slides out under friction.
  // Landing ends an air attack.
  function physics(f, dt) {
    f.landing = Math.max(0, f.landing - dt);
    if (f.y > 0 || f.vy > 0) {
      if (f.upReleased && f.vy > JUMP_V * SHORT_HOP) f.vy = JUMP_V * SHORT_HOP;   // let go early: a short hop
      f.vy -= GRAVITY * (f.vy < 0 ? FALL_BOOST : 1) * dt;                          // falls faster than it rises
      f.vx *= Math.exp(-AIR_DRAG * dt);
      f.y = Math.max(0, f.y + f.vy * dt);
      if (f.y === 0) {
        f.landPower = clamp01(-f.vy / JUMP_V); f.landing = LANDING; f.vy = 0;
        if (f.landPower > 0.3) sfx.land(f.landPower);
        if (MOVES[f.action]?.air) { f.action = 'idle'; f.t = 0; f.cooldown = 0; }
      }
    } else f.vx *= Math.exp(-FRICTION * dt);
    f.x += f.vx * dt;
  }

  // A player's held directions become movement: walk, down to crouch, up to jump the way
  // you are heading.
  function control(f, h, dt) {
    const dir = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    const free = f.stun <= 0 && f.blockStun <= 0 && !MOVES[f.action] && f.y === 0 && !f.squat;
    f.crouch = (free || f.blockStun > 0) && h.has('down');
    walk(f, f.crouch || f.squat ? 0 : dir, dt);
    if (h.has('up') && free) { f.squat = SQUAT; f.jumpDir = dir; f.upReleased = false; h.delete('up'); }
    if (f.queued) {   // an attack pressed with the jump comes out once airborne
      if (clock > f.queued.until) f.queued = null;
      else if (f.y > 0 && attack(f, f.queued.move)) f.queued = null;
    }
  }

  // How hard the CPU fights: how often it thinks, and how ready it is to attack, jump
  // in, strike from the air, and brace against a blow it sees coming.
  const LEVELS = {
    easy:   { think: [0.7, 0.6], attack: 0.25, jump: 0.1, air: 0.04, block: 0.006, chase: 0.35 },
    normal: { think: [0.4, 0.4], attack: 0.45, jump: 0.2, air: 0.1,  block: 0.02,  chase: 0.5 },
    hard:   { think: [0.22, 0.25], attack: 0.7, jump: 0.3, air: 0.18, block: 0.06, chase: 0.7 },
  };
  const LEVEL_KEY = 'protein-fighter-cpu';
  let level = (() => { try { const v = localStorage.getItem(LEVEL_KEY); if (LEVELS[v]) return v; } catch {} return 'normal'; })();
  function showLevel() {
    for (const b of document.querySelectorAll('[data-level]')) b.classList.toggle('on', b.dataset.level === level);
  }
  // The CPU thinks a couple of times a second, commits to an attack only some of the
  // time, sometimes jumps in, and sits out the round-start callout.
  function cpu(c, p, dt) {
    const L = LEVELS[level];
    // Spacing is read off the barrels as drawn (the gap between them, last tick), put
    // back on the old centre-to-centre scale the thresholds below were tuned on.
    const gap = (c.barrelGap ?? Math.abs(p.x - c.x) - BARREL_SPAN) + BARREL_SPAN;
    const toward = Math.sign(barrelX(p) - barrelX(c)) || 1;
    ai -= dt;
    if (ai <= 0) {
      ai = L.think[0] + Math.random() * L.think[1];
      const free = c.stun <= 0 && !MOVES[c.action] && c.y === 0 && !c.squat;
      if (free && gap > 90 && gap < 160 && Math.random() < L.jump) { c.squat = SQUAT; c.jumpDir = toward; c.upReleased = false; }
      else if (free && gap < 75 && Math.random() < L.attack) {
        const r = Math.random();
        attack(c, r < 0.4 ? 'punch' : r < 0.7 ? 'kick' : r < 0.85 ? 'lowkick' : 'lowpunch');
      }
    }
    if (c.y > 30 && gap < 70 && Math.random() < L.air) attack(c, Math.random() < 0.6 ? 'airkick' : 'airpunch');
    // Sees a strike coming: some of the time it braces, crouching for a low one, standing
    // for one from the air, and holds the guard a little past the blow.
    const pm = MOVES[p.action];
    if (pm && p.t < pm.active && gap < 85 && c.blockHold <= 0 && c.y === 0 && c.stun <= 0 && !MOVES[c.action] && Math.random() < L.block) {
      c.blockHold = 0.45; c.crouch = !!pm.low;
    }
    if (c.blockHold > 0) { if (c.crouch && !(pm && pm.low)) c.crouch = false; }
    else if (c.crouch && c.blockStun <= 0) c.crouch = false;
    // Footwork with a margin. It closes in at half a walk until it reaches its spacing, then
    // holds until the gap has opened 18 Å past that, and never sets off again within 0.4 s
    // of stopping. On a single threshold it flipped between walking and standing every few
    // frames, as its own breathing moved the barrel back and forth across the line: a twitch.
    const B = c.brain ??= { approach: true, since: 1 };
    const spacing = 62;
    B.since += dt;
    if (B.approach && gap <= spacing) { B.approach = false; B.since = 0; }
    else if (!B.approach && gap > spacing + 18 && B.since > 0.4) { B.approach = true; B.since = 0; }
    // Half a walk to close in, but a full one to catch up, and to run down a player who
    // keeps backing off (backing off is the slower walk, so it is caught).
    const fleeing = p.action === 'walk' && held[0].has(toward > 0 ? 'right' : 'left');
    walk(c, B.approach ? toward : 0, dt, fleeing || gap > 130 ? 1 : L.chase);
  }

  // Bodies push each other only where they actually touch: the two torsos (the β-barrel,
  // the helix bundle) as they are drawn this tick, leaning, lunging and all. Arms and
  // legs pass by each other (a strike is judged by contact() instead), and a jump clears
  // the other fighter because its torso is higher, not because of a height rule.
  const TOUCH = 7;   // Å: nearest CA of one torso to the other's, at which they are in contact
  // The CPU's spacing thresholds were tuned as centre distances with contact forced at
  // 42 Å; adding this to the barrel gap keeps each one the same distance from contact.
  const BARREL_SPAN = 42 - TOUCH;
  const barrelX = f => f.form.torso.reduce((s, i) => s + f.coords[i][0], 0) / f.form.torso.length;
  function barrelGap(a, b) {
    let best = Infinity;
    for (const i of a.form.torso) {
      const q = a.coords[i];
      for (const j of b.form.torso) {
        const r = b.coords[j], dx = q[0] - r[0], dy = q[1] - r[1], dz = q[2] - r[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
  // Move a whole body along x, velocity untouched.
  function slide(f, dx) {
    f.x += dx;
    for (let i = 0; i < f.form.n; i++) { f.coords[i][0] += dx; f.prev[i][0] += dx; }
    return Math.abs(dx);
  }
  // Neither fighter can back away beyond the frame: the one moving off past MAX_GAP is
  // stopped there, as by a wall, while the other can still close in.
  function keepTogether() {
    for (const f of fighters) {
      const o = fighters[1 - fighters.indexOf(f)], d = f.x - o.x;
      if (Math.abs(d) > MAX_GAP) f.x = o.x + Math.sign(d) * MAX_GAP;
    }
  }
  function collide(a, b) {
    for (let it = 0; it < 4; it++) {
      const gap = barrelGap(a, b);
      a.barrelGap = b.barrelGap = gap;
      if (gap >= TOUCH) return;
      // Apart along x, each giving half; one against the wall leaves the other the rest.
      const s = barrelX(a) <= barrelX(b) ? 1 : -1, need = TOUCH - gap + 0.2;
      const moved = slide(a, -s * need / 2) + slide(b, s * need / 2);
      if (moved < need - 1e-6) slide(a, -s * (need - moved)), slide(b, s * (need - moved));
    }
  }

  function step(dt) {
    const [p, c] = fighters;
    time = Math.max(0, time - dt);
    for (const f of fighters) {
      f.t += MOVES[f.action] ? dt / strikeSlow(f) : dt;   // a battered limb strikes slower
      f.stun = Math.max(0, f.stun - dt); f.cooldown = Math.max(0, f.cooldown - dt);
      f.blockStun = Math.max(0, f.blockStun - dt); f.blockHold = Math.max(0, f.blockHold - dt);
      f.fatigue = Math.max(0, f.fatigue - dt * 0.08);
      physics(f, dt);
      f.dents = f.dents.filter(hit => (hit.t += dt) < DENT_LIFE);
      if (f.squat > 0 && (f.squat -= dt) <= 0) { f.squat = 0; jump(f, f.jumpDir); }
      if (MOVES[f.action] && f.t >= MOVES[f.action].duration) { f.action = 'idle'; f.t = 0; }
      // Left alone for a moment, a protein slowly refolds; lightly damaged spots first.
      f.sinceHit += dt;
      if (f.hp > 0 && f.sinceHit > REFOLD_DELAY) {
        let changed = false;
        for (let i = 0; i < f.form.n; i++) if (f.unfold[i] > 0) { f.unfold[i] = Math.max(0, f.unfold[i] - REFOLD * dt); changed = true; }
        if (changed) f.hp = health(f);
      }
    }

    control(p, held[0], dt);
    if (mode === 2 || mode === 3) control(c, held[1], dt);
    else cpu(c, p, dt);

    keepTogether();

    // Bodies, then contact between them, then hits against the bodies as they are now
    for (const f of fighters) f.coords = body(f, clock);
    collide(p, c);
    // Facing only turns on the ground, so a cross-up hits from the far side, and only once
    // the other barrel is clearly past, so two barrels level with each other cannot flip it.
    for (const [f, o] of [[p, c], [c, p]]) {
      if (f.y === 0 && !MOVES[f.action] && (barrelX(o) - barrelX(f)) * f.facing < -3) f.facing = -f.facing;
    }
    // Hits are the host's call: a guest replays them from its events.
    if (!net.guest) fighters.forEach((a, i) => {
      const m = MOVES[a.action], b = fighters[1 - i];
      // Live from most of the way out, so a strike thrown point-blank lands where it meets
      // the body instead of passing through it before the active frame.
      if (!m || a.hit || a.t < m.active * 0.6 || b.hp === 0) return;
      if (a.t > m.active + m.window) { a.hit = true; sfx.whiff(); return; }   // whiffed
      const at = contact(a, b);
      if (!at) return;
      // A strike is only as strong as the part throwing it (unfolded arms punch weaker,
      // unfolded legs kick weaker) and weakens further as the whole protein comes apart.
      // Everything a blow does follows its strength: the damage, and also how far it
      // shoves, how deep it dents, how long it stuns and how hard it lands on screen.
      const power = strikePower(a, a.action);
      if (canBlock(b, 1 - i, m)) {
        blockHit(i, a.action, at, power);
        netEvent('block', i, a.action, at, power);
        flash(at, 'BLOCK');
        sfx.block();
        return;
      }
      landHit(i, a.action, at, power);
      netEvent('hit', i, a.action, at, power);
      flash(at, m.text);
      sfx.hit(m.damage * power / 13);
    });

    if (fighters.some(f => f.hp === 0) || time === 0) {
      phase = 'ko'; koTimer = 0; finished = false;
      for (const f of fighters) if (f.hp === 0) denature(f);
      if (!fighters.some(f => f.hp === 0)) announce('TIME');
      sfx.ko();
    }
  }

  // Blocking, as Street Fighter has it: hold back (away from the attacker) on the ground,
  // not in the middle of anything, and the blow is taken on the guard. A low blow gets
  // under a standing guard and must be blocked crouching; one from the air comes over a
  // crouching guard and must be blocked standing. The CPU holds back for a moment of its
  // own accord now and then (blockHold).
  function canBlock(b, j, m) {
    if (b.y > 0 || b.stun > 0 || MOVES[b.action] || b.hp === 0) return false;
    const back = b.facing > 0 ? 'left' : 'right';
    if (!(b.blockHold > 0 || held[j].has(back))) return false;
    return m.low ? b.crouch : m.overhead ? !b.crouch : true;
  }
  // A blocked blow: no damage, a short brace, a shove back, and the guard arms jolted.
  function blockHit(i, move, at, power) {
    const a = fighters[i], b = fighters[1 - i], m = MOVES[move];
    a.hit = true;
    b.vx = a.facing * m.push * 0.55 * power;
    b.blockStun = m.stun * 0.75; b.lastHit = at;
    b.form.motion.jolt(b, { arms: (a.facing * b.facing < 0 ? -1 : 1) * 3 * power, head: 0, legs: m.low ? 3 : 1 });
    hitstop = 0.03;
    window.Cell?.spark(at, a.facing, m.damage * power * 0.5, 'block');
    CAMERA.shake = Math.min(3, 0.8 + m.damage * power * 0.15);
  }

  // A blow from fighter i's `move` landing at `at` with this much of its strength.
  function landHit(i, move, at, power) {
    const a = fighters[i], b = fighters[1 - i], m = MOVES[move];
    a.hit = true;
    b.vx = a.facing * m.push * power;
    wound(b, at, m.damage * DAMAGE_SCALE * power, m.low, a.facing);
    dent(b, at, a.facing, m.damage * power);
    b.lastHit = at;
    // The blow throws the parts about: struck in the head, the head whips on its neck
    // away from the blow (a hit from behind snaps it forward); struck anywhere, the
    // arms fly and the legs buckle, a low blow most of all.
    const high = at[1] > b.motion.hip[1] + b.form.motion.NECK_HEIGHT - 8;
    const away = a.facing * b.facing < 0 ? -1 : 1;
    b.form.motion.jolt(b, { head: away * (high ? 24 : 8) * power, arms: away * 5 * power, legs: (m.low ? 6 : 2.5) * power });
    // A hit on a fighter still reeling from the last, or still in the air from it, runs
    // the combo on; the count shows over the one taking it, with each hit's damage.
    a.combo = (b.stun > 0 || b.comboAir) ? (a.combo || 0) + 1 : 1;
    b.comboAir = b.y > 0;
    const dmg = Math.round(m.damage * DAMAGE_SCALE * power * 10) / 10;
    damageNumber(at, dmg, a.combo);
    b.stun = m.stun * (0.4 + 0.6 * power); b.action = 'hurt'; b.t = 0; b.squat = 0; b.lastLow = !!m.low;
    if (b.y > 0) b.vy = Math.max(b.vy, 260);   // hit in the air: popped up, then falls
    hitstop = 0.05 + m.damage * 0.004 * power;
    window.Cell?.spark(at, a.facing, m.damage * power, 'hit');
    CAMERA.shake = Math.min(7, 1.5 + m.damage * power * 0.4);
    if (b.hp === 0) { b.action = 'ko'; b.t = 0; }
  }

  // Denaturing, in two acts. First the collapse: the knees give and the body drops into a
  // heap under its own weight, the chain still loosely holding the pose. Then the
  // unfolding: from where the last blow landed, a wave runs out along the chain, and each
  // residue it reaches lets go of the heap, with a shove outward as the fold breaks,
  // until a tangle lies spread on the floor.
  const COLLAPSE = 0.45, UNFOLD = 1.6, KO_HOLD = 3.4;   // seconds
  let finished = false;   // the finisher has been called this knockout
  function denature(f) {
    const N = f.form.n, at = f.lastHit || f.coords[f.form.mid];
    let brk = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const q = f.coords[i], d = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      if (d < bestD) { bestD = d; brk = i; }
    }
    f.koBrk = brk;
    f.koWave = Float32Array.from({ length: N }, (_, i) => Math.abs(i - brk) / N);   // 0 at the break, further along the chain after
    f.koLoose = new Float32Array(N);
    f.koBurst = false;
  }
  function letGo(f) {
    const c = f.coords, N = f.form.n;
    let cx = 0, cy = 0, cz = 0;
    for (const q of c) { cx += q[0] / N; cy += q[1] / N; cz += q[2] / N; }
    for (let i = 0; i < N; i++) {
      const q = c[i], dx = q[0] - cx, dy = q[1] - cy, dz = q[2] - cz, l = Math.hypot(dx, dy, dz) || 1;
      const s = 3.5 / Math.sqrt(l / 10 + 1);
      f.prev[i][0] -= dx / l * s; f.prev[i][1] -= dy / l * s + 1; f.prev[i][2] -= dz / l * s;   // verlet: velocity is position minus previous
    }
  }

  function stepKO(dt) {
    koTimer += dt;
    for (const f of fighters) {
      f.t += dt;
      physics(f, dt);   // a finishing blow still carries the loser
      f.dents = f.dents.filter(hit => (hit.t += dt) < DENT_LIFE);
      if (f.hp === 0 && f.koWave) {
        if (koTimer > COLLAPSE && !f.koBurst) { f.koBurst = true; letGo(f); }
        const front = (koTimer - COLLAPSE) / UNFOLD;   // how far the wave has run, in chain lengths
        for (let i = 0; i < f.form.n; i++) {
          f.unfold[i] = Math.min(1, f.unfold[i] + dt * 0.55);
          f.koLoose[i] = clamp01((front - f.koWave[i]) * 2.5);
        }
      }
      if (f.hp > 0) {   // the one still standing lets its guard down and rests
        f.stun = Math.max(0, f.stun - dt);
        if (!MOVES[f.action] || f.t >= MOVES[f.action].duration) f.action = 'rest';
        f.crouch = false; f.squat = 0; f.queued = null;
      }
      f.coords = body(f, clock);
    }
    if (net.guest) return;   // the word and the round's end come from the host
    // Once the loser has dropped into its heap, the word.
    if (phase === 'ko' && !finished && koTimer > COLLAPSE + 0.1 && fighters.some(f => f.hp === 0)) { finished = true; finisher('DENATURED'); }
    if (phase === 'ko' && koTimer > KO_HOLD) endRound();
  }

  // ------------------------------------------------------------------------ HUD
  function flash(at, text) {
    netEvent('flash', at[0], text);
    const el = $('impact');
    el.textContent = text;
    el.style.left = 50 + at[0] * 0.28 + '%';
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const announce = text => flash([0, 0, 0], text);
  // A small number floating up from the impact, and past two hits the combo's count.
  function damageNumber(at, dmg, combo) {
    const box = $('nums'), { project } = view(), [X, Y] = project(at[0], at[1], at[2]);
    const el = document.createElement('span');
    el.className = 'num'; el.textContent = `-${dmg}`;
    el.style.left = X + 'px'; el.style.top = Y + 'px';
    box.appendChild(el); setTimeout(() => el.remove(), 900);
    if (combo >= 2) {
      const c = document.createElement('span');
      c.className = 'num combo'; c.textContent = `${combo} HITS`;
      c.style.left = X + 'px'; c.style.top = (Y - 28) + 'px';
      box.appendChild(c); setTimeout(() => c.remove(), 1100);
    }
  }
  // The finisher, Mortal Kombat style: the word slams in a letter at a time over the
  // collapsing loser, the arena shakes, and the announcer growls it.
  function finisher(text, silent = false) {
    netEvent('finish', text);
    const el = $('finish');
    el.innerHTML = '';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch; s.style.animationDelay = (i * 0.075) + 's';
      el.appendChild(s);
    });
    el.hidden = false; el.classList.remove('settle');
    setTimeout(() => el.classList.add('settle'), text.length * 75 + 350);
    const arena = document.querySelector('.arena');
    arena.classList.remove('shake'); void arena.offsetWidth; arena.classList.add('shake');
    if (!silent) sfx.denatured();
  }
  const clearFinisher = () => { const el = $('finish'); el.hidden = true; el.innerHTML = ''; el.classList.remove('settle'); };

  // The health bar is the average pLDDT, in the same AlphaFold bands as the protein.
  const bandColor = plddt => plddt >= 90 ? '#0d57d3' : plddt >= 70 ? '#6acbf1' : plddt >= 50 ? '#fed936' : '#fd7d4d';

  // ------------------------------------------------------------------------ PAE
  // A predicted aligned error map for each fighter, computed the way AlphaFold defines
  // the error it predicts: superpose the structure on residue i, then measure how far
  // residue j sits from where it belongs. AlphaFold aligns on each residue's backbone
  // frame (N, CA, C); a C-alpha trace has only the alpha carbons, so residue i's frame is
  // built from CA i-1, i and i+1, with its origin on i. Where j belongs is where it sat
  // in i's frame at the bell, so cell (i, j) is
  //     | R_i (x_j - o_i)  -  R0_i (x0_j - o0_i) |
  // with R, o residue i's frame now and R0, o0 its frame at the start of the round.
  // Moving the whole protein changes nothing; an arm swinging lights up arm against body
  // and body against arm; a stretch that unfolds scrambles its own frames, so its rows go
  // white against everything. Every residue against every residue, averaged four by four
  // into a map a pixel per PAE_BIN residues each way: the row is the residue aligned on,
  // the column the one scored.
  const PAE_MAX = 30;
  // Residue i's frame, twelve numbers: the origin, then three orthonormal axes.
  function localFrames(coords, F) {
    const N = coords.length;
    for (let i = 0; i < N; i++) {
      const c = Math.min(N - 2, Math.max(1, i));   // the two chain ends borrow their neighbour's frame
      const a = coords[c - 1], o = coords[c], b = coords[c + 1];
      let x1 = b[0] - o[0], y1 = b[1] - o[1], z1 = b[2] - o[2];
      let l = Math.hypot(x1, y1, z1) || 1; x1 /= l; y1 /= l; z1 /= l;
      let x2 = a[0] - o[0], y2 = a[1] - o[1], z2 = a[2] - o[2];
      const d = x2 * x1 + y2 * y1 + z2 * z1; x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
      l = Math.hypot(x2, y2, z2) || 1; x2 /= l; y2 /= l; z2 /= l;
      const k = i * 12;
      F[k] = o[0]; F[k + 1] = o[1]; F[k + 2] = o[2];
      F[k + 3] = x1; F[k + 4] = y1; F[k + 5] = z1;
      F[k + 6] = x2; F[k + 7] = y2; F[k + 8] = z2;
      F[k + 9] = y1 * z2 - z1 * y2; F[k + 10] = z1 * x2 - x1 * z2; F[k + 11] = x1 * y2 - y1 * x2;
    }
    return F;
  }
  // Every residue's position in every residue's frame, N x N x 3: the reference.
  function localPositions(coords) {
    const N = coords.length, F = localFrames(coords, new Float64Array(N * 12)), L = new Float32Array(N * N * 3);
    for (let i = 0; i < N; i++) {
      const k = i * 12;
      for (let j = 0, m = i * N * 3; j < N; j++, m += 3) {
        const q = coords[j], vx = q[0] - F[k], vy = q[1] - F[k + 1], vz = q[2] - F[k + 2];
        L[m] = F[k + 3] * vx + F[k + 4] * vy + F[k + 5] * vz;
        L[m + 1] = F[k + 6] * vx + F[k + 7] * vy + F[k + 8] * vz;
        L[m + 2] = F[k + 9] * vx + F[k + 10] * vy + F[k + 11] * vz;
      }
    }
    return L;
  }
  function updatePAE(f) {
    if (!f.paeLocal) return;
    const { n: N, pb: PB, paeCount: PAE_COUNT, paeSum, paeFrames } = f.form;
    const P = f.coords, F = localFrames(P, paeFrames), L = f.paeLocal;
    paeSum.fill(0);
    for (let i = 0; i < N; i++) {
      const k = i * 12, row = (i / PAE_BIN | 0) * PB;
      const ox = F[k], oy = F[k + 1], oz = F[k + 2];
      const ax = F[k + 3], ay = F[k + 4], az = F[k + 5];
      const bx = F[k + 6], by = F[k + 7], bz = F[k + 8];
      const cx = F[k + 9], cy = F[k + 10], cz = F[k + 11];
      for (let j = 0, m = i * N * 3; j < N; j++, m += 3) {
        const q = P[j], vx = q[0] - ox, vy = q[1] - oy, vz = q[2] - oz;
        const dx = ax * vx + ay * vy + az * vz - L[m];
        const dy = bx * vx + by * vy + bz * vz - L[m + 1];
        const dz = cx * vx + cy * vy + cz * vz - L[m + 2];
        paeSum[row + (j / PAE_BIN | 0)] += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    for (let b = 0; b < PB * PB; b++) {
      const e = Math.min(PAE_MAX, paeSum[b] / PAE_COUNT[b]);
      f.pae[b] = f.pae[b] * 0.5 + e * 0.5;   // barely smoothed, so one frame's twitch does not flicker
    }
  }
  function drawPAE(f, i) {
    const canvas = $('pae' + i), PB = f.form.pb;
    if (!canvas || !f.pae) return;
    if (canvas.width !== PB) canvas.width = canvas.height = PB;   // a pixel per PAE_BIN residues, whatever the protein's length
    const g = canvas.getContext('2d'), img = g.createImageData(PB, PB), px = img.data;
    for (let k = 0; k < PB * PB; k++) {
      const t = f.pae[k] / PAE_MAX, o = k * 4;   // dark green (confident) → white
      px[o] = 30 + 225 * t; px[o + 1] = 110 + 145 * t; px[o + 2] = 50 + 205 * t; px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  // Only what changed is written, so the page isn't restyled every frame for nothing.
  const shown = {};
  const setText = (id, v) => { if (shown[id] !== v) { shown[id] = v; $(id).textContent = v; } };
  const setStyle = (id, k, v) => { if (shown[id + k] !== v) { shown[id + k] = v; $(id).style[k] = v; } };
  function hud() {
    fighters.forEach((f, i) => {
      const plddt = toPlddt(meanUnfold(f));
      setStyle('hp' + i, 'width', f.hp + '%');
      setStyle('hp' + i, 'background', bandColor(plddt));
      setText('fold' + i, `pLDDT ${Math.round(plddt)}`);
      setText('wins' + i, [0, 1].map(n => (wins[i] > n ? '●' : '○')).join(' '));
    });
    setText('name1', names()[1]);
    if ($('p2pad').hidden !== (mode !== 2)) $('p2pad').hidden = mode !== 2;
    setText('timer', String(Math.ceil(time)).padStart(2, '0'));
    setText('round', 'ROUND ' + String(Math.min(round, 3)).padStart(2, '0'));
  }

  // ---------------------------------------------------------------------- sound
  // Synthesised, nothing to download: noise bursts and falling tones through a short
  // reverb and a compressor, so hits land heavy. On by default; browsers start the
  // audio at the first click or key press.
  let audio, bus, noiseBuf, sound = true;
  function out() {
    if (!sound) return null;
    try {
      if (!audio) {
        audio = new AudioContext();
        const comp = audio.createDynamicsCompressor();
        comp.threshold.value = -18; comp.ratio.value = 6;
        const len = audio.sampleRate * 1.4, ir = audio.createBuffer(2, len, audio.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        }
        const verb = audio.createConvolver(), wet = audio.createGain();
        verb.buffer = ir; wet.gain.value = 0.25;
        bus = audio.createGain(); bus.gain.value = 0.9;
        bus.connect(comp); bus.connect(verb).connect(wet).connect(comp);
        comp.connect(audio.destination);
      }
      if (audio.state === 'suspended') audio.resume();
      return audio;
    } catch { return null; }
  }
  function tone(freq, to, dur, { type = 'sine', gain = 0.3, delay = 0, dest = null } = {}) {
    const a = out(); if (!a) return;
    dest = dest || bus;   // the bus exists once out() has run, which may be only now (a guest hears sounds before it has touched anything)
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, from, to, { gain = 0.3, filter = 'lowpass', delay = 0, dest = null } = {}) {
    const a = out(); if (!a) return;
    dest = dest || bus;
    if (!noiseBuf) {   // one shared two seconds of noise, each burst starting somewhere in it
      noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + delay;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; f.type = filter;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest); src.start(t, Math.random() * Math.max(0, 1.95 - dur)); src.stop(t + dur + 0.02);
  }

  // Battle music: a driving theme in D minor, synthesised like the effects and scheduled
  // a little ahead on the audio clock. Drums, a galloping bass and string chords under
  // Dm–B♭–F–C; every other four bars a brass-like lead comes in over the top.
  const BPM = 140, STEP16 = 60 / BPM / 4;
  const CHORDS = [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55]];
  const LEAD = [
    [74, 0, 74, 77, 76, 0, 74, 0], [70, 0, 70, 74, 72, 0, 70, 0],
    [72, 0, 72, 77, 76, 0, 72, 0], [76, 0, 76, 79, 77, 0, 76, 74],
  ];
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  let musicBus = null, musicTimer = 0, musicStep = 0, musicAt = 0;
  function voice(m, t, dur, { type = 'sawtooth', gain = 0.1, cutoff = 1800, attack = 0.01, detune = 0 } = {}) {
    const o = audio.createOscillator(), lp = audio.createBiquadFilter(), g = audio.createGain();
    o.type = type; o.frequency.value = mtof(m); o.detune.value = detune;
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(gain * 0.6, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(musicBus); o.start(t); o.stop(t + dur + 0.05);
  }
  function bar16(i, t) {
    const bar = Math.floor(i / 16) % 8, s = i % 16, chord = CHORDS[bar % 4];
    const at = { delay: t - audio.currentTime, dest: musicBus };
    if ([0, 3, 8, 10].includes(s) || (bar % 2 === 1 && s === 14)) tone(130, 42, 0.25, { gain: 0.8, ...at });   // kick
    if (s === 4 || s === 12) { noise(0.2, 5000, 1200, { gain: 0.4, ...at }); tone(210, 140, 0.08, { type: 'triangle', gain: 0.25, ...at }); }   // snare
    if (s % 2 === 0) noise(0.035, 9000, 6000, { gain: s % 4 === 2 ? 0.1 : 0.05, filter: 'highpass', ...at });   // hats
    if (bar === 7 && s >= 12) tone(190 - (s - 12) * 30, 60, 0.2, { gain: 0.5, ...at });   // tom fill into the top
    if (bar === 0 && s === 0) noise(1.6, 9000, 2500, { gain: 0.2, filter: 'highpass', ...at });   // crash
    if (s % 4 !== 1) voice(chord[0] - 12 + (s === 6 || s === 14 ? 12 : 0), t, STEP16 * 1.6, { gain: 0.16, cutoff: 700 });   // bass
    if (s === 0) for (const n of chord) for (const detune of [-8, 8])   // strings, a chord a bar
      voice(n + 12, t, STEP16 * 15, { gain: 0.03, cutoff: 2200, attack: 0.08, detune });
    if (bar >= 4 && s % 2 === 0) {   // lead
      const line = LEAD[bar - 4], k = s / 2, n = line[k];
      if (n) {
        const dur = STEP16 * (line[k + 1] === 0 ? 4 : 2) * 0.95;
        voice(n, t, dur, { gain: 0.07, cutoff: 2600, detune: 5 });
        voice(n - 12, t, dur, { gain: 0.04, cutoff: 1800, detune: -5 });
      }
    }
  }
  // Starts the theme, or brings it back up to full; `duckMusic` lowers it between rounds.
  function startMusic() {
    if (!out()) return;
    if (!musicBus) { musicBus = audio.createGain(); musicBus.gain.value = 0; musicBus.connect(bus); }
    musicBus.gain.setTargetAtTime(0.3, audio.currentTime, 0.3);
    if (musicTimer) return;
    musicAt = audio.currentTime + 0.1;
    musicTimer = setInterval(() => {
      if (musicAt < audio.currentTime) musicAt = audio.currentTime + 0.05;   // after the tab slept, pick up from now
      while (musicAt < audio.currentTime + 0.2) { bar16(musicStep++, musicAt); musicAt += STEP16; }
    }, 50);
  }
  function stopMusic() { clearInterval(musicTimer); musicTimer = 0; }
  const duckMusic = level => { if (musicBus) musicBus.gain.setTargetAtTime(level, audio.currentTime, 0.5); };
  const sfx = {
    hit(p) {   // p: 0 light … 1+ heavy
      tone(140, 38, 0.28, { gain: 0.5 * p + 0.2 });
      noise(0.18, 3000, 200, { gain: 0.45 * p + 0.15 });
      tone(900, 180, 0.07, { type: 'square', gain: 0.08 });
    },
    block() { tone(1500, 900, 0.09, { type: 'triangle', gain: 0.18 }); noise(0.05, 4000, 2000, { gain: 0.12, filter: 'highpass' }); },
    whiff() { noise(0.12, 700, 2400, { gain: 0.06, filter: 'bandpass' }); },
    jump() { noise(0.16, 300, 1400, { gain: 0.07, filter: 'bandpass' }); },
    land(p) { tone(110, 35, 0.14, { gain: 0.35 * p }); noise(0.1, 600, 120, { gain: 0.15 * p }); },
    round() {   // a rising sting, then a boom on FIGHT
      [220, 277, 330, 440].forEach((f, i) => tone(f, f * 0.98, 0.35, { type: 'sawtooth', gain: 0.07, delay: i * 0.09 }));
      tone(55, 40, 0.9, { gain: 0.35, delay: 0.36 });
      noise(0.5, 5000, 300, { gain: 0.2, delay: 0.36 });
    },
    denatured() {   // the announcer: three low, rough syllables, DE-NA-TURED, and a hit under the last
      for (const [f0, f1, dur, delay, g] of [[112, 84, 0.22, 0, 0.5], [100, 78, 0.22, 0.26, 0.5], [92, 46, 0.7, 0.52, 0.6]]) {
        tone(f0, f1, dur, { type: 'sawtooth', gain: g * 0.55, delay });
        tone(f0 * 1.5, f1 * 1.5, dur, { type: 'square', gain: g * 0.12, delay });
        tone(f0 / 2, f1 / 2, dur, { gain: g * 0.7, delay });
        noise(dur, 900, 250, { gain: g * 0.25, filter: 'bandpass', delay });
      }
      tone(50, 30, 1.2, { gain: 0.6, delay: 0.55 });
      noise(0.6, 2500, 120, { gain: 0.35, delay: 0.55 });
    },
    ko() {     // a long collapse, and a second impact as it hits the floor
      tone(260, 28, 1.4, { type: 'sawtooth', gain: 0.18 });
      tone(60, 25, 1.8, { gain: 0.5 });
      noise(1.2, 1500, 60, { gain: 0.35 });
      noise(0.5, 3000, 200, { gain: 0.3, delay: 0.45 });
      tone(90, 30, 0.8, { gain: 0.4, delay: 0.45 });
    },
  };

  for (const k of Object.keys(sfx)) { const fn = sfx[k]; sfx[k] = (...a) => { fn(...a); netEvent('sfx', k, ...a); }; }

  // ---------------------------------------------------------------------- input
  // One keyboard, two players, as Street Fighter on a PC: P1 on the left hand side,
  // P2 on the right. Playing the CPU, every key drives P1, and J/K punch and kick too.
  const BINDINGS = [
    { w: 'up', a: 'left', s: 'down', d: 'right', f: 'punch', g: 'kick' },
    { arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right', '.': 'punch', '/': 'kick', 1: 'punch', 2: 'kick' },
  ];
  const SOLO = { j: 'punch', k: 'kick' };
  function route(k) {
    if (BINDINGS[0][k]) return [0, BINDINGS[0][k]];
    if (mode !== 2 && SOLO[k]) return [0, SOLO[k]];
    if (BINDINGS[1][k]) return [mode === 2 ? 1 : 0, BINDINGS[1][k]];
    return null;
  }

  // Buttons pressed together are read together: an attack pressed with or just after
  // up waits for take-off and comes out in the air, and one pressed a moment before up
  // is cancelled into the jump. So up + forward + kick is a jump kick in whatever
  // order the fingers land. J/K (or F/G) crouching are low attacks.
  const BUFFER = 0.3, CANCEL = 0.12;
  function strike(i, kind) {
    const f = fighters[i], h = held[i];
    if (f.y === 0 && (h.has('up') || f.squat > 0)) { f.queued = { move: 'air' + kind, until: clock + BUFFER }; return; }
    attack(f, f.y > 0 ? 'air' + kind : h.has('down') ? 'low' + kind : kind);
  }
  function jumpCancel(i) {
    const f = fighters[i], m = MOVES[f.action];
    if (!m || m.air || f.y > 0 || f.t > Math.max(CANCEL, m.active) || f.hit) return;   // any time before it comes out
    f.queued = { move: 'air' + (f.action.endsWith('punch') ? 'punch' : 'kick'), until: clock + BUFFER };
    f.action = 'idle'; f.t = 0; f.cooldown = 0;
  }

  function press(k) {
    if (net.guest) return guestPress(k);   // acts here at once, and tells the host
    if (k === 'escape') {
      if (phase === 'playing') { phase = 'paused'; for (const h of held) h.clear(); overlay('PAUSED', '', 'RESUME'); duckMusic(0.08); }
      else if (phase === 'paused') start();
      return;
    }
    if (phase !== 'playing') {
      if (k === ' ' || k === 'enter') start(phase === 'over' && !wins.includes(2) ? undefined : mode);
      return;
    }
    const r = route(k);
    if (!r) return;
    const [i, act] = r;
    if (act === 'punch' || act === 'kick') return strike(i, act);
    if (act === 'up') jumpCancel(i);
    held[i].add(act);
  }

  // The on-screen keycaps light up with the keyboard and double as touch controls.
  const light = (k, on) => { for (const el of document.querySelectorAll(`[data-key="${CSS.escape(k)}"]`)) el.classList.toggle('down', on); };
  function release(k) {
    light(k, false);
    const r = route(k);
    if (!r) return;
    const i = net.guest ? 1 : r[0];
    if (net.guest && r[1] !== 'punch' && r[1] !== 'kick') net.send?.({ t: 'in', d: 0, a: r[1] });
    held[i].delete(r[1]);
    if (r[1] === 'up' && fighters) fighters[i].upReleased = true;   // a tap is a short hop
  }
  const keyName = e => e.key.toLowerCase();
  addEventListener('keydown', e => {
    const k = keyName(e);
    if (!route(k) && !['escape', ' ', 'enter'].includes(k)) return;
    e.preventDefault();
    light(k, true);
    if (!e.repeat) press(k);
  });
  addEventListener('keyup', e => release(keyName(e)));
  addEventListener('blur', () => {
    for (const h of held) h.clear();
    for (const el of document.querySelectorAll('.cap.down')) el.classList.remove('down');
    if (phase === 'playing' && !net.guest) press('escape');
  });
  for (const b of document.querySelectorAll('[data-key]')) {
    b.onpointerdown = e => { e.preventDefault(); light(b.dataset.key, true); press(b.dataset.key); };
    b.onpointerup = b.onpointercancel = b.onpointerleave = () => release(b.dataset.key);
  }
  $('go').onclick = () => start();
  $('one').onclick = () => start(mode);
  // The protein picks: each is a two-way switch; a change on the title screen swaps the
  // body at once, mid-match it takes effect at the next round.
  function showPicks() {
    for (const b of document.querySelectorAll('[data-pick]')) {
      const [i, form] = b.dataset.pick.split(':');
      b.classList.toggle('on', pick[+i] === form);
    }
  }
  for (const b of document.querySelectorAll('[data-pick]')) {
    b.onclick = () => {
      const [i, form] = b.dataset.pick.split(':');
      if (net.guest && +i !== 1) return;
      pick[+i] = form; showPicks();
      if (net.guest) { net.send?.({ t: 'pick', form }); return; }
      if (phase === 'ready') resetRound();
    };
  }
  for (const b of document.querySelectorAll('[data-level]')) {
    b.onclick = () => { level = b.dataset.level; showLevel(); try { localStorage.setItem(LEVEL_KEY, level); } catch {} };
  }
  showLevel();
  for (const b of document.querySelectorAll('[data-players]')) {
    b.onclick = () => {
      mode = +b.dataset.players;
      document.querySelector('.levels').hidden = mode !== 1;
      for (const o of document.querySelectorAll('[data-players]')) o.classList.toggle('on', o === b);
    };
  }
  $('sound').onclick = () => {
    sound = !sound; $('sound').textContent = sound ? 'SOUND ON' : 'SOUND OFF'; sfx.block();
    if (!sound) stopMusic();
    else if (phase !== 'ready') { startMusic(); if (phase !== 'playing') duckMusic(0.12); }
  };
  for (const b of document.querySelectorAll('[data-colour-choice]')) {
    b.onclick = () => {
      if (b.dataset.colourChoice === colour) return;
      colour = b.dataset.colourChoice;
      try { localStorage.setItem(COLOUR_KEY, colour); } catch {}
      applyColour();
    };
  }
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.onclick = () => {
      if (b.dataset.themeChoice === theme) return;
      theme = b.dataset.themeChoice;
      try { localStorage.setItem(THEME_KEY, theme); } catch {}
      applyTheme();
      // py2Dmol paints each style on its own ground, so rebuild the viewer in the new style.
      startViewer(fighters[0].coords, fighters[1].coords);
    };
  }

  // The window resized: py2Dmol resizes its canvas, but the cartoon it holds on the GPU
  // for in-place updates keeps the old projection, so once the resizing settles the
  // scene is rebuilt at the new size, as it is for a change of theme.
  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (fighters) startViewer(fighters[0].coords, fighters[1].coords); }, 150);
  });

  // ----------------------------------------------------------------------- loop
  let last = performance.now(), acc = 0;
  const DT = 1 / 60;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let moved = false;
    if (hitstop > 0) hitstop -= dt;
    else if (phase !== 'paused') {
      // Fixed 60 Hz steps whatever the display rate, and a redraw only when something
      // stepped: py2Dmol rebuilds the whole cartoon on every draw, so a 120 Hz screen
      // would otherwise pay for it twice per step.
      acc += dt;
      while (acc >= DT && phase !== 'paused') {
        clock += DT;
        frameCamera(DT);
        if (phase === 'playing') step(DT);
        else if (phase === 'ko' || phase === 'over') stepKO(DT);   // after the round, the heap keeps settling
        else for (const f of fighters) f.coords = body(f, clock);   // idle breathing behind the menus
        acc -= DT; moved = true;
      }
    }
    if (moved) {
      draw();
      fighters.forEach((f, i) => { updatePAE(f); drawPAE(f, i); });   // live PAE maps
      if (net.link && ++net.seq % 4 === 0) sendState();   // 15 packets a second
    }
    hud(); if (net.link || net.guest) netStatus(now);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- remote play
  // A line under the switches while remote: packets and bytes a second, and the link's
  // state, so a stall or a slow line shows for what it is.
  function netStatus(now) {
    if (now - net.tick < 1000) return;
    const secs = (now - net.tick) / 1000; net.tick = now;
    const n = net.guest ? net.pkts : (net.tx || 0) - (net.txLast || 0); net.txLast = net.tx || 0;
    const st = window.Net.status();
    const line = `${net.guest ? 'guest' : 'host'} · ${(n / secs).toFixed(0)} pkt/s · ${(net.bytes / secs / 1024).toFixed(0)} KB/s · ${st ? (st.open ? 'link ' + st.ice : 'no link') : 'no link'}${st && st.queued > 8192 ? ' · queued ' + (st.queued / 1024 | 0) + ' KB' : ''}`;
    net.pkts = 0; net.bytes = 0;
    setText('netstat', line);
  }
  // What the guest runs the fight from. It has the same game and the same rigs, so it
  // simulates every tick itself, its own keys acting at once; the host's packet, fifteen
  // times a second, sets it straight: each fighter's state and the springs of its
  // motion, the numbers on the HUD, what the overlay says, and what happened since the
  // last packet (hits, callouts, the finisher, sounds). The unfolding travels only when
  // it changed. About 2 KB a packet.
  const SNAP = ['x', 'y', 'vx', 'vy', 'facing', 'hp', 'crouch', 'sinceHit', 'squat', 'jumpDir', 'upReleased', 'landing', 'landPower',
    'fatigue', 'jit', 'settle', 'action', 't', 'hit', 'stun', 'cooldown', 'limp', 'seed', 'lastLow', 'blockStun', 'blockHold'];
  // What a guest keeps its own for the fighter it drives: its keys have already moved
  // it, and the host's word on where it was a moment ago would only drag it back.
  const OWN = new Set(['y', 'vy', 'crouch', 'squat', 'jumpDir', 'upReleased', 'landing', 'landPower', 'action', 't']);
  const snap = f => {
    const o = {};
    for (const k of SNAP) o[k] = f[k];
    o.q = f.queued; o.m = f.motion; o.d = f.dents.map(d => ({ at: d.at, dir: d.dir, amp: d.amp, t: d.t }));
    o.lh = f.lastHit; o.kb = f.koBrk ?? null;
    return o;
  };
  function unsnap(f, o, own) {
    for (const k of SNAP) {
      if (own && OWN.has(k)) continue;
      if (own && k === 'x') { const d = o.x - f.x; f.x += Math.abs(d) > 25 ? d : d * 0.3; continue; }   // eased, unless far out
      f[k] = o[k];
    }
    f.lastHit = o.lh;
    if (own) return;
    f.queued = o.q; f.motion = o.m;
    f.dents = o.d.map(d => ({ ...d, w: dentWeights(f, d.at) }));
  }
  function sendState() {
    const [a, b] = fighters, n = a.form.n + b.form.n;
    // The unfolding changes only on a hit or as it refolds, so it goes only when it did
    // (and now and then anyway, so a guest that missed one catches up).
    const unfold = new Uint8Array(n);
    let u = 0;
    for (const f of fighters) for (let i = 0; i < f.form.n; i++) unfold[u++] = Math.round(f.unfold[i] * 255);
    const changed = !net.lastUnfold || net.tx % 30 === 0 || unfold.some((v, i) => v !== net.lastUnfold[i]);
    if (changed) net.lastUnfold = unfold;
    const h = {
      ph: phase, t: time, r: round, w: wins, k: koTimer, hs: hitstop, held: [[...held[0]], [...held[1]]],
      f: [snap(a), snap(b)], n: [a.form.n, b.form.n],
      ov: { on: !$('overlay').hidden, ti: $('title').hidden ? '' : $('title').textContent, ms: $('msg').hidden ? '' : $('msg').textContent, end: $('overlay').classList.contains('ended') },
      ev: net.events,
    };
    net.events = [];
    net.tx = (net.tx || 0) + 1; net.bytes += JSON.stringify(h).length + (changed ? n : 0);
    net.link.send({ h, u: changed ? unfold : null });
  }
  function applyState(m) {
    const { h, u } = m || {};
    net.rx = (net.rx || 0) + 1;
    if (!h || !h.f) return;
    net.pkts++; net.bytes += JSON.stringify(h).length + (u ? u.byteLength || u.length || 0 : 0);
    // What happened first: a new round makes new fighters, a hit is replayed on them.
    for (const e of h.ev || []) {
      if (e[0] === 'reset') { if (e[1]) { pick[0] = e[1][0]; pick[1] = e[1][1]; showPicks(); } resetRound(); }
      else if (e[0] === 'hit' && fighters[e[1]].motion) landHit(e[1], e[2], e[3], e[4]);
      else if (e[0] === 'block' && fighters[e[1]].motion) blockHit(e[1], e[2], e[3], e[4]);
      else if (e[0] === 'flash') flash([e[1], 0, 0], e[2]);
      else if (e[0] === 'finish') finisher(e[1], true);
      else if (e[0] === 'sfx' && sfx[e[1]]) sfx[e[1]](...e.slice(2));
    }
    if (fighters[0].form.n !== h.n[0] || fighters[1].form.n !== h.n[1]) return;
    const was = phase;
    phase = h.ph; time = h.t; round = h.r; wins = h.w; koTimer = h.k; hitstop = h.hs;
    held[0] = new Set(h.held[0]);   // the host's keys drive P1 here too, between packets
    fighters.forEach((f, j) => unsnap(f, h.f[j], j === 1));
    if (u) { const bytes = u instanceof Uint8Array ? u : new Uint8Array(u); let k = 0; for (const f of fighters) for (let i = 0; i < f.form.n; i++) f.unfold[i] = bytes[k++] / 255; }
    if (phase === 'ko' && was !== 'ko') for (const f of fighters) if (f.hp === 0 && !f.koWave) denature(f);
    if (phase !== 'ko' && phase !== 'over') for (const f of fighters) { f.koWave = f.koLoose = null; }
    $('title').textContent = h.ov.ti; $('title').hidden = !h.ov.ti;
    $('msg').textContent = h.ov.ms; $('msg').hidden = !h.ov.ms;
    $('overlay').hidden = !h.ov.on; $('overlay').classList.toggle('ended', h.ov.end);
  }
  // A guest's keys act here at once and go to the host: strikes as presses, directions
  // as held or released. The guest is always P2.
  function guestPress(k) {
    startMusic();
    if (k === 'escape') return net.send?.({ t: 'in', a: 'escape' });
    const r = route(k);
    if (!r) return;
    const act = r[1];
    net.send?.({ t: 'in', d: 1, a: act });
    if (phase !== 'playing') return;
    if (act === 'punch' || act === 'kick') return strike(1, act);
    if (act === 'up') jumpCancel(1);
    held[1].add(act);
  }
  function hostInput(m) {
    if (m && m.t === 'pick' && FORMS[m.form]) { pick[1] = m.form; showPicks(); if (phase === 'ready') resetRound(); return; }
    if (!m || m.t !== 'in') return;
    if (m.a === 'escape') return press('escape');
    if (phase !== 'playing') return;
    if (m.a === 'punch' || m.a === 'kick') return strike(1, m.a);
    if (m.d) { if (m.a === 'up') jumpCancel(1); held[1].add(m.a); }
    else { held[1].delete(m.a); if (m.a === 'up') fighters[1].upReleased = true; }
  }
  function hostRemote() {
    mode = 3;
    overlay('REMOTE', 'Getting a code…', null);
    $('modes').hidden = true; $('qr').hidden = false; $('qr').innerHTML = '';
    net.link = window.Net.host({
      onLink: link => { $('msg').textContent = 'scan, or send the link'; $('joinlink').value = link; $('joinbox').hidden = false; if (!window.Net.showQR($('qr'), link)) $('qr').hidden = true; $('title').textContent = 'SCAN TO JOIN'; },
      onGuest: () => { $('qr').hidden = true; $('modes').hidden = false; start(3); },
      onInput: hostInput,
      onClose: () => { held[1].clear(); if (phase === 'playing') { phase = 'paused'; duckMusic(0.08); } overlay('CHALLENGER LEFT', '', 'MENU'); $('go').onclick = () => { $('go').onclick = () => start(); window.Net.stop(); net.link = null; phase = 'ready'; mode = 1; overlay('', '', null); }; },
      onError: msg => { window.Net.stop(); net.link = null; mode = 3; overlay('NO CONNECTION', msg + ' Press START to try again.', null); },
    });
    if (!net.link) { $('modes').hidden = false; $('qr').hidden = true; }
  }
  // The join link: clicking it selects it, and COPY (or the click) puts it on the clipboard.
  async function copyLink() {
    const input = $('joinlink'), btn = $('copylink');
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch { try { ok = document.execCommand('copy'); } catch {} }
    btn.textContent = ok ? 'COPIED' : 'SELECT ALL';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
  }
  $('joinlink').onclick = copyLink;
  $('copylink').onclick = copyLink;

  function joinRemote(id) {
    $('modes').hidden = true; $('go').hidden = true;
    overlay('CONNECTING', 'to the host…', null); $('modes').hidden = true;
    document.querySelector('.pad.left .who').textContent = 'YOU';
    document.querySelector('.picks').hidden = false; document.querySelector('.pick[data-player="0"]').hidden = true;   // a guest picks only its own
    mode = 3;   // P2 by the guest's own keys, P1 by the host's, as relayed
    const link = window.Net.join(id, {
      onOpen: () => { $('title').textContent = 'CONNECTED'; $('msg').textContent = 'waiting for the host'; },
      onState: applyState,
      onClose: () => { overlay('DISCONNECTED', '', 'RELOAD'); $('go').hidden = false; $('go').onclick = () => location.reload(); },
      onError: msg => { overlay('NO CONNECTION', msg, 'RETRY'); $('go').hidden = false; $('go').onclick = () => location.reload(); },
    });
    net.send = link ? link.send : null;
  }

  try {
    applyTheme();
    resetRound();
    startViewer(fighters[0].coords, fighters[1].coords);
    window.proteinFighter = { get fighters() { return fighters; }, get mode() { return mode; }, get viewer() { return viewer; }, camera: CAMERA, forms: FORMS, barrelGap, updatePAE, net };   // for poking at from the console
    $('one').disabled = false;
    if (net.guest) joinRemote(window.Net.joinId());
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    overlay('RENDERER UNAVAILABLE', String(e && e.message || e), 'RELOAD');
    $('go').onclick = () => location.reload();
  }
})();

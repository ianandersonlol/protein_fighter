// Protein Fighter: two 362-residue proteins, one py2Dmol scene, live coordinates.
// World units are Ångström. x runs across the arena, y is up, the floor is y = 0.
(function () {
  const { DomainRig, rotX: X, rotY: Y, matMul3: mul, mat3Eye: eye, CA_STEP } = window.Rig;
  const rig = new DomainRig(window.HUMANOID_V8_RIG);
  const N = rig.n;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- combat rules
  const ARENA = 150;          // fighters stay within ±ARENA
  const MIN_GAP = 42;         // grounded bodies never overlap closer than this
  const WALK = 130, RUN = 2.2, JUMP_V = 580, JUMP_VX = 240, GRAVITY = 1800, FRICTION = 9;
  // Jumps: a knee bend to push off, falling faster than rising, a little air drag,
  // letting go of up early cuts it to a short hop, and the knees soak up the landing.
  // The torso rides the arc and the legs tuck up under it, so ~93 Å clears a fighter.
  const SQUAT = 0.07, FALL_BOOST = 1.35, AIR_DRAG = 0.4, SHORT_HOP = 0.65, LANDING = 0.2;
  // Street Fighter style: punch or kick, standing, crouching (low) or in the air.
  // push: knockback speed in Å/s, slid out by ground friction.
  // low: only a crouching block stops it, and it unfolds only the legs.
  // overhead: only a standing block stops it. air: can only be thrown while airborne.
  const MOVES = {
    punch:    { duration: 0.24, active: 0.07, window: 0.07, damage: 7,  stun: 0.16, push: 120, fist: 'rarm',      text: 'HIT' },
    kick:     { duration: 0.40, active: 0.13, window: 0.09, damage: 13, stun: 0.24, push: 460, fist: 'rleg_foot', text: 'CRUNCH' },
    lowpunch: { duration: 0.22, active: 0.06, window: 0.07, damage: 5,  stun: 0.14, push: 90,  fist: 'rarm',      text: 'JAB' },
    lowkick:  { duration: 0.42, active: 0.14, window: 0.10, damage: 9,  stun: 0.22, push: 180, fist: 'rleg_foot', text: 'LOW KICK', low: true },
    airpunch: { duration: 0.30, active: 0.06, window: 0.14, damage: 8,  stun: 0.20, push: 140, fist: 'rarm',      text: 'HIT', air: true, overhead: true },
    airkick:  { duration: 0.40, active: 0.08, window: 0.22, damage: 12, stun: 0.26, push: 260, fist: 'rleg_foot', text: 'DROP KICK', air: true, overhead: true },
  };
  const REACH = 13;           // Å from striking residues to any defender residue
  const REFOLD = 0.02, REFOLD_DELAY = 2;   // unfolding recovered per residue per second, after this long unhit

  function newFighter(x, facing) {
    return {
      x, y: 0, vx: 0, vy: 0, facing, hp: 100, crouch: false, run: false, stride: 0, queued: null, sinceHit: 99,
      squat: 0, jumpDir: 0, upReleased: false, landing: 0, landPower: 0,
      action: 'idle', t: 0, hit: false, guard: false, stun: 0, cooldown: 0,
      unfold: new Float32Array(N),   // 0 folded … 1 denatured, per residue
      limp: 0.35,                    // how much of that damage the body gives in to
      seed: Math.random() * 100,
      coords: null,
    };
  }

  function attack(f, move) {
    const m = MOVES[move];
    if (!m || f.stun > 0 || MOVES[f.action] || f.cooldown > 0) return false;
    if (!!m.air !== f.y > 0) return false;
    Object.assign(f, { action: move, t: 0, hit: false, guard: false, cooldown: m.duration });
    return true;
  }

  // ------------------------------------------------------------------- animation
  const clamp01 = n => Math.max(0, Math.min(1, n));
  const ease = n => { n = clamp01(n); return n * n * (3 - 2 * n); };
  const arm = (side, lift) => mul(Y(side * Math.PI / 2), X(lift));

  // 0 → 1 → 0 extension curve: snap out by the active frame, hold, recover.
  function extension(move, t) {
    const m = MOVES[move], contact = m.active / m.duration, u = t / m.duration;
    return u < contact ? ease(u / contact) : 1 - ease((u - contact - 0.15) / (1 - contact - 0.15));
  }

  // Walking, learned from ../dance's retargeted CMU walk (humanoid_v8_walk.pdb). Over one
  // stride each thigh and shin pitches through a smooth curve: the thigh from -27° to +41°,
  // the shin from -54° to +25°, so the knee bends most while the leg swings through. Three
  // harmonics per curve rebuild it to within 4 Å at the feet. The foot stays locked to the
  // shin, as in the source, and the right leg runs half a stride behind the left.
  const GAIT = {
    stride: 100.8,   // Å per full cycle (two steps)
    thigh: [0.256, 0.207, 0.469, 0.088, 0.008, 0.002, -0.063],
    shin: [-0.247, -0.149, 0.409, -0.105, 0.252, -0.025, 0.081],
  };
  function gaitAngle(c, u) {
    let a = c[0];
    for (let h = 1; h <= 3; h++) a += c[2 * h - 1] * Math.cos(2 * Math.PI * h * u) + c[2 * h] * Math.sin(2 * Math.PI * h * u);
    return a;
  }

  // Rotation convention: root_R = X(+θ) leans the torso back, X(-θ) forward.

  // A deep crouch, solved (two-bone IK) so both ankles sit level, 20 Å ahead of and
  // 16 Å behind the hips, feet flat. Hips 25 Å off the floor, head at 66 Å against
  // 108 standing; the torso stays nearly upright so the thighs clear the chest.
  const CROUCH = { l: [1.723, -0.322], r: [0.491, -1.639], lean: 0.05 };
  function crouchLegs(tr) {
    tr.lleg_upper = X(CROUCH.l[0]); tr.lleg_lower = X(CROUCH.l[1]); tr.lleg_foot = eye();
    tr.rleg_upper = X(CROUCH.r[0]); tr.rleg_lower = X(CROUCH.r[1]); tr.rleg_foot = eye();
    tr.root_R = X(CROUCH.lean);
  }
  // In the air the legs follow the arc: a partial tuck at take-off, tightest at the
  // top, reaching back down for the floor as it falls. The body leans back while
  // rising and forward, into a forward jump, on the way down.
  function airLegs(tr, f) {
    const up = Math.max(-1, Math.min(1, f.vy / JUMP_V));
    const k = clamp01(1 - Math.abs(up) * (up < 0 ? 1.1 : 0.6));
    tr.lleg_upper = X(0.43 + k * 0.52); tr.lleg_lower = X(-0.16 - k * 0.69);
    tr.rleg_upper = X(-0.40 + k * 0.85); tr.rleg_lower = X(-0.12 - k * 1.08);
    const fwd = Math.max(-1, Math.min(1, f.vx * f.facing / (JUMP_VX * 1.6)));
    tr.root_R = X(-0.35 * fwd * (0.3 - 0.7 * up));
  }
  // Part of the way from the standing stance to the crouch: pushing off, landing.
  function bendLegs(tr, a) {
    const L = (s, c) => s + (c - s) * a;
    tr.lleg_upper = X(L(0.43, CROUCH.l[0])); tr.lleg_lower = X(L(-0.16, CROUCH.l[1])); tr.lleg_foot = eye();
    tr.rleg_upper = X(L(-0.40, CROUCH.r[0])); tr.rleg_lower = X(L(-0.12, CROUCH.r[1])); tr.rleg_foot = eye();
  }
  function guardArms(tr) {
    tr.larm_upper = arm(-1, -0.3); tr.rarm_upper = arm(1, -0.4);
    tr.larm_lower = arm(-1, 1.5); tr.rarm_lower = arm(1, 1.45);
  }

  function transforms(f, clock) {
    const breath = Math.sin(clock * 3 + f.seed) * 0.03;
    const tr = {
      larm_upper: arm(-1, -0.65 + breath), larm_lower: arm(-1, 1.15),
      rarm_upper: arm(1, -1 + breath), rarm_lower: arm(1, 0.95),
      lleg_upper: X(0.43 + breath), lleg_lower: X(-0.16), lleg_foot: eye(),
      rleg_upper: X(-0.40), rleg_lower: X(-0.12 - breath), rleg_foot: eye(),
    };
    const pose = f.hp <= 0 ? 'ko' : f.stun > 0 ? 'hurt' : MOVES[f.action] ? f.action
      : f.y > 0 ? 'jump' : f.guard ? 'block' : f.action;
    const s = MOVES[pose] ? extension(pose, f.t) : 0;

    // Phase comes from distance walked, so the feet don't skate and backing up runs the
    // gait in reverse. Backing up is also blocking: guard arms, walking legs.
    if (f.action === 'walk' && (pose === 'walk' || pose === 'block')) {
      const u = f.stride / GAIT.stride;
      for (const [side, phase] of [['l', u], ['r', u + 0.5]]) {
        const shin = X(gaitAngle(GAIT.shin, phase));
        tr[side + 'leg_upper'] = X(gaitAngle(GAIT.thigh, phase));
        tr[side + 'leg_lower'] = shin;
        tr[side + 'leg_foot'] = shin;
      }
    }

    if (pose === 'punch' || pose === 'lowpunch' || pose === 'airpunch') {
      tr.rarm_upper = arm(1, -(1 - s)); tr.rarm_lower = arm(1, 0.95 * (1 - s));
      if (pose === 'punch') { tr.root_R = X(s * 0.2); tr.root_T = [0, 0, s * 5]; }
      if (pose === 'lowpunch') crouchLegs(tr);
      if (pose === 'airpunch') airLegs(tr, f);
    } else if (pose === 'kick') {
      // Lean back into the kick so the raised leg has room: at full extension the
      // shin stays 48 Å from the chest and the foot lands at mid-body height.
      const chamber = ease(f.t / 0.06) * (1 - s);
      tr.rleg_upper = X(-0.4 + chamber * 1.65 + s * 1.9);
      tr.rleg_lower = X(-0.12 - chamber * 1.1 + s * 1.72);
      tr.rleg_foot = X(s * 0.9); tr.root_R = X(s * 0.5);
      tr.larm_upper = arm(-1, -0.65 - s * 0.55); tr.larm_lower = arm(-1, 1.15 - s * 0.75);
      tr.rarm_upper = arm(1, -1 - s * 0.9); tr.rarm_lower = arm(1, 0.95 - s * 1.7);
    } else if (pose === 'lowkick') {
      // From the deep crouch, swing the right leg out along the floor: at full
      // extension the foot skims 11 Å above it, reaching 54 Å ahead.
      crouchLegs(tr);
      tr.rleg_upper = X(CROUCH.r[0] + s * (1.1 - CROUCH.r[0]));
      tr.rleg_lower = X(CROUCH.r[1] + s * (1.45 - CROUCH.r[1]));
      tr.rleg_foot = X(s * 1.4);
      tr.root_R = X(CROUCH.lean + s * 0.05);
      guardArms(tr);
    } else if (pose === 'airkick') {
      // From the tuck, stamp the right leg down and forward.
      airLegs(tr, f);
      tr.rleg_upper = X(0.45 + s * 0.3); tr.rleg_lower = X(-1.2 + s * 2.1); tr.rleg_foot = X(s * 0.9);
      tr.root_R = X(s * 0.35);   // lean back, clear of the stamping leg
      tr.larm_upper = arm(-1, -0.3); tr.rarm_upper = arm(1, -1.2);
    } else if (pose === 'block') {
      guardArms(tr);
    } else if (pose === 'hurt') {
      const r = Math.sin(clamp01(1 - f.stun / 0.3) * Math.PI);
      tr.root_R = X(-r * 0.8); tr.rarm_upper = arm(1, -1 - r * 0.7); tr.root_T = [0, 0, -r * 12];
    } else if (pose === 'jump') {
      airLegs(tr, f);
    } else if (pose === 'ko') {
      const k = ease(f.t / 1.2);
      tr.root_R = X(-k * 1.3); tr.lleg_upper = X(0.43 + k * 0.9); tr.rleg_upper = X(-0.4 + k * 1.2);
      tr.larm_upper = arm(-1, k * 0.8); tr.rarm_upper = arm(1, k * 0.8);
    }
    const standing = pose === 'idle' || pose === 'walk' || pose === 'block';
    if (f.crouch && standing) crouchLegs(tr);
    else if (standing && (f.squat > 0 || f.landing > 0)) {
      // Knees bend to push off, and again to soak up a landing, harder for a longer fall.
      bendLegs(tr, f.squat > 0 ? 0.55 * (1 - f.squat / SQUAT) : 0.75 * f.landPower * (f.landing / LANDING));
    }
    return { tr, pose };
  }

  // Deterministic per-residue direction, so jitter is stable frame to frame.
  const jitterDir = Array.from({ length: N }, (_, i) => {
    const h = k => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
    return [h(1), h(2), h(3)];
  });

  const torsoY = p => rig.domains.torso.reduce((s, i) => s + p[i][1], 0) / rig.domains.torso.length;
  // How high the torso rides above the floor standing, to carry a body through the air.
  const TORSO_H = (() => {
    const p = rig.pose({ lleg_upper: X(0.43), lleg_lower: X(-0.16), rleg_upper: X(-0.40), rleg_lower: X(-0.12) });
    return torsoY(p) - Math.min(...[...rig.domains.lleg_foot, ...rig.domains.rleg_foot].map(i => p[i][1])) + 2;
  })();

  // Where the rig wants each residue: posed, turned to face ±x, feet on the floor.
  // Damaged residues get a jitter that breaks the i→i+4 geometry, so py2Dmol's own
  // secondary-structure assignment stops calling them helix or strand.
  function targets(f, clock) {
    const { tr, pose } = transforms(f, clock);
    // Rig forward is +z, up is +y. A rotation, not a mirror, so chirality survives.
    const p = rig.pose(tr).map(([x, y, z]) => f.facing > 0 ? [z, y, -x] : [-z, y, x]);
    // On the ground the feet stand on the floor (the planted one, mid-kick). In the air
    // the torso rides the arc instead, so tucking lifts the legs rather than the body.
    let lift;
    if (f.y > 0) lift = f.y + TORSO_H - torsoY(p);
    else {
      const kicking = pose === 'kick' || pose === 'lowkick';
      const support = kicking ? rig.domains.lleg_foot : [...rig.domains.lleg_foot, ...rig.domains.rleg_foot];
      let lowest = Infinity;
      for (const i of support) lowest = Math.min(lowest, p[i][1]);
      lift = 2 - lowest;
    }
    for (let i = 0; i < N; i++) {
      const q = p[i], d = f.unfold[i];
      q[0] += f.x; q[1] += lift;
      if (d < 0.01) continue;
      const j = jitterDir[i], wob = 0.75 + 0.25 * Math.sin(clock * 4 + i);
      q[0] += j[0] * 3.4 * d * wob; q[1] += j[1] * 3.4 * d * wob; q[2] += j[2] * 3.4 * d * wob;
    }
    return p;
  }

  // The body. A folded residue sits on its target; an unfolded one is a bead on a
  // chain under gravity with a little thermal noise, so a denatured protein falls
  // apart onto the floor. Every CA–CA bond ends each tick at exactly CA_STEP.
  // Mid-fight a residue only goes partway limp (f.limp), so a battered protein
  // still stands; a knockout lets go completely.
  const TICK = 1 / 60;
  function body(f, clock) {
    const T = targets(f, clock), P = f.coords, u = f.unfold;
    if (!P) { f.prev = T.map(q => q.slice()); return T; }
    const fall = GRAVITY * TICK * TICK;
    for (let i = 0; i < N; i++) {
      const p = P[i], o = f.prev[i], t = T[i], d = u[i] * f.limp, k = 1 - d, heat = 1.4 * d;
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
      for (let i = 0; i < N; i++) {
        const p = P[i];
        if (p[1] >= 1) continue;
        const o = f.prev[i];
        p[1] = 1; o[1] = 1; o[0] += (p[0] - o[0]) * 0.4; o[2] += (p[2] - o[2]) * 0.4;
      }
    }
    // Exact bond lengths: walk out from the most intact residue, placing each
    // neighbour CA_STEP away along its current direction. The chain cannot break.
    let anchor = 0;
    for (let i = 1; i < N; i++) if (u[i] < u[anchor]) anchor = i;
    const place = (ref, q) => {
      const dx = q[0] - ref[0], dy = q[1] - ref[1], dz = q[2] - ref[2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) { q[0] = ref[0] + CA_STEP; return; }
      const s = CA_STEP / l;
      q[0] = ref[0] + dx * s; q[1] = ref[1] + dy * s; q[2] = ref[2] + dz * s;
    };
    for (let i = anchor + 1; i < N; i++) place(P[i - 1], P[i]);
    for (let i = anchor - 1; i >= 0; i--) place(P[i + 1], P[i]);
    return P;
  }

  function strikePoints(f, move) {
    const D = rig.domains, c = f.coords;
    return MOVES[move].fist === 'rarm' ? [c[D.rarm[D.rarm.length - 1]]] : D.rleg_foot.map(i => c[i]);
  }

  // Returns the impact point if any striking residue reaches the defender.
  function contact(a, b) {
    let best = null, bestD = REACH;
    for (const s of strikePoints(a, a.action)) for (const q of b.coords) {
      const d = Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ------------------------------------------------------------------ damage
  // Leg residues: each leg from where it leaves the torso to where it returns.
  const LEGS = new Uint8Array(N);
  for (const [a, b] of [[43, 88], [173, 218]]) for (let i = a; i <= b; i++) LEGS[i] = 1;

  // Health is how folded the protein still is: 100 intact, 0 fully denatured. It is
  // read off the unfolding, not kept alongside it, so the bar, the colours and the
  // knockout always agree.
  const meanUnfold = f => f.unfold.reduce((s, v) => s + v, 0) / N;
  const health = f => Math.max(0, Math.round(100 * (1 - meanUnfold(f))));
  // pLDDT 100 is intact; fully denatured lands just under 50, AlphaFold's line for
  // disordered, so it reaches the orange band (the palette calls exactly 50 yellow).
  const toPlddt = d => 100 - 50.2 * d;

  // A hit unfolds `amount` percent of the protein, concentrated near the impact.
  // Residues that are already fully unfolded pass their share on. A low hit unfolds
  // the legs, until there is no leg left to unfold.
  function wound(b, at, amount, legsOnly) {
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
    b.hp = health(b);
    b.sinceHit = 0;
  }

  // ------------------------------------------------------------------- the scene
  let viewer, template;

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

  function startViewer(a, b) {
    viewer = window.py2Dmol.show($('stage'), pdbText(a, b), {
      name: 'arena', style: 'richardson', orient: false, controls: false, play: false,
      select: false, box: false, biounit: false,
    });
    viewer.setColor('deepmind');   // AlphaFold DB pLDDT colours, here meaning damage
    template = viewer.objectsData.arena.frames[0];
  }

  // A fixed camera on the arena. Left unset, py2Dmol centres on the running mean
  // of every frame it has been given, so the view would drift with the fight.
  // Tilted a little so the camera looks down on the arena and the depth shows.
  const CAMERA = { pitch: 0.3, centerY: 70 };
  function pinCamera() {
    const c = Math.cos(CAMERA.pitch), s = Math.sin(CAMERA.pitch);
    for (const v of [viewer.viewerState, viewer.objectsData.arena?.viewerState]) {
      if (!v) continue;
      v.center = { x: 0, y: CAMERA.centerY, z: 0 };
      v.extent = 100;
      v.extentAspect = null;
      v.zoom = 1;
      v.rotation = [[1, 0, 0], [0, c, -s], [0, s, c]];
    }
  }

  function draw() {
    const [a, b] = fighters;
    viewer.replaceFrame({
      ...template,
      coords: a.coords.concat(b.coords),
      plddts: Array.from(a.unfold, toPlddt).concat(Array.from(b.unfold, toPlddt)),
    }, 'arena');
    pinCamera();
    viewer.setFrame(0);
  }

  // ------------------------------------------------------------------- the match
  const held = [new Set(), new Set()];   // directions each player is holding
  let mode = 1;                           // 1: you vs the CPU · 2: two players, one keyboard
  let fighters, wins = [0, 0], round = 1, time = 60, phase = 'ready', clock = 0, koTimer = 0, ai = 0, hitstop = 0;
  const names = () => ['P1', 'P2'];   // the CPU is P2 too

  function resetRound() {
    fighters = [newFighter(-80, 1), newFighter(80, -1)];
    time = 99; koTimer = 0; ai = 1.5; hitstop = 0;
    for (const h of held) h.clear();
    for (const f of fighters) f.coords = body(f, clock);
  }

  // button: the one way on (resume, next round), or none to offer a choice of mode.
  function overlay(title, msg, button) {
    $('title').textContent = title; $('msg').textContent = msg;
    $('go').hidden = !button;
    if (button) $('go').textContent = button;
    $('modes').hidden = !!button;
    $('overlay').hidden = false;
  }

  function start(newMode) {
    if (phase === 'paused' && !newMode) { phase = 'playing'; $('overlay').hidden = true; return; }
    if (newMode) { mode = newMode; wins = [0, 0]; round = 1; }
    if (phase !== 'ready' || newMode) resetRound();
    phase = 'playing'; $('overlay').hidden = true;
    announce(`ROUND ${Math.min(round, 3)} · FIGHT!`);
    sfx.round();
  }

  function endRound() {
    const [p, c] = fighters;
    const winner = p.hp === c.hp ? -1 : p.hp > c.hp ? 0 : 1;
    if (winner >= 0) wins[winner]++;
    phase = 'over';
    const match = wins.includes(2);
    overlay(winner < 0 ? 'DRAW' : 'DENATURED', match ? 'Run it back?' : 'Refold. Refocus.', match ? null : 'REFOLD');
    round++;
  }

  function walk(f, dir, dt) {
    if (f.stun > 0 || MOVES[f.action] || f.y > 0) return;
    const pace = f.run ? RUN : dir === -f.facing ? 0.6 : 1;   // backing off is slower
    const dx = dir * WALK * pace * dt;
    f.x += dx;
    f.stride += dx * f.facing;
    f.action = dir ? 'walk' : 'idle';
  }

  function jump(f, dir) {
    f.vy = JUMP_V; f.vx = dir * JUMP_VX * (f.run ? 1.6 : 1); f.y = 0.01; f.crouch = false;
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
        if (f.landPower > 0.8) shake(1.5);
        if (f.landPower > 0.3) sfx.land(f.landPower);
        if (MOVES[f.action]?.air) { f.action = 'idle'; f.t = 0; f.cooldown = 0; }
      }
    } else f.vx *= Math.exp(-FRICTION * dt);
    f.x = Math.max(-ARENA, Math.min(ARENA, f.x + f.vx * dt));
  }

  // A player's held directions become movement: walk (double-tap to run), hold away
  // from the opponent to block, down to crouch, up to jump the way you are heading.
  function control(f, h, dt) {
    const dir = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    const free = f.stun <= 0 && !MOVES[f.action] && f.y === 0 && !f.squat;
    if (!dir) f.run = false;
    f.crouch = free && h.has('down');
    f.guard = free && dir === -f.facing && !f.run;
    walk(f, f.crouch || f.squat ? 0 : dir, dt);
    if (h.has('up') && free) { f.squat = SQUAT; f.jumpDir = dir; f.upReleased = false; h.delete('up'); }
    if (f.queued) {   // an attack pressed with the jump comes out once airborne
      if (clock > f.queued.until) f.queued = null;
      else if (f.y > 0 && attack(f, f.queued.move)) f.queued = null;
    }
  }

  // The CPU thinks a couple of times a second, commits to an attack only some of the
  // time, sometimes jumps in, and sits out the round-start callout.
  function cpu(c, p, dt) {
    const gap = Math.abs(p.x - c.x), toward = Math.sign(p.x - c.x) || 1;
    ai -= dt;
    if (ai <= 0) {
      ai = 0.4 + Math.random() * 0.4;
      const free = c.stun <= 0 && !MOVES[c.action] && c.y === 0 && !c.squat;
      c.guard = free && MOVES[p.action] && gap < 90 && Math.random() < 0.25;
      if (free && !c.guard && gap > 90 && gap < 160 && Math.random() < 0.2) { c.squat = SQUAT; c.jumpDir = toward; c.upReleased = false; }
      else if (free && !c.guard && gap < 75 && Math.random() < 0.45) {
        const r = Math.random();
        attack(c, r < 0.4 ? 'punch' : r < 0.7 ? 'kick' : r < 0.85 ? 'lowkick' : 'lowpunch');
      }
    }
    if (c.y > 30 && gap < 70 && Math.random() < 0.1) attack(c, Math.random() < 0.6 ? 'airkick' : 'airpunch');
    walk(c, gap > 62 && !c.guard ? toward : 0, dt);
  }

  function step(dt) {
    const [p, c] = fighters;
    time = Math.max(0, time - dt);
    for (const f of fighters) {
      f.t += dt; f.stun = Math.max(0, f.stun - dt); f.cooldown = Math.max(0, f.cooldown - dt);
      physics(f, dt);
      if (f.squat > 0 && (f.squat -= dt) <= 0) { f.squat = 0; jump(f, f.jumpDir); }
      if (MOVES[f.action] && f.t >= MOVES[f.action].duration) { f.action = 'idle'; f.t = 0; }
      // Left alone for a moment, a protein slowly refolds; lightly damaged spots first.
      f.sinceHit += dt;
      if (f.hp > 0 && f.sinceHit > REFOLD_DELAY) {
        let changed = false;
        for (let i = 0; i < N; i++) if (f.unfold[i] > 0) { f.unfold[i] = Math.max(0, f.unfold[i] - REFOLD * dt); changed = true; }
        if (changed) f.hp = health(f);
      }
    }

    control(p, held[0], dt);
    if (mode === 2) control(c, held[1], dt);
    else cpu(c, p, dt);

    // Spacing only between grounded bodies, so a jump can clear the other fighter.
    // Facing only turns on the ground, so a cross-up hits from the far side.
    if (Math.abs(p.x - c.x) < MIN_GAP && Math.abs(p.y - c.y) < 60) {
      const mid = (p.x + c.x) / 2, s = p.x <= c.x ? 1 : -1;
      p.x = mid - s * MIN_GAP / 2; c.x = mid + s * MIN_GAP / 2;
    }
    for (const [f, o] of [[p, c], [c, p]]) {
      f.x = Math.max(-ARENA, Math.min(ARENA, f.x));
      if (f.y === 0 && !MOVES[f.action] && f.x !== o.x) f.facing = f.x < o.x ? 1 : -1;
    }

    // Bodies, then hits against the bodies as they are right now
    for (const f of fighters) f.coords = body(f, clock);
    fighters.forEach((a, i) => {
      const m = MOVES[a.action], b = fighters[1 - i];
      if (!m || a.hit || a.t < m.active || b.hp === 0) return;
      if (a.t > m.active + m.window) { a.hit = true; sfx.whiff(); return; }   // whiffed
      const at = contact(a, b);
      if (!at) return;
      a.hit = true;
      const blocked = b.guard && b.y === 0 && (m.low ? b.crouch : m.overhead ? !b.crouch : true);
      const dmg = blocked ? Math.ceil(m.damage * 0.15) : m.damage;
      b.vx = a.facing * m.push * (blocked ? 0.35 : 1);
      wound(b, at, dmg, m.low);
      shake(blocked ? 2 : 3 + dmg * 0.4);
      if (!blocked) {
        b.stun = m.stun; b.action = 'hurt'; b.t = 0; b.squat = 0;
        if (b.y > 0) b.vy = Math.max(b.vy, 260);   // hit in the air: popped up, then falls
      }
      if (b.hp === 0) { b.action = 'ko'; b.t = 0; }
      hitstop = blocked ? 0.03 : 0.05 + dmg * 0.003;
      flash(at, blocked ? 'BLOCK' : m.text);
      if (blocked) sfx.block(); else sfx.hit(dmg / 13);
    });

    if (fighters.some(f => f.hp === 0) || time === 0) {
      phase = 'ko'; koTimer = 0;
      announce(fighters.some(f => f.hp === 0) ? 'DENATURED!' : 'TIME');
      sfx.ko();
    }
  }

  // A knocked-out protein keeps coming apart for a moment before the result.
  function stepKO(dt) {
    koTimer += dt;
    for (const f of fighters) {
      f.t += dt;
      physics(f, dt);   // a finishing blow still carries the loser
      if (f.hp === 0) {
        f.limp = Math.min(1, f.limp + dt * 1.5);
        for (let i = 0; i < N; i++) f.unfold[i] = Math.min(1, f.unfold[i] + dt * 0.55);
      }
      f.coords = body(f, clock);
    }
    if (koTimer > 2.2) endRound();
  }

  // ------------------------------------------------------------------------ HUD
  function flash(at, text) {
    const el = $('impact');
    el.textContent = text;
    el.style.left = 50 + at[0] * 0.28 + '%';
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const announce = text => flash([0, 0, 0], text);
  function shake(px) {
    const el = document.querySelector('.arena');
    el.style.setProperty('--shake', px + 'px');
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  }

  // The health bar is the average pLDDT, in the same AlphaFold bands as the protein.
  const bandColor = plddt => plddt >= 90 ? '#0d57d3' : plddt >= 70 ? '#6acbf1' : plddt >= 50 ? '#fed936' : '#fd7d4d';

  function hud() {
    fighters.forEach((f, i) => {
      const plddt = toPlddt(meanUnfold(f));
      $('hp' + i).style.width = f.hp + '%';
      $('hp' + i).style.background = bandColor(plddt);
      $('fold' + i).textContent = `pLDDT ${Math.round(plddt)}`;
      $('wins' + i).textContent = [0, 1].map(n => (wins[i] > n ? '●' : '○')).join(' ');
    });
    $('name1').textContent = names()[1];
    $('p2pad').hidden = mode !== 2;
    $('timer').textContent = String(Math.ceil(time)).padStart(2, '0');
    $('round').textContent = 'ROUND ' + String(Math.min(round, 3)).padStart(2, '0');
  }

  // ---------------------------------------------------------------------- sound
  // Synthesised, nothing to download: noise bursts and falling tones through a short
  // reverb and a compressor, so hits land heavy. On by default; browsers start the
  // audio at the first click or key press.
  let audio, bus, sound = true;
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
  function tone(freq, to, dur, { type = 'sine', gain = 0.3, delay = 0 } = {}) {
    const a = out(); if (!a) return;
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, from, to, { gain = 0.3, filter = 'lowpass', delay = 0 } = {}) {
    const a = out(); if (!a) return;
    const t = a.currentTime + delay, len = Math.ceil(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = filter;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus); src.start(t); src.stop(t + dur + 0.02);
  }
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
    ko() {     // a long collapse, and a second impact as it hits the floor
      tone(260, 28, 1.4, { type: 'sawtooth', gain: 0.18 });
      tone(60, 25, 1.8, { gain: 0.5 });
      noise(1.2, 1500, 60, { gain: 0.35 });
      noise(0.5, 3000, 200, { gain: 0.3, delay: 0.45 });
      tone(90, 30, 0.8, { gain: 0.4, delay: 0.45 });
    },
  };

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
    if (mode === 1 && SOLO[k]) return [0, SOLO[k]];
    if (BINDINGS[1][k]) return [mode === 2 ? 1 : 0, BINDINGS[1][k]];
    return null;
  }

  // Buttons pressed together are read together: an attack pressed with or just after
  // up waits for take-off and comes out in the air, and one pressed a moment before up
  // is cancelled into the jump. So up + forward + kick is a jump kick in whatever
  // order the fingers land. J/K (or F/G) crouching are low attacks.
  const BUFFER = 0.3, CANCEL = 0.12;
  const lastTap = [{ act: '', t: -1 }, { act: '', t: -1 }];
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
    if (k === 'escape') {
      if (phase === 'playing') { phase = 'paused'; for (const h of held) h.clear(); overlay('PAUSED', 'Ready when you are.', 'RESUME'); }
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
    if (act === 'left' || act === 'right') {
      if (lastTap[i].act === act && clock - lastTap[i].t < 0.25) fighters[i].run = true;
      lastTap[i] = { act, t: clock };
    }
    held[i].add(act);
  }

  // The on-screen keycaps light up with the keyboard and double as touch controls.
  const light = (k, on) => { for (const el of document.querySelectorAll(`[data-key="${CSS.escape(k)}"]`)) el.classList.toggle('down', on); };
  function release(k) {
    light(k, false);
    const r = route(k);
    if (!r) return;
    held[r[0]].delete(r[1]);
    if (r[1] === 'up' && fighters) fighters[r[0]].upReleased = true;   // a tap is a short hop
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
    if (phase === 'playing') press('escape');
  });
  for (const b of document.querySelectorAll('[data-key]')) {
    b.onpointerdown = e => { e.preventDefault(); light(b.dataset.key, true); press(b.dataset.key); };
    b.onpointerup = b.onpointercancel = b.onpointerleave = () => release(b.dataset.key);
  }
  $('go').onclick = () => start();
  $('one').onclick = () => start(1);
  $('two').onclick = () => start(2);
  $('sound').onclick = () => { sound = !sound; $('sound').textContent = sound ? 'SOUND ON' : 'SOUND OFF'; sfx.block(); };

  // ----------------------------------------------------------------------- loop
  let last = performance.now(), acc = 0;
  const DT = 1 / 60;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (hitstop > 0) hitstop -= dt;
    else if (phase === 'playing' || phase === 'ko') {
      acc += dt;
      while (acc >= DT && (phase === 'playing' || phase === 'ko')) {
        clock += DT;
        phase === 'playing' ? step(DT) : stepKO(DT);
        acc -= DT;
      }
    } else if (phase !== 'paused') {
      clock += dt;                       // idle breathing behind the menus
      for (const f of fighters) f.coords = body(f, clock);
    }
    if (phase !== 'paused') draw();
    hud();
    requestAnimationFrame(frame);
  }

  try {
    resetRound();
    startViewer(fighters[0].coords, fighters[1].coords);
    window.proteinFighter = { get fighters() { return fighters; }, get mode() { return mode; }, camera: CAMERA };   // for poking at from the console
    $('one').disabled = $('two').disabled = false;
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    overlay('RENDERER UNAVAILABLE', String(e && e.message || e), 'RELOAD');
    $('go').onclick = () => location.reload();
  }
})();

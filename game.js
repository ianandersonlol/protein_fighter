// Protein Fighter: two 362-residue proteins, one py2Dmol scene, live coordinates.
// World units are Ångström. x runs across the arena, y is up, the floor is y = 0.
(function () {
  const { DomainRig, rotX: X, rotY: Y, matMul3: mul, mat3Eye: eye, CA_STEP } = window.Rig;
  const rig = new DomainRig(window.HUMANOID_V8_RIG);
  const N = rig.n;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- combat rules
  const ARENA = 150;          // fighters stay within ±ARENA
  const WALK = 130, RUN = 2.2, JUMP_V = 655, JUMP_VX = 240, GRAVITY = 2400, FRICTION = 9;
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
    kick:     { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
    lowpunch: { duration: 0.22, active: 0.06, window: 0.07, damage: 5,  stun: 0.14, push: 90,  fist: 'rarm',      text: 'JAB' },
    lowkick:  { duration: 0.42, active: 0.14, window: 0.10, damage: 7,  stun: 0.22, push: 130, fist: 'rleg_foot', text: 'LOW KICK', low: true },
    airpunch: { duration: 0.30, active: 0.06, window: 0.14, damage: 8,  stun: 0.20, push: 140, fist: 'rarm',      text: 'HIT', air: true, overhead: true },
    airkick:  { duration: 0.40, active: 0.08, window: 0.22, damage: 10, stun: 0.26, push: 180, fist: 'rleg_foot', text: 'DROP KICK', air: true, overhead: true },
  };
  const REACH = 13;           // Å from striking residues to any defender residue
  const REFOLD = 0.02, REFOLD_DELAY = 2;   // unfolding recovered per residue per second, after this long unhit
  const DAMAGE_SCALE = 0.55;               // every hit softened, so a round takes about twice as many

  function newFighter(x, facing) {
    return {
      x, y: 0, vx: 0, vy: 0, facing, hp: 100, crouch: false, run: false, stride: 0, queued: null, sinceHit: 99,
      squat: 0, jumpDir: 0, upReleased: false, landing: 0, landPower: 0,
      anim: null,                    // joint springs, so poses blend instead of snapping
      plant: null,                   // where the planted foot stands during a ground attack
      dents: [],                     // recent impacts, springing back
      lastHit: null,                 // where the latest blow landed; a knockout unfolds from there
      fatigue: 0,                    // winded from attacking: deeper breathing, fades over time
      swing: null,                   // arm and leg pendulums hanging off the pose
      koWave: null, koLoose: null, koBurst: false,
      shock: new Float32Array(N),    // knocked loose by a blow, per residue, fading
      soft: new Float32Array(N),     // the unfolding as shown, easing after the real one
      jit: 5, liftKey: null, liftErr: 0, lastLift: 0,
      settle: 0,                     // 1 → 0 while a new round's body gathers itself up
      squish: 0, squishV: 0,         // squashed against the wall, on a spring
      pressed: 0, squishSide: 1,     // this tick pinned to the wall, and which wall
      action: 'idle', t: 0, hit: false, guard: false, stun: 0, cooldown: 0,
      unfold: new Float32Array(N),   // 0 folded … 1 denatured, per residue
      limp: 0.8,                     // how loose a fully unfolded residue hangs off the pose
      seed: Math.random() * 100,
      coords: null,
    };
  }

  function attack(f, move) {
    const m = MOVES[move];
    if (!m || f.stun > 0 || MOVES[f.action] || f.cooldown > 0) return false;
    if (!!m.air !== f.y > 0) return false;
    Object.assign(f, { action: move, t: 0, hit: false, guard: false, cooldown: m.duration });
    if (fighters && f === fighters[0]) provoked = true;   // the CPU fights back from here on
    f.fatigue = Math.min(1, f.fatigue + 0.12);
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

  // A deep crouch, down on the back knee, solved (two-bone IK). Each foot turns with
  // its shin, as in the walk data: holding a foot flat against a shin swept back 1.9
  // rad bent the ankle's hinge residues out of shape. The back foot rests on its toes,
  // level with the front sole, and the back knee comes within 3 Å of the floor. Hips
  // 29 Å up, head 73 Å against 108 standing; the torso stays nearly upright.
  const CROUCH = { l: [1.723, -0.322], r: [0.404, -1.941], lean: 0.05 };
  function crouchLegs(tr) {
    tr.lleg_upper = X(CROUCH.l[0]); tr.lleg_lower = X(CROUCH.l[1]); tr.lleg_foot = X(CROUCH.l[1]);
    tr.rleg_upper = X(CROUCH.r[0]); tr.rleg_lower = X(CROUCH.r[1]); tr.rleg_foot = X(CROUCH.r[1]);
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
  // Knees bent with the feet kept on their stance spots (IK): the body sinks straight
  // down instead of the back leg reaching away. Hips ~17 Å lower than standing. Used
  // part-way for pushing off, landing and slumping. Each foot turns half as far as its
  // shin: all the way tips the toes under the sole and lifts the body back up.
  const SLOUCH = { l: [0.963, -0.599], r: [0.348, -1.063] };
  function bendLegs(tr, a) {
    const L = (s, c) => s + (c - s) * a;
    tr.lleg_upper = X(L(0.43, SLOUCH.l[0])); tr.lleg_lower = X(L(-0.16, SLOUCH.l[1])); tr.lleg_foot = X(L(0, 0.5 * SLOUCH.l[1]));
    tr.rleg_upper = X(L(-0.40, SLOUCH.r[0])); tr.rleg_lower = X(L(-0.12, SLOUCH.r[1])); tr.rleg_foot = X(L(0, 0.5 * SLOUCH.r[1]));
  }
  // Two-bone leg IK in the rig's side view: thigh and shin angles that put the ankle at
  // (dz forward, dy up) from the hip, with the knee bending forward.
  const LEG = Object.fromEntries(['lleg', 'rleg'].map(side => {
    const P = rig.pivots, h = P[side + '_hip'], k = P[side + '_knee'], a = P[side + '_ankle'];
    const len = (p, q) => Math.hypot(q[1] - p[1], q[2] - p[2]), dir = (p, q) => Math.atan2(q[2] - p[2], -(q[1] - p[1]));
    return [side, { thigh: len(h, k), shin: len(k, a), thighDir: dir(h, k), shinDir: dir(k, a) }];
  }));
  function legIK(side, dz, dy) {
    const g = LEG[side], d = Math.hypot(dz, dy);
    const reach = Math.atan2(dz, -dy);
    const bend = Math.acos(Math.max(-1, Math.min(1, (g.thigh * g.thigh + d * d - g.shin * g.shin) / (2 * g.thigh * d))));
    const t = reach + bend, kz = g.thigh * Math.sin(t), ky = -g.thigh * Math.cos(t);
    return [t - g.thighDir, Math.atan2(dz - kz, -(dy - ky)) - g.shinDir];
  }
  // ...and back: where the ankle sits from the hip, (dz forward, dy up), for given angles.
  function legFK(side, thigh, shin) {
    const g = LEG[side], T = thigh + g.thighDir, S = shin + g.shinDir;
    return [g.thigh * Math.sin(T) + g.shin * Math.sin(S), -g.thigh * Math.cos(T) - g.shin * Math.cos(S)];
  }
  // Sinking toward the kneel as damage builds (a: 0 standing … 1 kneeling). Both ankles
  // are placed by IK on the floor at every step: the hips come down, the front foot
  // steps a little forward and the back foot gathers in, so neither leg lifts or splays.
  // The feet turn from flat to following their shins, ending exactly on CROUCH.
  const KNEEL_PATH = { front: [[7.5, -59.9], [20, -24.2]], back: [[-17, -61], [-16, -16.2]] };
  // The standing leg angles, from the same IK as the kneel's starting point, so resting,
  // breathing and striking all share one stance and nothing pops between them.
  const STANCE = { l: legIK('lleg', ...KNEEL_PATH.front[0]), r: legIK('rleg', ...KNEEL_PATH.back[0]) };
  function kneelLegs(tr, a) {
    const e = a * a * (3 - 2 * a), L = (s, c) => s + (c - s) * e;
    const [f0, f1] = KNEEL_PATH.front, [b0, b1] = KNEEL_PATH.back;
    const [lt, ls] = legIK('lleg', L(f0[0], f1[0]), L(f0[1], f1[1]));
    const [rt, rs] = legIK('rleg', L(b0[0], b1[0]), L(b0[1], b1[1]));
    tr.lleg_upper = X(lt); tr.lleg_lower = X(ls); tr.lleg_foot = X(ls * e);
    tr.rleg_upper = X(rt); tr.rleg_lower = X(rs); tr.rleg_foot = X(rs * e);
  }
  function guardArms(tr) {
    tr.larm_upper = arm(-1, -0.3); tr.rarm_upper = arm(1, -0.4);
    tr.larm_lower = arm(-1, 1.5); tr.rarm_lower = arm(1, 1.45);
  }

  function transforms(f, clock) {
    // Breathing: quick and shallow when fresh; slow, deep heaving gasps when hurt or
    // winded. The arms rise with each breath, the chest lifts and the knees bob.
    const tired = Math.max(0.15, f.fatigue, meanUnfold(f));
    const breathe = Math.sin(clock * (2.5 + 1.5 * tired) + f.seed);
    const breath = breathe * (0.015 + 0.07 * tired);
    const bob = tired * 0.12 * (breathe + 1) / 2;
    const tr = {
      larm_upper: arm(-1, -0.65 + breath), larm_lower: arm(-1, 1.15),
      rarm_upper: arm(1, -1 + breath), rarm_lower: arm(1, 0.95),
      lleg_upper: X(STANCE.l[0]), lleg_lower: X(STANCE.l[1]), lleg_foot: eye(),
      rleg_upper: X(STANCE.r[0]), rleg_lower: X(STANCE.r[1]), rleg_foot: eye(),
    };
    const pose = f.hp <= 0 ? 'ko' : f.stun > 0 ? 'hurt' : MOVES[f.action] ? f.action
      : f.y > 0 ? 'jump' : f.guard ? 'block' : f.action;
    const s = MOVES[pose] ? extension(pose, f.t) : 0;
    // The more of it has unfolded, the heavier it carries itself: the torso slumps
    // forward, the guard sinks and the knees give. Held back from a full collapse: at
    // most half way to the kneel; nearly gone, the torso tips further forward.
    const sag = 0.55 * clamp01((meanUnfold(f) - 0.2) / 0.8), crawl = clamp01((meanUnfold(f) - 0.7) / 0.3);

    // Phase comes from distance walked, so the feet don't skate and backing up runs the
    // gait in reverse. Backing up is also blocking: guard arms, walking legs.
    if (f.action === 'walk' && (pose === 'walk' || pose === 'block')) {
      const u = f.stride / GAIT.stride;
      // A slumped protein walks slumped. Its hips sink as far as they would standing still:
      // each gait ankle is raised toward the hip and the leg re-solved, so the feet trace
      // the same stride and do not skate. The kneel path's own hip drop undersells the
      // resting slump (the toes tip and the body leans too), so it is scaled up to match
      // the barrel height measured resting (linear in sag, fitted at 60% and 85% unfolded).
      const drop = 1.7 * sag * (KNEEL_PATH.front[1][1] - KNEEL_PATH.front[0][1]);
      for (const [side, phase] of [['l', u], ['r', u + 0.5]]) {
        let thigh = gaitAngle(GAIT.thigh, phase), shin = gaitAngle(GAIT.shin, phase), foot = shin;
        if (drop > 0.01) {
          const [dz, dy] = legFK(side + 'leg', thigh, shin);
          const [t2, s2] = legIK(side + 'leg', dz, dy + drop);
          foot = shin + 0.5 * (s2 - shin);   // the foot turns half as far as the extra knee bend
          thigh = t2; shin = s2;
        }
        tr[side + 'leg_upper'] = X(thigh);
        tr[side + 'leg_lower'] = X(shin);
        tr[side + 'leg_foot'] = X(foot);
      }
    }

    if (pose === 'punch' || pose === 'lowpunch' || pose === 'airpunch') {
      tr.rarm_upper = arm(1, -(1 - s)); tr.rarm_lower = arm(1, 0.95 * (1 - s));
      if (pose === 'punch') { tr.root_R = X(s * 0.2); tr.root_T = [0, 0, s * 5]; }
      if (pose === 'lowpunch') crouchLegs(tr);
      if (pose === 'airpunch') airLegs(tr, f);
    } else if (pose === 'kick') {
      // Lean back into the kick so the raised leg has room: at full extension the
      // shin stays 48 Å from the chest and the foot lands at mid-body height. A battered
      // protein cannot lean that far back or swing its arms out for balance: those shrink
      // with how unfolded the leg and the protein are. The leg itself shrinks half as
      // much, because a slumped body's hips are already low - at the full shrink a
      // denatured kick never lifted its foot off the floor (1.6 Å at 90% unfolded).
      const r = kickRange(f), legR = 0.5 + 0.5 * r, chamber = ease(f.t / 0.06) * (1 - s);
      tr.rleg_upper = X(-0.4 + legR * (chamber * 1.65 + s * 1.9));
      tr.rleg_lower = X(-0.12 + legR * (-chamber * 1.1 + s * 1.72));
      tr.rleg_foot = X(legR * s * 0.9); tr.root_R = X(r * s * 0.5);
      tr.larm_upper = arm(-1, -0.65 - r * s * 0.55); tr.larm_lower = arm(-1, 1.15 - r * s * 0.75);
      tr.rarm_upper = arm(1, -1 - r * s * 0.9); tr.rarm_lower = arm(1, 0.95 - r * s * 1.7);
    } else if (pose === 'lowkick') {
      // From the deep crouch, swing the right leg out along the floor: at full
      // extension the foot skims 11 Å above it, reaching 54 Å ahead (less, battered).
      const r = kickRange(f);
      crouchLegs(tr);
      tr.rleg_upper = X(CROUCH.r[0] + r * s * (1.1 - CROUCH.r[0]));
      tr.rleg_lower = X(CROUCH.r[1] + r * s * (1.45 - CROUCH.r[1]));
      tr.rleg_foot = X(CROUCH.r[1] + r * s * (1.4 - CROUCH.r[1]));
      tr.root_R = X(CROUCH.lean + r * s * 0.05);
      guardArms(tr);
    } else if (pose === 'airkick') {
      // From the tuck, stamp the right leg down and forward (a shorter stamp, battered).
      const r = kickRange(f);
      airLegs(tr, f);
      tr.rleg_upper = X(0.45 + r * s * 0.3); tr.rleg_lower = X(-1.2 + r * s * 2.1); tr.rleg_foot = X(r * s * 0.9);
      tr.root_R = X(r * s * 0.35);   // lean back, clear of the stamping leg
      tr.larm_upper = arm(-1, -0.3); tr.rarm_upper = arm(1, -1.2);
    } else if (pose === 'block') {
      guardArms(tr);
    } else if (pose === 'rest') {
      // Round won: guard down, arms hanging loose with a little bend at the elbow.
      tr.larm_upper = arm(-1, -1.4 + breath); tr.rarm_upper = arm(1, -1.4 + breath);
      tr.larm_lower = arm(-1, -1.2); tr.rarm_lower = arm(1, -1.2);
    } else if (pose === 'hurt') {
      const r = Math.sin(clamp01(1 - f.stun / 0.3) * Math.PI);
      tr.root_R = X(-r * 0.8); tr.rarm_upper = arm(1, -1 - r * 0.7); tr.root_T = [0, 0, -r * 12];
    } else if (pose === 'jump') {
      airLegs(tr, f);
    } else if (pose === 'ko') {
      // Collapse under its own weight: the knees buckle into a kneel and the torso folds
      // forward over them, arms hanging, into a heap with the head ~40 Å off the floor.
      // The joint springs make it a slow crumple rather than a snap.
      crouchLegs(tr);
      tr.root_R = X(-1.2);
      tr.larm_upper = arm(-1, 1.4); tr.rarm_upper = arm(1, 1.4);   // arms drop, hanging straight
      tr.larm_lower = arm(-1, 1.4); tr.rarm_lower = arm(1, 1.4);
    }
    // The slump (sag, crawl: see above) leans the torso and lets the guard sink.
    // (A block keeps its guard up however battered, so defending always reads.)
    if (sag > 0 && (pose === 'idle' || pose === 'rest' || pose === 'walk' || pose === 'hurt')) {
      tr.root_R = mul(tr.root_R || eye(), X(-0.45 * sag - 0.6 * crawl));
      // The guard gives out and the arms hang, upper and lower together so they fall straight.
      const droop = 1.1 * sag + 0.8 * crawl;
      for (const j of ['larm_upper', 'larm_lower', 'rarm_upper', 'rarm_lower']) tr[j] = mul(tr[j], X(droop));
    }
    // Striking on the ground doesn't straighten a slumped protein up: it keeps its lean,
    // the leg it stands on stays as bent as it sinks resting, and a punch keeps both.
    if (sag > 0 && MOVES[pose] && !MOVES[pose].air && f.y === 0) {
      tr.root_R = mul(tr.root_R || eye(), X(-0.45 * sag - 0.6 * crawl));
      if (pose === 'punch' || pose === 'kick') {
        const bent = {};
        kneelLegs(bent, clamp01(sag));
        for (const j of pose === 'punch' ? ['lleg_upper', 'lleg_lower', 'lleg_foot', 'rleg_upper', 'rleg_lower', 'rleg_foot']
          : ['lleg_upper', 'lleg_lower', 'lleg_foot']) tr[j] = bent[j];
      }
    }
    if (pose === 'idle' || pose === 'rest' || pose === 'block') tr.root_R = mul(tr.root_R || eye(), X(breath * 0.8));   // the chest heaves
    const standing = pose === 'idle' || pose === 'rest' || pose === 'walk' || pose === 'block';
    if (f.crouch && standing) crouchLegs(tr);
    else if (standing && (f.squat > 0 || f.landing > 0)) {
      // Knees bend to push off, and again to soak up a landing, harder for a longer fall.
      bendLegs(tr, f.squat > 0 ? 0.55 * (1 - f.squat / SQUAT) : 0.75 * f.landPower * (f.landing / LANDING));
    } else if (standing && f.action !== 'walk') {
      // Resting: settled into the slump, bobbing with each breath. However battered, a
      // protein that moves walks: the gait above carries it, one planted foot at a time.
      kneelLegs(tr, clamp01(sag + bob));
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
    blendPose(f, tr, pose);
    swingLimbs(f, tr, pose);
    // Rig forward is +z, up is +y. A rotation, not a mirror, so chirality survives.
    const p = rig.pose(tr).map(([x, y, z]) => f.facing > 0 ? [z, y, -x] : [-z, y, x]);
    // On the ground the feet stand on the floor (the planted one, mid-kick). In the air
    // the torso rides the arc instead, so tucking lifts the legs rather than the body.
    const kicking = pose === 'kick' || pose === 'lowkick';
    let lift, shift = 0;
    if (f.y > 0) lift = f.y + TORSO_H - torsoY(p);
    else {
      const support = kicking ? rig.domains.lleg_foot : [...rig.domains.lleg_foot, ...rig.domains.rleg_foot];
      let lowest = Infinity;
      for (const i of support) lowest = Math.min(lowest, p[i][1]);
      lift = 2 - lowest;
    }
    // Switching what holds the body up (both feet, one foot mid-kick, the jump arc) would
    // pop it up or down; the difference eases out over a few frames instead.
    const liftKey = f.y > 0 ? 'air' : kicking ? 'kick' : 'ground';
    if (f.liftKey && liftKey !== f.liftKey) f.liftErr = f.lastLift - lift;
    else f.liftErr *= 0.8;
    f.liftKey = liftKey; lift += f.liftErr; f.lastLift = lift;
    // A strike or a heaving breath moves the hips (a lean, a lunge) and the legs hang from
    // the hips, so the feet would slide. Standing, the back foot, the one every strike keeps
    // down, holds its spot from one pose into the next. Walking, jumping or reeling lets go,
    // and the body keeps the place that left it in, so it never snaps back.
    if (f.plant && f.plant.facing !== f.facing) { f.x += f.plant.shift; f.plant = null; }
    const planted = f.y === 0 && f.action !== 'walk' && (MOVES[pose] || pose === 'idle' || pose === 'block' || pose === 'rest');
    if (planted) {
      const foot = rig.domains.lleg_foot;
      let footX = 0;
      for (const i of foot) footX += p[i][0] / foot.length;
      f.plant ??= { x: footX, facing: f.facing, shift: 0 };
      shift = f.plant.shift = f.plant.x - footX;
    } else if (f.plant) { f.x += f.plant.shift; f.plant = null; }
    // A hit breaks the helices over a few frames rather than in one.
    for (let i = 0; i < N; i++) f.soft[i] += (f.unfold[i] - f.soft[i]) * 0.2;
    f.jit += ((f.hp === 0 ? 11 : 5) - f.jit) * 0.05;
    // Pinned against the wall by the other fighter, the body squashes flat against it and
    // bulges out in depth - the looser the chain the more, and a battered protein far more
    // than a healthy one. Let go, it springs back past flat with a wobble. The squash is
    // anchored on the body's wall side, so it stays against the wall and gives way inward.
    if (f.pressed) f.squishSide = f.pressed;
    f.squishV += (144 * ((f.pressed ? 1 : 0) - f.squish) - 7.2 * f.squishV) * TICK;   // 12 rad/s, lightly damped
    f.squish += f.squishV * TICK;
    f.pressed = 0;
    const squash = f.squish * (0.12 + 0.4 * meanUnfold(f));
    let sx = 0, sz = 0;
    if (Math.abs(squash) > 0.002) {
      const T = rig.domains.torso;
      for (const i of T) { sx += p[i][0]; sz += p[i][2]; }
      sx = sx / T.length + f.squishSide * 12; sz /= T.length;   // ~ the barrel's wall-side surface
    }
    for (let i = 0; i < N; i++) {
      const q = p[i], d = f.soft[i];
      if (Math.abs(squash) > 0.002) {
        const w = squash * (0.3 + 0.7 * d);
        q[0] = sx + (q[0] - sx) * (1 - w);
        q[2] = sz + (q[2] - sz) * (1 + 0.6 * w);
      }
      q[0] += f.x + shift; q[1] += lift;
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
  // chain under gravity with a little thermal noise, so a denatured protein falls
  // apart onto the floor. Every CA–CA bond ends each tick at exactly CA_STEP.
  // Mid-fight a residue only goes partway limp (f.limp), so a battered protein
  // still stands; a knockout lets go completely.
  const TICK = 1 / 60;
  // The folded chain's own spacing two residues apart: enough stiffness that a collapsing
  // body crumples as a heavy chain rather than pouring out like a liquid, while leaving
  // helices and strands (set by spacing three and four apart) free to come undone.
  const LOCAL_SHAPE = [2].map(gap => [gap, Float32Array.from({ length: N - gap }, (_, i) => {
    const a = rig.bind[i], b = rig.bind[i + gap];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  })]);

  // Poses are targets, not snapshots. Every joint follows its target on a spring, so a
  // fighter moves into a crouch, a guard or a kick instead of jumping to it: bending
  // down starts slow and gathers speed, then settles with a little give. Strikes and
  // recoil use stiff springs so they still land on time, walking is stiff enough to
  // keep the feet planted, and a knockout goes slack slowly.
  const JOINTS = ['root_R', 'larm_upper', 'larm_lower', 'rarm_upper', 'rarm_lower',
    'lleg_upper', 'lleg_lower', 'lleg_foot', 'rleg_upper', 'rleg_lower', 'rleg_foot'];
  function blendPose(f, tr, pose) {
    // Every joint needs a target; fill in what the rig would otherwise default.
    tr.root_R ??= eye(); tr.root_T ??= [0, 0, 0];
    tr.lleg_foot ??= tr.lleg_lower; tr.rleg_foot ??= tr.rleg_lower;
    if (!f.anim) {
      f.anim = { R: {}, V: {}, T: tr.root_T.slice(), TV: [0, 0, 0] };
      for (const j of JOINTS) { f.anim.R[j] = tr[j].slice(); f.anim.V[j] = new Array(9).fill(0); }
      return;
    }
    const striking = !!MOVES[pose];
    const bracing = f.squat > 0 || f.landing > 0;   // push-off and landing last a fraction of a second
    const omega = striking ? 60 : bracing ? 55 : pose === 'hurt' ? 40 : pose === 'ko' ? 10
      : f.y > 0 ? 28 : f.action === 'walk' ? 45 : f.crouch ? 26 : 15;   // rad/s
    // Critically damped: the folded body never overshoots or sways. Swinging is left to
    // the unfolded chain, which hangs off the pose under gravity (see body()).
    const zeta = 1;
    // Implicit spring step: stable at any stiffness for a 60 Hz tick.
    const k = omega * omega, c = 2 * zeta * omega, dt = TICK, den = 1 + dt * c + dt * dt * k;
    const spring = (x, v, target) => {
      for (let i = 0; i < x.length; i++) { v[i] = (v[i] + dt * k * (target[i] - x[i])) / den; x[i] += dt * v[i]; }
    };
    const a = f.anim;
    for (const j of JOINTS) { spring(a.R[j], a.V[j], tr[j]); a.R[j] = orthonormal(a.R[j]); tr[j] = a.R[j]; }
    spring(a.T, a.TV, tr.root_T); tr.root_T = a.T.slice();
  }
  // Limbs on strings. Each arm, and the shins while airborne, is a lightly damped
  // pendulum hanging off the pose, driven by the body's own acceleration: arms trail as
  // it lunges or sets off, fling forward as it stops, swing against the legs when
  // walking, and the shins flap on take-off, landing and knockback. The looser the
  // protein, the slower and wider it swings. Strikes damp it so punches keep their shape.
  function swingLimbs(f, tr, pose) {
    const s = f.swing ??= { l: [0, 0], r: [0, 0], leg: [0, 0], x: f.x, v: 0, vy: f.vy };
    const dt = TICK, v = (f.x - s.x) / dt;
    const acc = (v - s.v) / dt * f.facing, accY = (f.vy - s.vy) / dt;
    s.x = f.x; s.v = v; s.vy = f.vy;
    const loose = 0.3 + 0.7 * meanUnfold(f);
    const w = 12 - 6 * loose, zeta = 0.25 - 0.1 * loose;   // rad/s, and light damping: several swings
    const trail = Math.max(-0.9, Math.min(0.9, acc * 0.0004));
    const gait = f.action === 'walk' ? Math.sin(2 * Math.PI * f.stride / GAIT.stride) * (0.3 + 0.3 * loose) : 0;
    const flap = Math.max(-0.8, Math.min(0.8, accY * 0.00002));
    const pendulum = (st, target) => { st[1] += (w * w * (target - st[0]) - 2 * zeta * w * st[1]) * dt; st[0] += st[1] * dt; };
    pendulum(s.l, trail + gait); pendulum(s.r, trail - gait); pendulum(s.leg, flap);
    s.k = (s.k ?? 1) + ((MOVES[pose] ? 0.25 : 1) - (s.k ?? 1)) * 0.15;   // eased, so a strike doesn't jerk the swing
    const k = s.k;
    tr.larm_upper = mul(tr.larm_upper, X(s.l[0] * k)); tr.larm_lower = mul(tr.larm_lower, X(s.l[0] * 1.6 * k));
    tr.rarm_upper = mul(tr.rarm_upper, X(s.r[0] * k)); tr.rarm_lower = mul(tr.rarm_lower, X(s.r[0] * 1.6 * k));
    if (f.y > 0) { tr.lleg_lower = mul(tr.lleg_lower, X(s.leg[0])); tr.rleg_lower = mul(tr.rleg_lower, X(s.leg[0] * 0.8)); }
  }

  // Blending rotation matrices entry by entry drifts off a rotation; pull it back.
  function orthonormal(m) {
    let [a0, a1, a2, b0, b1, b2] = m;
    let l = Math.hypot(a0, a1, a2) || 1; a0 /= l; a1 /= l; a2 /= l;
    const d = a0 * b0 + a1 * b1 + a2 * b2; b0 -= d * a0; b1 -= d * a1; b2 -= d * a2;
    l = Math.hypot(b0, b1, b2) || 1; b0 /= l; b1 /= l; b2 /= l;
    return [a0, a1, a2, b0, b1, b2, a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0];
  }

  function body(f, clock) {
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

  // The striking end of the limb, not only its tip. Point-blank, a kick's foot has gone
  // clean through the other barrel's hollow by the time it is out, 13 Å from every
  // residue, and only the shin is still against the body: counting the foot alone made
  // a kick at contact whiff. The forearm's last dozen residues, likewise, for a punch.
  function strikePoints(f, move) {
    const D = rig.domains, c = f.coords;
    const idx = MOVES[move].fist === 'rarm' ? D.rarm.slice(-12) : [...D.rleg_shin, ...D.rleg_foot];
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
  // Leg residues: each leg from where it leaves the torso to where it returns.
  const LEGS = new Uint8Array(N);
  for (const [a, b] of [[43, 88], [173, 218]]) for (let i = a; i <= b; i++) LEGS[i] = 1;
  const LEG_IDX = [...LEGS.keys()].filter(i => LEGS[i]);
  const ARM_IDX = [...rig.domains.larm, ...rig.domains.rarm];
  const partDamage = (f, idx) => idx.reduce((s, i) => s + f.unfold[i], 0) / idx.length;
  // Unfolded legs still carry a fighter, just slowly: down to a third of the pace.
  const mobility = f => Math.max(0.2, 1 - 0.65 * partDamage(f, LEG_IDX) - 0.25 * meanUnfold(f));
  // A strike comes from a limb: the more that limb, and the protein as a whole, has
  // unfolded, the slower it plays out (up to ~2.4x) and the less it hurts (down to a quarter).
  const limbOf = move => MOVES[move]?.fist === 'rarm' ? ARM_IDX : LEG_IDX;
  const strikeSlow = f => 1 + 0.9 * partDamage(f, limbOf(f.action)) + 0.5 * meanUnfold(f);
  const strikePower = (f, move) => Math.max(0.25, 1 - 0.6 * partDamage(f, limbOf(move)) - 0.3 * meanUnfold(f));
  // ...and how far a kick can swing at all: the leg lift and the lean back, as a fraction
  // of a healthy kick. Down to half with the legs and the protein gone: at a third the
  // limp leg never left the floor (the foot peaked 1.7 Å up at 90% unfolded).
  const kickRange = f => Math.max(0.5, 1 - 0.5 * partDamage(f, LEG_IDX) - 0.3 * meanUnfold(f));

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
  function wound(b, at, amount, legsOnly, dir = 0) {
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
  function dent(b, at, dir, power) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      w[i] = Math.exp(-(r * r) / (2 * DENT_RADIUS * DENT_RADIUS));
    }
    b.dents.push({ w, dir, amp: 4 + power * 0.45, t: 0 });
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
    viewer.setColor('deepmind');   // AlphaFold DB pLDDT colours, here meaning damage
    // No ground of its own: the page's floor sits behind the proteins, not over them.
    viewer.setClearColor(true);
    // py2Dmol's fast path: a frame whose secondary structure is unchanged updates the
    // cartoon mesh in place instead of rebuilding it (a quarter off each draw here).
    window.py2dmolCartoonGPU?.setStationDraw?.(true);
    template = viewer.objectsData.arena.frames[0];
  }


  // A fixed camera on the arena. Left unset, py2Dmol centres on the running mean
  // of every frame it has been given, so the view would drift with the fight.
  // Straight on, so neither side looks to have the high ground, and tilted well down
  // onto the arena so the proteins' depth shows.
  const CAMERA = { pitch: 0.7, yaw: 0, centerY: 70 };
  function pinCamera() {
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch), cy = Math.cos(CAMERA.yaw), sy = Math.sin(CAMERA.yaw);
    for (const v of [viewer.viewerState, viewer.objectsData.arena?.viewerState]) {
      if (!v) continue;
      v.center = { x: 0, y: CAMERA.centerY, z: 0 };
      v.extent = 100;
      v.extentAspect = null;
      v.zoom = 1;
      v.rotation = [[cy, 0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]];   // pitch · yaw
    }
  }

  function draw() {
    const [a, b] = fighters;
    // replaceFrame draws the frame, and (py2Dmol's animation rule) keeps the camera
    // and the mesh where they are, so the cartoon is updated in place, not rebuilt.
    pinCamera();
    viewer.replaceFrame({
      ...template,
      coords: a.coords.concat(b.coords),
      plddts: Array.from(a.unfold, toPlddt).concat(Array.from(b.unfold, toPlddt)),
    }, 'arena');
  }

  // ------------------------------------------------------------------- the match
  const held = [new Set(), new Set()];   // directions each player is holding
  let mode = 1;                           // 1: you vs the CPU · 2: two players, one keyboard
  let fighters, wins = [0, 0], round = 1, time = 60, phase = 'ready', clock = 0, koTimer = 0, ai = 0, hitstop = 0;
  let provoked = false;   // the CPU does not strike first: it waits each round until the player has
  const names = () => ['P1', 'P2'];   // the CPU is P2 too

  function resetRound() {
    const old = fighters;
    fighters = [newFighter(-80, 1), newFighter(80, -1)];
    time = 99; koTimer = 0; ai = 1.5; hitstop = 0; provoked = false;
    for (const h of held) h.clear();
    for (const f of fighters) f.coords = body(f, clock);
    // The PAE reference is each fighter as it stands at the bell: healthy, in its stance.
    for (const f of fighters) { f.paeLocal = localPositions(f.coords); f.pae = new Float32Array(PB * PB); }
    // Then each body starts from wherever the last round left it, heap and all, and pulls
    // itself back together, rather than popping into place.
    if (old) fighters.forEach((f, i) => {
      f.coords = old[i].coords.map(q => q.slice()); f.prev = old[i].coords.map(q => q.slice()); f.settle = 1;
    });
  }

  // button: the one way on (resume, next round), or none to offer a choice of mode.
  function overlay(title, msg, button) {
    $('title').textContent = title; $('msg').textContent = msg; $('msg').hidden = !msg;
    document.querySelector('#overlay .learn').hidden = true;   // how to read the colours: title screen only
    $('go').hidden = !button;
    if (button) $('go').textContent = button;
    $('modes').hidden = !!button;
    $('overlay').hidden = false;
  }

  function start(newMode) {
    startMusic();
    if (phase === 'paused' && !newMode) { phase = 'playing'; $('overlay').hidden = true; return; }
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
    overlay(winner < 0 ? 'DRAW' : 'DENATURED', '', match ? null : 'REFOLD');
    $('overlay').classList.add('ended');   // no veil: the heap keeps settling behind it
    duckMusic(0.12);
    round++;
  }

  function walk(f, dir, dt, speed = 1) {
    if (f.stun > 0 || MOVES[f.action] || f.y > 0) return;
    const pace = (f.run ? RUN : dir === -f.facing ? 0.6 : 1) * mobility(f) * speed;   // backing off is slower; bad legs slower still
    const dx = dir * WALK * pace * dt;
    f.x += dx;
    f.stride += dx * f.facing;
    f.action = dir ? 'walk' : 'idle';
  }

  function jump(f, dir) {
    const legs = mobility(f);   // unfolded legs jump lower and shorter
    f.vy = JUMP_V * (0.55 + 0.45 * legs); f.vx = dir * JUMP_VX * (f.run ? 1.6 : 1) * legs; f.y = 0.01; f.crouch = false;
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
    // Spacing is read off the barrels as drawn (the gap between them, last tick), put
    // back on the old centre-to-centre scale the thresholds below were tuned on.
    const gap = (c.barrelGap ?? Math.abs(p.x - c.x) - BARREL_SPAN) + BARREL_SPAN;
    const toward = Math.sign(barrelX(p) - barrelX(c)) || 1;
    ai -= dt;
    if (ai <= 0) {
      ai = 0.4 + Math.random() * 0.4;
      const free = c.stun <= 0 && !MOVES[c.action] && c.y === 0 && !c.squat;
      c.guard = free && MOVES[p.action] && gap < 90 && Math.random() < 0.25;
      // Until the player strikes, it squares up and blocks, but never jumps in or attacks.
      if (provoked && free && !c.guard && gap > 90 && gap < 160 && Math.random() < 0.2) { c.squat = SQUAT; c.jumpDir = toward; c.upReleased = false; }
      else if (provoked && free && !c.guard && gap < 75 && Math.random() < 0.45) {
        const r = Math.random();
        attack(c, r < 0.4 ? 'punch' : r < 0.7 ? 'kick' : r < 0.85 ? 'lowkick' : 'lowpunch');
      }
    }
    if (provoked && c.y > 30 && gap < 70 && Math.random() < 0.1) attack(c, Math.random() < 0.6 ? 'airkick' : 'airpunch');
    // It closes in at half a walk, and before the player has struck it stops further off,
    // squaring up at a distance instead of crowding in.
    walk(c, gap > (provoked ? 62 : 95) && !c.guard ? toward : 0, dt, 0.5);
  }

  // Bodies push each other only where they actually touch: the two β-barrels, the
  // torsos, as they are drawn this tick, leaning, lunging and all. Arms and legs pass
  // by each other (a strike is judged by contact() instead), and a jump clears the
  // other fighter because its barrel is higher, not because of a height rule.
  const BARREL = rig.domains.torso;
  const TOUCH = 7;   // Å: nearest CA of one barrel to the other's, at which they are in contact
  // The CPU's spacing thresholds were tuned as centre distances with contact forced at
  // 42 Å; adding this to the barrel gap keeps each one the same distance from contact.
  const BARREL_SPAN = 42 - TOUCH;
  const barrelX = f => BARREL.reduce((s, i) => s + f.coords[i][0], 0) / BARREL.length;
  function barrelGap(a, b) {
    let best = Infinity;
    for (const i of BARREL) {
      const q = a.coords[i];
      for (const j of BARREL) {
        const r = b.coords[j], dx = q[0] - r[0], dy = q[1] - r[1], dz = q[2] - r[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
  // Move a whole body along x, as far as the arena allows, velocity untouched.
  function slide(f, dx) {
    const want = dx, x = Math.max(-ARENA, Math.min(ARENA, f.x + dx));
    dx = x - f.x; f.x = x;
    // Shoved and the wall would not give: pinned between it and the other fighter.
    if (Math.abs(dx) < Math.abs(want) - 1e-6) f.pressed = Math.sign(want);
    for (let i = 0; i < N; i++) { f.coords[i][0] += dx; f.prev[i][0] += dx; }
    return Math.abs(dx);
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
      f.fatigue = Math.max(0, f.fatigue - dt * 0.08);
      physics(f, dt);
      f.dents = f.dents.filter(hit => (hit.t += dt) < DENT_LIFE);
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

    for (const f of fighters) f.x = Math.max(-ARENA, Math.min(ARENA, f.x));

    // Bodies, then contact between them, then hits against the bodies as they are now
    for (const f of fighters) f.coords = body(f, clock);
    collide(p, c);
    // Facing only turns on the ground, so a cross-up hits from the far side.
    for (const [f, o] of [[p, c], [c, p]]) {
      const fx = barrelX(f), ox = barrelX(o);
      if (f.y === 0 && !MOVES[f.action] && fx !== ox) f.facing = fx < ox ? 1 : -1;
    }
    fighters.forEach((a, i) => {
      const m = MOVES[a.action], b = fighters[1 - i];
      // Live from most of the way out, so a strike thrown point-blank lands where it meets
      // the body instead of passing through it before the active frame.
      if (!m || a.hit || a.t < m.active * 0.6 || b.hp === 0) return;
      if (a.t > m.active + m.window) { a.hit = true; sfx.whiff(); return; }   // whiffed
      const at = contact(a, b);
      if (!at) return;
      a.hit = true;
      const blocked = b.guard && b.y === 0 && (m.low ? b.crouch : m.overhead ? !b.crouch : true);
      // A strike is only as strong as the part throwing it (unfolded arms punch weaker,
      // unfolded legs kick weaker) and weakens further as the whole protein comes apart.
      // Everything a blow does follows its strength: the damage, and also how far it
      // shoves, how deep it dents, how long it stuns and how hard it lands on screen.
      const power = strikePower(a, a.action);
      const dmg = m.damage * (blocked ? 0.15 : 1) * DAMAGE_SCALE * power;
      b.vx = a.facing * m.push * (blocked ? 0.35 : 1) * power;
      wound(b, at, dmg, m.low, a.facing);
      dent(b, at, a.facing, m.damage * (blocked ? 0.3 : 1) * power);
      b.lastHit = at;
      if (!blocked) {
        b.stun = m.stun * (0.4 + 0.6 * power); b.action = 'hurt'; b.t = 0; b.squat = 0;
        if (b.y > 0) b.vy = Math.max(b.vy, 260);   // hit in the air: popped up, then falls
      }
      hitstop = blocked ? 0.03 : 0.05 + m.damage * 0.003 * power;
      if (b.hp === 0) { b.action = 'ko'; b.t = 0; }
      flash(at, blocked ? 'BLOCK' : m.text);
      if (blocked) sfx.block(); else sfx.hit(m.damage * power / 13);
    });

    if (fighters.some(f => f.hp === 0) || time === 0) {
      phase = 'ko'; koTimer = 0;
      for (const f of fighters) if (f.hp === 0) denature(f);
      if (!fighters.some(f => f.hp === 0)) announce('TIME');
      sfx.ko();
    }
  }

  // Denaturing, in two acts. First the collapse: the knees give and the body drops into a
  // heap under its own weight, the chain still loosely holding the pose. Then the
  // unfolding: from where the last blow landed, a wave runs out along the chain, and each
  // residue it reaches lets go of the heap, with a shove outward as the fold breaks,
  // until a tangle lies spread on the floor.
  const COLLAPSE = 0.45, UNFOLD = 1.6, KO_HOLD = 3.4;   // seconds
  function denature(f) {
    const at = f.lastHit || f.coords[180];
    let brk = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const q = f.coords[i], d = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      if (d < bestD) { bestD = d; brk = i; }
    }
    f.koWave = Float32Array.from({ length: N }, (_, i) => Math.abs(i - brk) / N);   // 0 at the break, further along the chain after
    f.koLoose = new Float32Array(N);
    f.koBurst = false;
  }
  function letGo(f) {
    const c = f.coords;
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
        for (let i = 0; i < N; i++) {
          f.unfold[i] = Math.min(1, f.unfold[i] + dt * 0.55);
          f.koLoose[i] = clamp01((front - f.koWave[i]) * 2.5);
        }
      }
      if (f.hp > 0) {   // the one still standing lets its guard down and rests
        f.stun = Math.max(0, f.stun - dt);
        if (!MOVES[f.action] || f.t >= MOVES[f.action].duration) f.action = 'rest';
        f.guard = f.crouch = f.run = false; f.squat = 0; f.queued = null;
      }
      f.coords = body(f, clock);
    }
    if (phase === 'ko' && koTimer > KO_HOLD) endRound();
  }

  // ------------------------------------------------------------------------ HUD
  function flash(at, text) {
    const el = $('impact');
    el.textContent = text;
    el.style.left = 50 + at[0] * 0.28 + '%';
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const announce = text => flash([0, 0, 0], text);

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
  // into the 91-pixel map: the row is the residue aligned on, the column the one scored.
  const PAE_BIN = 4, PB = Math.ceil(N / PAE_BIN), PAE_MAX = 30;
  const PAE_COUNT = new Float32Array(PB * PB);   // residue pairs pooled into each pixel
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) PAE_COUNT[(i / PAE_BIN | 0) * PB + (j / PAE_BIN | 0)]++;
  const paeSum = new Float32Array(PB * PB), paeFrames = new Float64Array(N * 12);
  // Residue i's frame, twelve numbers: the origin, then three orthonormal axes.
  function localFrames(coords, F) {
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
    const F = localFrames(coords, new Float64Array(N * 12)), L = new Float32Array(N * N * 3);
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
    const canvas = $('pae' + i);
    if (!canvas || !f.pae) return;
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
  function tone(freq, to, dur, { type = 'sine', gain = 0.3, delay = 0, dest = bus } = {}) {
    const a = out(); if (!a) return;
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, from, to, { gain = 0.3, filter = 'lowpass', delay = 0, dest = bus } = {}) {
    const a = out(); if (!a) return;
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
      if (phase === 'playing') { phase = 'paused'; for (const h of held) h.clear(); overlay('PAUSED', 'Ready when you are.', 'RESUME'); duckMusic(0.08); }
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
  $('sound').onclick = () => {
    sound = !sound; $('sound').textContent = sound ? 'SOUND ON' : 'SOUND OFF'; sfx.block();
    if (!sound) stopMusic();
    else if (phase !== 'ready') { startMusic(); if (phase !== 'playing') duckMusic(0.12); }
  };
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
        if (phase === 'playing') step(DT);
        else if (phase === 'ko' || phase === 'over') stepKO(DT);   // after the round, the heap keeps settling
        else for (const f of fighters) f.coords = body(f, clock);   // idle breathing behind the menus
        acc -= DT; moved = true;
      }
    }
    if (moved) {
      draw();
      fighters.forEach((f, i) => { updatePAE(f); drawPAE(f, i); });   // live PAE maps
    }
    hud();
    requestAnimationFrame(frame);
  }

  try {
    applyTheme();
    resetRound();
    startViewer(fighters[0].coords, fighters[1].coords);
    window.proteinFighter = { get fighters() { return fighters; }, get mode() { return mode; }, get viewer() { return viewer; }, camera: CAMERA, rig, barrelGap, updatePAE };   // for poking at from the console
    $('one').disabled = $('two').disabled = false;
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    overlay('RENDERER UNAVAILABLE', String(e && e.message || e), 'RELOAD');
    $('go').onclick = () => location.reload();
  }
})();

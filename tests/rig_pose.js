// Poses both fighters' rigs through the game's own motion and checks the chain holds:
// every CA-CA bond stays a CA step, nothing goes NaN, and the rigid domains keep their
// shape. Run with:  node tests/rig_pose.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

// rig.js and motion.js hang themselves on `window`.
const window = {};
for (const file of ['rig.js', 'motion.js']) new Function('window', fs.readFileSync(path.join(ROOT, file), 'utf8'))(window);
const { DomainRig, rotX: X, rotY: Y, matMul3: mul, CA_STEP } = window.Rig;
const RIGS = {
  barrel: require(path.join(ROOT, 'rig_data.js')).HUMANOID_V8_RIG,
  helix: require(path.join(ROOT, 'rig_data_helix.js')).HELIX_FIGHTER_RIG,
};
const MOVES = {   // as in game.js
  punch: { duration: 0.24, active: 0.07 }, kick: { duration: 0.40, active: 0.13 }, lowpunch: { duration: 0.22, active: 0.06 },
  lowkick: { duration: 0.42, active: 0.14 }, airpunch: { duration: 0.30, active: 0.06 }, airkick: { duration: 0.40, active: 0.08 },
};
const arm = (side, lift) => mul(Y(side * Math.PI / 2), X(lift));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('  FAIL', msg); } };

for (const [name, data] of Object.entries(RIGS)) {
  const rig = new DomainRig(data);
  console.log(`${name}: ${rig.n} residues, tethers ${rig.tethers.map(t => t.domains[0] + '×' + t.pulls.length).join(' ')}`);

  // The joints motion.js relies on, at heights the shared stance constants were tuned to.
  for (const key of ['larm_shoulder', 'larm_hand', 'rarm_shoulder', 'rarm_hand', 'lleg_hip', 'lleg_knee', 'lleg_ankle', 'rleg_hip', 'rleg_knee', 'rleg_ankle'])
    check(rig.pivots[key], `${name} lacks pivot ${key}`);
  const legLen = dist(rig.pivots.lleg_hip, rig.pivots.lleg_knee) + dist(rig.pivots.lleg_knee, rig.pivots.lleg_ankle);
  check(Math.abs(legLen - 62.9) < 3, `${name} leg is ${legLen.toFixed(1)} Å hip to ankle, the stance expects about 63`);
  const armLen = dist(rig.pivots.rarm_shoulder, rig.pivots.rarm_hand);
  check(Math.abs(armLen - 49.5) < 5, `${name} arm reaches ${armLen.toFixed(1)} Å, expected about 50`);

  // Rigid domains stay rigid; hinges bend but bonds hold.
  const poses = [
    {},
    { root_R: X(0.3), larm_upper: arm(-1, -0.65), larm_lower: arm(-1, 1.15), rarm_upper: arm(1, -1), rarm_lower: arm(1, 0.95),
      lleg_upper: X(0.4), lleg_lower: X(-0.9), lleg_foot: X(0.2), rleg_upper: X(-0.5), rleg_lower: X(-1.2), rleg_foot: X(0.5) },
    { root_R: X(-1.2), larm_upper: arm(-1, 1.4), larm_lower: arm(-1, 1.4), rarm_upper: arm(1, 1.4), rarm_lower: arm(1, 1.4),
      lleg_upper: X(1.2), lleg_lower: X(-2.2), lleg_foot: X(0.9), rleg_upper: X(-0.8), rleg_lower: X(-2.5), rleg_foot: X(1.4) },
    { rarm_upper: arm(1, 0), rarm_lower: arm(1, 0), lleg_upper: X(-0.3), rleg_upper: X(1.9), rleg_lower: X(0.2), rleg_foot: X(0.9) },
  ];
  for (const [k, tr] of poses.entries()) {
    const p = rig.pose(tr);
    check(p.every(q => q.every(Number.isFinite)), `${name} pose ${k}: NaN`);
    let worst = 0, at = 0;
    for (let i = 0; i < rig.n - 1; i++) { const e = Math.abs(dist(p[i], p[i + 1]) - CA_STEP); if (e > worst) { worst = e; at = i; } }
    check(worst < 0.25, `${name} pose ${k}: bond ${at + 1}-${at + 2} off by ${worst.toFixed(2)} Å`);
    for (const [dom, idx] of Object.entries(rig.domains)) {
      if (dom === 'larm' || dom === 'rarm') continue;   // an arm bends at its elbow
      let drift = 0;
      for (let a = 0; a < idx.length; a += 7) for (let b = a + 1; b < idx.length; b += 5)
        drift = Math.max(drift, Math.abs(dist(p[idx[a]], p[idx[b]]) - dist(rig.bind[idx[a]], rig.bind[idx[b]])));
      check(drift < 0.6, `${name} pose ${k}: domain ${dom} distorted by ${drift.toFixed(2)} Å`);
    }
  }

  // Through the game's motion: a few seconds of walking, a kick, a jump, a crouch.
  const motion = window.Motion.create(rig, { MOVES, JUMP_V: 655, JUMP_VX: 240, SQUAT: 0.07, LANDING: 0.2 });
  const f = { x: 0, y: 0, vx: 0, vy: 0, facing: 1, hp: 100, crouch: false, squat: 0, landing: 0, landPower: 0, stun: 0, action: 'idle', t: 0, seed: 1, motion: null, fatigue: 0 };
  const env = { clock: 0, dt: 1 / 60, sag: 0, crawl: 0, tired: 0.2, mean: 0, kickRange: 1 };
  const script = [['idle', 0.5], ['walk', 2.0], ['idle', 0.5], ['kick', 0.4], ['idle', 0.3], ['crouch', 0.5], ['lowkick', 0.42], ['jump', 0.6]];
  let lowest = Infinity, worstBond = 0;
  for (const [what, secs] of script) {
    for (let t = 0; t < secs; t += env.dt) {
      env.clock += env.dt;
      f.crouch = what === 'crouch';
      if (what === 'walk') { f.action = 'walk'; f.x += 130 * env.dt; }
      else if (what === 'jump') { f.action = 'idle'; f.y = Math.max(0, 40 * Math.sin(Math.PI * t / secs)); f.vy = 200 * Math.cos(Math.PI * t / secs); }
      else if (MOVES[what]) { f.action = what; f.t = t; }
      else f.action = 'idle';
      const p = motion.update(f, env);
      check(p.every(q => q.every(Number.isFinite)), `${name} motion (${what}): NaN`);
      for (let i = 0; i < rig.n - 1; i++) worstBond = Math.max(worstBond, Math.abs(dist(p[i], p[i + 1]) - CA_STEP));
      // Standing or walking, the soles stand on the floor. (A crouch kneels through it and
      // a low kick sweeps under it; the game's physics holds those residues at the floor.)
      if (what === 'idle' || what === 'walk') for (const q of p) lowest = Math.min(lowest, q[1]);
    }
  }
  check(worstBond < 0.25, `${name} motion: a bond off by ${worstBond.toFixed(2)} Å`);
  check(lowest > -1 && lowest < 4, `${name} motion: soles at y = ${lowest.toFixed(1)} standing and walking (they should stand near y = 2)`);
  console.log(`  bonds within ${worstBond.toFixed(3)} Å through the motion, soles at y = ${lowest.toFixed(1)}`);
}
console.log(failures ? `${failures} failure(s)` : 'ok');
process.exit(failures ? 1 : 0);

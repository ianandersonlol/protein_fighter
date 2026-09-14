// Forward kinematics for the humanoid v8 protein (from ../dance/mocap_engine.js, with
// the arms reworked). Rigid domains follow joint rotations, each helical arm is two
// rigid helices hinged at the elbow, and hinge loops relax.
(function () {
  const CA_STEP = 3.8021;

  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // 3x3 matrices, row-major flat arrays
  const mat3Eye = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const matT = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  function matMul3(A, B) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return out;
  }
  const matVec3 = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
  function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }

  class DomainRig {
    constructor(data) {
      this.n = data.n_ca;
      this.bind = data.ca_xyz.map(p => p.slice());
      this.pivots = data.pivots;
      this.domains = data.domain_indices;
    }

    // An arm is two rigid helices, shoulder→elbow and elbow→hand, joined by a short
    // hinge. The rigid halves keep every i→i+3 and i→i+4 distance of the bind helix,
    // so the cartoon still reads helix on both sides of the elbow; only the few hinge
    // residues bend. (The original smeared the bend over 60% of the arm by blending
    // rotations residue by residue, which distorted the helical turns by up to 3.7 Å.)
    _bendArm(ca, pShBind, pHandBind, pSh, Rup, Rfa, reverse) {
      const n = ca.length, HINGE = 0.07;   // half-width of the hinge, as a fraction of the arm
      const pElBind = scale3(add3(pShBind, pHandBind), 0.5);
      const RupT = matT(Rup), RfaT = matT(Rfa);
      const pEl = add3(matVec3(RupT, sub3(pElBind, pShBind)), pSh);
      const out = new Array(n), free = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = reverse ? 1 - i / (n - 1) : i / (n - 1);   // 0 at the shoulder, 1 at the hand
        const upper = add3(matVec3(RupT, sub3(ca[i], pShBind)), pSh);
        const fore = add3(matVec3(RfaT, sub3(ca[i], pElBind)), pEl);
        const u = Math.min(Math.max((s - (0.5 - HINGE)) / (2 * HINGE), 0), 1);
        const w = u * u * (3 - 2 * u);
        out[i] = add3(scale3(upper, 1 - w), scale3(fore, w));
        free[i] = u > 0 && u < 1 ? 1 : 0;
      }
      // Restore bond lengths through the hinge without moving either rigid helix.
      for (let it = 0; it < 30; it++) {
        for (let i = 0; i < n - 1; i++) {
          if (!free[i] && !free[i + 1]) continue;
          const d = sub3(out[i + 1], out[i]), l = norm3(d);
          if (l < 1e-9) continue;
          const corr = scale3(d, (l - CA_STEP) / l);
          if (free[i] && free[i + 1]) { out[i] = add3(out[i], scale3(corr, 0.5)); out[i + 1] = sub3(out[i + 1], scale3(corr, 0.5)); }
          else if (free[i]) out[i] = add3(out[i], corr);
          else out[i + 1] = sub3(out[i + 1], corr);
        }
      }
      return out;
    }

    // transforms: {root_R, root_T, larm_upper, larm_lower, rarm_upper, rarm_lower,
    //   lleg_upper, lleg_lower, lleg_foot, rleg_upper, rleg_lower, rleg_foot, head}
    pose(tr) {
      const P = this.pivots, D = this.domains;
      const ca = this.bind.map(p => p.slice());
      const Rroot = tr.root_R || mat3Eye(), Troot = tr.root_T || [0, 0, 0];
      const RrootT = matT(Rroot);
      const pelvis = scale3(add3(P.lleg_hip, P.rleg_hip), 0.5);
      const fromRoot = p => add3(add3(matVec3(RrootT, sub3(p, pelvis)), pelvis), Troot);

      const Rlup = tr.larm_upper || Rroot, Rlfa = tr.larm_lower || Rlup;
      const Rrup = tr.rarm_upper || Rroot, Rrfa = tr.rarm_lower || Rrup;
      const Rlth = tr.lleg_upper || Rroot, Rlsh = tr.lleg_lower || Rlth, Rlft = tr.lleg_foot || Rlsh;
      const Rrth = tr.rleg_upper || Rroot, Rrsh = tr.rleg_lower || Rrth, Rrft = tr.rleg_foot || Rrsh;
      const Rhd = tr.head || Rroot;

      const pLsh = fromRoot(P.larm_shoulder), pRsh = fromRoot(P.rarm_shoulder);
      const pLhip = fromRoot(P.lleg_hip), pRhip = fromRoot(P.rleg_hip);
      const pLkn = add3(matVec3(matT(Rlth), sub3(P.lleg_knee, P.lleg_hip)), pLhip);
      const pLank = add3(matVec3(matT(Rlsh), sub3(P.lleg_ankle, P.lleg_knee)), pLkn);
      const pRkn = add3(matVec3(matT(Rrth), sub3(P.rleg_knee, P.rleg_hip)), pRhip);
      const pRank = add3(matVec3(matT(Rrsh), sub3(P.rleg_ankle, P.rleg_knee)), pRkn);

      // Each rigid domain: world = RT * bind + t, pinned at its joint.
      const pin = (R, pivotBind, pivotWorld) => [matT(R), sub3(pivotWorld, matVec3(matT(R), pivotBind))];
      const affine = {
        torso: [RrootT, sub3(add3(pelvis, Troot), matVec3(RrootT, pelvis))],
        lleg_thigh: pin(Rlth, P.lleg_hip, pLhip),
        lleg_shin: pin(Rlsh, P.lleg_knee, pLkn),
        lleg_foot: pin(Rlft, P.lleg_ankle, pLank),
        rleg_thigh: pin(Rrth, P.rleg_hip, pRhip),
        rleg_shin: pin(Rrsh, P.rleg_knee, pRkn),
        rleg_foot: pin(Rrft, P.rleg_ankle, pRank),
      };
      if (P.neck) affine.head = pin(Rhd, P.neck, fromRoot(P.neck));

      const owner = new Array(this.n).fill(null);
      for (const name in affine) {
        if (!D[name]) continue;
        const [R, t] = affine[name];
        for (const i of D[name]) { ca[i] = add3(matVec3(R, this.bind[i]), t); owner[i] = name; }
      }
      const arms = [
        ['larm', P.larm_shoulder, P.larm_hand, pLsh, Rlup, Rlfa, true],
        ['rarm', P.rarm_shoulder, P.rarm_hand, pRsh, Rrup, Rrfa, false],
      ];
      for (const [name, sb, hb, ps, Ru, Rf, rev] of arms) {
        const bent = this._bendArm(D[name].map(i => this.bind[i]), sb, hb, ps, Ru, Rf, rev);
        D[name].forEach((i, k) => { ca[i] = bent[k]; owner[i] = name; });
      }
      // Unowned hinge residues: blend the neighbouring domains' transforms.
      for (let i = 0; i < this.n; i++) {
        if (owner[i] !== null) continue;
        let a = i - 1; while (a >= 0 && owner[a] === null) a--;
        let b = i + 1; while (b < this.n && owner[b] === null) b++;
        if (a < 0 || b >= this.n) continue;
        const f = (i - a) / (b - a);
        const [Ra, ta] = affine[owner[a]] || affine.torso, [Rb, tb] = affine[owner[b]] || affine.torso;
        ca[i] = add3(scale3(add3(matVec3(Ra, this.bind[i]), ta), 1 - f), scale3(add3(matVec3(Rb, this.bind[i]), tb), f));
      }
      this._relax(ca, owner, 40);
      return ca;
    }

    _relax(ca, owner, iterations) {
      const D = this.domains;
      const pull = (from, to, maxReach) => {
        const d = dist3(ca[from], ca[to]);
        return d > maxReach ? scale3(sub3(ca[to], ca[from]), 0.5 * (d - maxReach) / d) : [0, 0, 0];
      };
      const shiftDomains = (names, s) => {
        if (norm3(s) <= 1e-4) return;
        for (const name of names) for (const i of D[name]) ca[i] = add3(ca[i], s);
      };
      for (let it = 0; it < iterations; it++) {
        for (const [th, sh, ft, a, b] of [['lleg_thigh', 'lleg_shin', 'lleg_foot', 43, 88], ['rleg_thigh', 'rleg_shin', 'rleg_foot', 173, 218]]) {
          const i0 = D[th][0], i1 = D[th][D[th].length - 1];
          shiftDomains([th, sh, ft], add3(pull(i0, a, (i0 - a) * CA_STEP * 0.98), pull(i1, b, (b - i1) * CA_STEP * 0.98)));
        }
        for (const [ft, sa, fa, fb, sb] of [['lleg_foot', 60, 62, 69, 71], ['rleg_foot', 190, 192, 199, 201]]) {
          const reach = 2 * CA_STEP * 0.98;
          shiftDomains([ft], add3(pull(fa, sa, reach), pull(fb, sb, reach)));
        }
        if (D.head) {
          const reach = 3 * CA_STEP * 0.96;
          shiftDomains(['head'], add3(pull(124, 121, reach), pull(161, 164, reach)));
        }
        for (let i = 0; i < this.n - 1; i++) {
          if (owner[i] !== null && owner[i] === owner[i + 1]) continue;
          const d = sub3(ca[i + 1], ca[i]), l = norm3(d);
          if (l < 1e-9) continue;
          const corr = scale3(d, 0.5 * (l - CA_STEP) / l);
          const fixedA = owner[i] !== null, fixedB = owner[i + 1] !== null;
          if (fixedA && !fixedB) ca[i + 1] = sub3(ca[i + 1], scale3(corr, 2));
          else if (fixedB && !fixedA) ca[i] = add3(ca[i], scale3(corr, 2));
          else { ca[i] = add3(ca[i], corr); ca[i + 1] = sub3(ca[i + 1], corr); }
        }
      }
    }
  }

  window.Rig = { CA_STEP, DomainRig, rotX, rotY, matMul3, mat3Eye };
})();

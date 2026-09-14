#!/usr/bin/env python3
"""Build the helical fighter: the humanoid from ../dance turned inside out.

The humanoid is a beta barrel with helix arms and sheet legs. This one is a six-helix
bundle with beta-hairpin arms and helix legs, and a tiny six-strand barrel for a head:

  torso  eight antiparallel alpha helices on a ring, joined by short loops at the top
         and bottom - an alpha-helical barrel. The chain runs from the back left round
         the front to the back right, crosses under the back of the bundle, and finishes
         with the two helices at the back
  head   the top loop between those last two helices, dead centre at the back, is a
         small eight-strand beta barrel on short necks
  arms   the top loops on the two front helices carry on outward as beta hairpins: an
         out strand, a two residue turn, and a strand back, lying flat like paddles
  legs   the chain's two ends: from under the back helix on each side a single helix
         runs down to the ankle, turns, and finishes as a short helix pointing forward -
         a foot. The N-terminus is the left toe, the C-terminus the right toe

Same joints as the humanoid (hip, knee, ankle, shoulder, elbow, hand, neck), at the same
heights and reaches, so motion.js drives it with the very same stance and walk. World
units are Angstrom: x runs left (-) to right (+), y up, z forward; the pelvis sits near
the origin, as in the humanoid, and every CA-CA bond is exactly CA_STEP.

Writes rig_data_helix.js (the C-alpha scaffold, joint pivots and rigid domains the game
loads) and scripts/helix_fighter.pdb (a C-alpha trace to look at in any viewer).

    python3 scripts/build_helix_fighter.py
"""
import json
from math import ceil, pi
from pathlib import Path

import numpy as np

CA_STEP = 3.8021
ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------------- geometry
def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    if n < 1e-9:
        raise ValueError('zero vector')
    return v / n


def perpendicular(direction, preferred):
    direction = unit(direction)
    p = np.asarray(preferred, float)
    v = p - p.dot(direction) * direction
    if np.linalg.norm(v) < 1e-6:
        v = np.cross(direction, [0.0, 1.0, 0.0])
    if np.linalg.norm(v) < 1e-6:
        v = np.cross(direction, [0.0, 0.0, 1.0])
    return unit(v)


def helix(axis_point, direction, count, phase=0.0, ref=(0.0, 0.0, 1.0)):
    """Ideal right-handed alpha helix: 1.5 A rise, 100 deg per residue, exact CA spacing.
    Residue i sits on the axis point + i * rise, at `phase + i * twist` around it."""
    direction = unit(direction)
    e1 = perpendicular(direction, ref)
    e2 = unit(np.cross(direction, e1))
    rise, twist = 1.50, np.deg2rad(100.0)
    radius = np.sqrt(CA_STEP ** 2 - rise ** 2) / (2.0 * np.sin(twist / 2.0))
    a = np.asarray(axis_point, float)
    return np.asarray([a + i * rise * direction + radius * (np.cos(phase + i * twist) * e1 + np.sin(phase + i * twist) * e2)
                       for i in range(count)])


def choose_phase(prev, axis_point, direction, count, target, ref=(0.0, 0.0, 1.0), avoid=()):
    """The helix phase whose first residue sits `target` A from the previous residue,
    and not on top of the residues before it (`avoid`), so the loop between them does
    not fold back through the helix it leaves."""
    best = None
    for deg in range(0, 360, 5):
        pts = helix(axis_point, direction, count, np.deg2rad(deg), ref)
        err = abs(np.linalg.norm(pts[0] - prev) - target)
        for q in avoid:
            err += max(0.0, 4.5 - np.linalg.norm(pts[0] - q)) * 3.0
        if best is None or err < best[0]:
            best = (err, pts)
    return best[1]


def exact_bridge(start, end, preferred=(0.0, 1.0, 0.0), min_segments=3):
    """A circular arc of exact CA steps from start to end, bulging away from `preferred`."""
    start, end = np.asarray(start, float), np.asarray(end, float)
    delta = end - start
    distance = np.linalg.norm(delta)
    if distance < 1e-7:
        raise ValueError('bridge endpoints coincide')
    direction = delta / distance
    if abs(distance - CA_STEP) < 1e-4:
        return np.asarray((start, end))
    segments = max(min_segments, ceil(distance / CA_STEP))
    low, high = 1e-8, 2.0 * pi / segments - 1e-8
    for _ in range(80):
        d = 0.5 * (low + high)
        chord = CA_STEP * np.sin(segments * d / 2.0) / np.sin(d / 2.0)
        if chord > distance:
            low = d
        else:
            high = d
    d = 0.5 * (low + high)
    side = perpendicular(direction, preferred)
    points, point = [start.copy()], start.copy()
    for k in range(segments):
        angle = (k - 0.5 * (segments - 1)) * d
        point = point + CA_STEP * (np.cos(angle) * direction + np.sin(angle) * side)
        points.append(point.copy())
    points[-1] = end.copy()
    return np.asarray(points)


def strand_pair(start, direction, count, separation, pleat=0.8, phase=0):
    """Two in-register antiparallel strands, the second `separation` (a vector) from the
    first, pleating together up and down across the sheet. Returns (out, back): the out
    strand from start onward, the back strand alongside it running the other way."""
    direction, separation = unit(direction), np.asarray(separation, float)
    pleat_dir = unit(np.cross(direction, separation))
    if pleat_dir[1] < 0:
        pleat_dir = -pleat_dir
    step = np.sqrt(CA_STEP ** 2 - (2 * pleat) ** 2)
    start = np.asarray(start, float)
    out = np.asarray([start + i * step * direction + (pleat if (i + phase) % 2 == 0 else -pleat) * pleat_dir for i in range(count)])
    back = out + separation
    return out, back[::-1]


def barrel_strand(center, radius, base_theta, twist_deg, count, pleat=0.7, phase=0):
    """One strand of an idealised beta barrel, bottom to top, as in ../dance: on a ring
    about a vertical axis, sweeping `twist_deg` around it from bottom to top, pleating
    radially in and out, with exact CA steps."""
    horizontal = []
    for i in range(count):
        theta = base_theta + np.deg2rad(twist_deg * i / (count - 1))
        r = radius + (pleat if (i + phase) % 2 == 0 else -pleat)
        horizontal.append(np.array([r * np.cos(theta), 0.0, r * np.sin(theta)]))
    vertical = [0.0]
    for a, b in zip(horizontal[:-1], horizontal[1:]):
        vertical.append(vertical[-1] + np.sqrt(CA_STEP ** 2 - np.linalg.norm(b - a) ** 2))
    vertical = np.asarray(vertical) - 0.5 * (vertical[0] + vertical[-1])
    return np.asarray([np.asarray(center, float) + h + np.array([0.0, y, 0.0]) for h, y in zip(horizontal, vertical)])


class Trace:
    def __init__(self):
        self.points, self.labels = [], []

    def add(self, points, label):
        """Append points with one label for all, or a label per point."""
        points = np.asarray(points, float)
        labels = [label] * len(points) if isinstance(label, str) else list(label)
        if len(labels) != len(points):
            raise ValueError('point/label count mismatch')
        if self.points:
            d = np.linalg.norm(points[0] - self.points[-1])
            if abs(d - CA_STEP) > 2e-3:
                raise ValueError(f'{labels[0]}: join is {d:.3f} A, not a CA step')
        self.points.extend(points)
        self.labels.extend(labels)

    def bridge(self, to, label, preferred, min_segments=3):
        """Loop residues from the last point to `to` (exclusive of both)."""
        arc = exact_bridge(self.points[-1], to, preferred, min_segments)
        if len(arc) > 2:
            self.add(arc[1:-1], label)

    @property
    def last(self):
        return np.asarray(self.points[-1])

    @property
    def recent(self):
        """The few residues before the last: what a new segment must not sit on."""
        return [np.asarray(q) for q in self.points[-6:-1]]


# -------------------------------------------------------------------------- design
TORSO_RADIUS, TORSO_LEN, TORSO_TOP = 11.5, 21, 15.0      # y from +15 down to -15
# Helices 1..8 around the ring, by angle in the x-z plane (0 is +x, 90 is +z, forward).
# Odd helices run up, even ones down. The chain starts under helix 1 at the back left
# side, goes round the front to helix 6 at the back right side, then crosses under the
# back of the bundle (as the barrel humanoid's chain crosses under its belly) to helix 7
# at the back left, and ends under helix 8 at the back right. So the top loop 7-8 that
# carries the head is dead centre at the back, the top loops 1-2 and 5-6 that carry the
# arms are at the front of each shoulder, and the legs hang from the back.
TORSO_ANGLES = [202.5, 157.5, 112.5, 67.5, 22.5, 337.5, 247.5, 292.5]
ARM_Y, SHOULDER_X, ARM_STRAND, STRAND_SEP = 16.5, 20.5, 13, 4.75   # the strands start here, far enough out that the paddle turned forward clears the front helices
ROOT_UP = 1.5   # the two root residues sit on the paddle's centre line, this far above and below it: the arm turns about them
# Pleat phases (0 or 1): which residues pleat out. They decide which strand pairs py2Dmol
# sees as hydrogen-bonded, and so whether the residues flanking each turn read as strand.
ARM_ELBOW = 0.38   # where the paddle bends, shoulder 0 … hand 1: a short upper arm and a long forearm held up in the guard
ARM_HINGE = 0.25   # how far each side of the elbow the bend is spread, as a fraction of the arm: a curved sheet keeps its pairing better than a kink
ARM_PHASE = {-1: 1, +1: 1}   # per side (left -1, right +1); scanned so each hairpin reads as strand right up to its turns
HEAD_PHASE, TURN_SEGMENTS = 0, 3
LEG_X, LEG_Z, HIP_Y, LEG_LEN, KNEE = 8.5, -6.0, -16.5, 42, 20   # helix residue 20 is the knee; hips at the back, as the humanoid's
FOOT_Y, FOOT_Z0, FOOT_LEN = -80.0, -3.0, 11               # the foot points forward, +z, from just ahead of the ankle
HEAD_CENTER, HEAD_STRANDS, HEAD_STRAND, HEAD_TWIST = (0.0, 31.5, -3.0), 8, 5, 0.0   # an even count: both necks leave the bottom
HEAD_RADIUS = 4.8 / (2.0 * np.sin(pi / HEAD_STRANDS))      # strands 4.8 A apart around the ring

UP, DOWN, FWD, BACK = np.array([0, 1.0, 0]), np.array([0, -1.0, 0]), np.array([0, 0, 1.0]), np.array([0, 0, -1.0])


def ring(theta_deg, y, radius=TORSO_RADIUS):
    t = np.deg2rad(theta_deg)
    return np.array([radius * np.cos(t), y, radius * np.sin(t)])


def torso_helix(k, prev):
    """Torso helix k (0..7), up for even k, down for odd, phased to meet the trace `prev`."""
    theta = TORSO_ANGLES[k]
    if k % 2 == 0:
        return choose_phase(prev.last, ring(theta, TORSO_TOP - 1.5 * (TORSO_LEN - 1)), UP, TORSO_LEN, 8.5, avoid=prev.recent)
    return choose_phase(prev.last, ring(theta, TORSO_TOP), DOWN, TORSO_LEN, 8.5, avoid=prev.recent)


def build():
    tr = Trace()
    pivots = {}

    def leg_pivots(side):
        x, s = side * LEG_X, 'l' if side < 0 else 'r'
        pivots[f'{s}leg_hip'] = [x, HIP_Y, LEG_Z]
        pivots[f'{s}leg_knee'] = [x, HIP_Y - 1.5 * KNEE, LEG_Z]
        pivots[f'{s}leg_ankle'] = [x, HIP_Y - 1.5 * (LEG_LEN - 1), LEG_Z]
        pivots[f'{s}leg_toe'] = [x, FOOT_Y, FOOT_Z0 + 1.5 * (FOOT_LEN - 1)]

    def arm(side, z_out, z_back):
        """A beta hairpin out along ±x from a top loop: paddle flat in the x-z plane,
        strands side by side along z, pleating up and down. Its two root residues (the
        loop residues bonded to the strands) stand one above and one below the paddle's
        centre line, so the arm can turn about the line through them without stretching
        either shoulder loop."""
        name = 'left' if side < 0 else 'right'
        start = np.array([side * SHOULDER_X, ARM_Y, z_out])
        out, back = strand_pair(start, [side, 0.0, 0.0], ARM_STRAND, [0.0, 0.0, z_back - z_out], phase=ARM_PHASE[side])
        zc = (z_out + z_back) / 2
        root_in = np.sqrt(CA_STEP ** 2 - ROOT_UP ** 2 - (STRAND_SEP / 2) ** 2)   # so each root is a bond from its strand
        root_a = np.array([side * (SHOULDER_X - root_in), out[0][1] + ROOT_UP, zc])    # above its strand's first residue (which pleats up or down)
        root_b = np.array([side * (SHOULDER_X - root_in), back[-1][1] - ROOT_UP, zc])  # below the strand back's last
        tr.bridge(root_a, f'{name}_shoulder', preferred=DOWN, min_segments=2)
        tr.add([root_a], f'{name}_arm_root')
        tr.add(out, f'{name}_arm_strand_out')
        tr.bridge(back[0], f'{name}_hand_turn', preferred=[-side, 0.0, 0.0], min_segments=TURN_SEGMENTS)
        tr.add(back, f'{name}_arm_strand_back')
        tr.add([root_b], f'{name}_arm_root')
        turn = [i for i, l in enumerate(tr.labels) if l == f'{name}_hand_turn']
        pivots[f'{"r" if side > 0 else "l"}arm_hand'] = np.mean([tr.points[i] for i in turn], axis=0).tolist()

    # --- left leg, from the toe up: the N-terminus ----------------------------------
    # The foot helix runs backward from the toe to the ankle, then a corner, then the
    # leg helix climbs to the hip.
    foot = helix([-LEG_X, FOOT_Y, FOOT_Z0 + 1.5 * (FOOT_LEN - 1)], BACK, FOOT_LEN, 0.0, ref=UP)
    tr.add(foot, 'left_foot_helix')
    leg = choose_phase(tr.last, [-LEG_X, HIP_Y - 1.5 * (LEG_LEN - 1), LEG_Z], UP, LEG_LEN, 5.5, avoid=tr.recent)
    tr.bridge(leg[0], 'left_ankle', preferred=[1.0, 0.0, 1.0], min_segments=2)
    tr.add(leg, 'left_leg_helix')
    leg_pivots(-1)

    # --- torso helix 1, up the back left side -----------------------------------------
    h = torso_helix(0, tr)
    tr.bridge(h[0], 'left_hip', preferred=BACK, min_segments=2)
    tr.add(h, 'torso_helix_1')

    # --- the left arm from the top loop 1-2, helix 2 down the front left ---------------
    # The out strand leaves nearer helix 1, the strand back returns nearer helix 2, which
    # stands further forward: the paddle reaches out from the front of the shoulder.
    arm(-1, z_out=2.0, z_back=2.0 + STRAND_SEP)
    h = torso_helix(1, tr); tr.bridge(h[0], 'left_shoulder', preferred=FWD, min_segments=2); tr.add(h, 'torso_helix_2')   # this loop bows down, the other up, so they pass clear of each other

    # --- helices 3 and 4 round the front, a plain top loop between them ----------------
    h = torso_helix(2, tr); tr.bridge(h[0], 'torso_loop', preferred=UP, min_segments=3); tr.add(h, 'torso_helix_3')
    h = torso_helix(3, tr); tr.bridge(h[0], 'torso_loop', preferred=DOWN, min_segments=3); tr.add(h, 'torso_helix_4')

    # --- helix 5 up the front right, the right arm, helix 6 down the back right side ----
    h = torso_helix(4, tr); tr.bridge(h[0], 'torso_loop', preferred=UP, min_segments=3); tr.add(h, 'torso_helix_5')
    arm(+1, z_out=2.0 + STRAND_SEP, z_back=2.0)
    h = torso_helix(5, tr); tr.bridge(h[0], 'right_shoulder', preferred=FWD, min_segments=2); tr.add(h, 'torso_helix_6')

    # --- the crossover: under the back of the bundle to helix 7, up the back left -------
    # It bows in under the hollow of the bundle, and a little down, clear of the legs.
    h = torso_helix(6, tr)
    outward = unit(np.array([h[0][0] + tr.last[0], 0.0, h[0][2] + tr.last[2]]))
    tr.bridge(h[0], 'torso_crossover', preferred=outward + 0.3 * UP, min_segments=6)
    tr.add(h, 'torso_helix_7')

    # --- head: a small beta barrel on the top loop between helices 7 and 8, at the back
    # Strands around a vertical axis, the first next to the last so the barrel closes,
    # meandering up and down; the seam faces the necks, at the back.
    strands = []
    for k in range(HEAD_STRANDS):
        base = np.deg2rad(TORSO_ANGLES[6] - 360.0 * k / HEAD_STRANDS)
        st = barrel_strand(HEAD_CENTER, HEAD_RADIUS, base, HEAD_TWIST, HEAD_STRAND, phase=HEAD_PHASE)
        strands.append(st if k % 2 == 0 else st[::-1])
    tr.bridge(strands[0][0], 'neck', preferred=FWD, min_segments=3)   # bowing back, away from the bundle
    for k, st in enumerate(strands):
        if k:
            top = st[0][1] > HEAD_CENTER[1]
            tr.bridge(st[0], 'head_turn', preferred=DOWN if top else UP, min_segments=2)
        tr.add(st, f'head_strand_{k + 1}')
    h = torso_helix(7, tr)
    tr.bridge(h[0], 'neck', preferred=FWD, min_segments=3)
    neck = [i for i, l in enumerate(tr.labels) if l == 'neck']
    # The head rocks about a point under its middle at the height of the neck, so a nod
    # keeps it on top of the neck rather than swinging it down into the shoulders.
    pivots['neck'] = [HEAD_CENTER[0], float(np.mean([tr.points[i][1] for i in neck])), HEAD_CENTER[2]]
    tr.add(h, 'torso_helix_8')

    # --- right leg, hip to toe: the C-terminus ----------------------------------------
    leg = choose_phase(tr.last, [LEG_X, HIP_Y, LEG_Z], DOWN, LEG_LEN, 5.5, avoid=tr.recent)
    tr.bridge(leg[0], 'right_hip', preferred=UP, min_segments=2)
    tr.add(leg, 'right_leg_helix')
    foot = choose_phase(tr.last, [LEG_X, FOOT_Y, FOOT_Z0], FWD, FOOT_LEN, 5.5, ref=UP, avoid=tr.recent)
    tr.bridge(foot[0], 'right_ankle', preferred=[-1.0, 0.0, 1.0], min_segments=2)
    tr.add(foot, 'right_foot_helix')
    leg_pivots(+1)

    ca = np.asarray(tr.points)
    labels = list(tr.labels)

    # The arm turns about its two root residues (the loop residues bonded to its strands),
    # so the shoulder loops keep their length however it swings.
    for s_, name in (('l', 'left'), ('r', 'right')):
        roots = [i for i, l in enumerate(labels) if l == f'{name}_arm_root']
        sh = ca[roots].mean(axis=0)
        pivots[f'{s_}arm_shoulder'] = sh.tolist()
        pivots[f'{s_}arm_elbow'] = (sh + ARM_ELBOW * (np.asarray(pivots[f'{s_}arm_hand']) - sh)).tolist()

    # --- rigid domains ----------------------------------------------------------------
    # Every residue of a domain moves as one piece; residues in no domain (the joints:
    # hips, knees, ankles, shoulders, neck) are hinges the rig relaxes.
    idx = lambda pred: [i for i, l in enumerate(labels) if pred(l)]
    domains = {
        'torso': idx(lambda l: l.startswith('torso_')),
        'larm': idx(lambda l: l.startswith('left_arm_') or l == 'left_hand_turn'),     # strands, hand turn and the two root residues
        'rarm': idx(lambda l: l.startswith('right_arm_') or l == 'right_hand_turn'),
        'head': idx(lambda l: l.startswith('head_')),
    }
    for side, name in (('l', 'left'), ('r', 'right')):
        by_height = sorted(idx(lambda l: l == f'{name}_leg_helix'), key=lambda i: -ca[i][1])   # hip end first
        domains[f'{side}leg_thigh'] = sorted(by_height[:KNEE])
        domains[f'{side}leg_shin'] = sorted(by_height[KNEE + 1:])   # the knee residue is the hinge
        domains[f'{side}leg_foot'] = idx(lambda l: l == f'{name}_foot_helix')
    return ca, labels, pivots, domains


# -------------------------------------------------------------------------- output
def runs(labels):
    out, start = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[start]:
            out.append({'start': start + 1, 'end': i, 'class': labels[start]})
            start = i
    return out


def check(ca, labels):
    steps = np.linalg.norm(np.diff(ca, axis=0), axis=1)
    d = np.linalg.norm(ca[:, None] - ca[None], axis=2)
    n = len(ca)
    far = np.abs(np.arange(n)[:, None] - np.arange(n)[None]) >= 3
    close = sorted(((d[i, j], i + 1, j + 1) for i, j in zip(*np.where(far & (d < 3.2))) if i < j))
    print(f'{n} residues; CA step {steps.min():.4f}-{steps.max():.4f} A; '
          f'nearest non-neighbour CAs {d[far].min():.2f} A; {len(close)} pairs under 3.2 A')
    for dd, i, j in close[:10]:
        print(f'  {dd:.2f} A  {i} {labels[i - 1]}  -  {j} {labels[j - 1]}')
    return len(close) == 0


def write(ca, labels, pivots, domains, js_path, pdb_path):
    data = {
        'n_ca': len(ca),
        'ca_res': list(range(1, len(ca) + 1)),
        'ca_xyz': [[round(float(v), 3) for v in p] for p in ca],
        'pivots': {k: [round(float(v), 4) for v in p] for k, p in pivots.items()},
        'domain_indices': domains,
        'arm_hinge': ARM_HINGE,
        'segments': runs(labels),
    }
    js = ('// The helical fighter: C-alpha scaffold, joint pivots and rigid domains.\n'
          '// Generated by scripts/build_helix_fighter.py - edit that, not this.\n'
          f'const HELIX_FIGHTER_RIG = {json.dumps(data, separators=(",", ":"))};\n'
          'if (typeof module !== "undefined") module.exports = { HELIX_FIGHTER_RIG };\n'
          'if (typeof window !== "undefined") window.HELIX_FIGHTER_RIG = HELIX_FIGHTER_RIG;\n')
    Path(js_path).write_text(js)
    lines = ['REMARK 950 HELICAL FIGHTER: SIX-HELIX BUNDLE, HAIRPIN ARMS, HELIX LEGS, BARREL HEAD',
             'REMARK 950 C-ALPHA TRACE, ONE CHAIN; B-FACTOR 20 STRAND, 40 HELIX, 65 LOOP']
    for i, (p, l) in enumerate(zip(ca, labels)):
        b = 20.0 if 'strand' in l else 40.0 if 'helix' in l else 65.0
        lines.append(f'ATOM  {i + 1:5d}  CA  ALA A{i + 1:4d}    {p[0]:8.3f}{p[1]:8.3f}{p[2]:8.3f}  1.00{b:6.2f}           C')
    lines += ['TER', 'END']
    Path(pdb_path).write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    ca, labels, pivots, domains = build()
    ok = check(ca, labels)
    for seg in runs(labels):
        print(f'  {seg["start"]:4d}-{seg["end"]:4d}  {seg["class"]}')
    print('domains:', {k: len(v) for k, v in domains.items()})
    write(ca, labels, pivots, domains, ROOT / 'rig_data_helix.js', ROOT / 'scripts' / 'helix_fighter.pdb')
    print('wrote rig_data_helix.js and scripts/helix_fighter.pdb', '' if ok else '(with clashes to fix)')

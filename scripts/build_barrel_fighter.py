#!/usr/bin/env python3
"""Build the barrel humanoid (P1) and its rig: rig_data.js.

A port of ../dance/build_clean_humanoid.py (humanoid v8), self-contained here so the
character can be edited alongside the helical fighter: the same geometry, then the
joint pivots and rigid domains the game needs, written straight to rig_data.js.

  torso  an idealised 14-strand beta barrel, strongly twisted, traversed 2, 3, ... 8
         then, after a crossover loop under the belly, 1, 14, 13, ... 9
  arms   straight alpha helices at the chain ends, in a T-pose
  legs   two loop insertions on the front face: each a paired antiparallel beta sheet
         straight down, a paired knee, a bend at the ankle and a compact toe turn
  head   a four-helix bundle on the top loop at the back, on two-residue necks

World units are Angstrom: x runs left (-) to right (+), y up, z forward; the barrel is
centred on the origin and every CA-CA bond is exactly CA_STEP.

    python3 scripts/build_barrel_fighter.py
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_helix_fighter import CA_STEP, Trace, exact_bridge, perpendicular, unit, runs   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# -------------------------------------------------------------------------- design
N_STRANDS, STRAND_LENGTH, SHEET_SPACING = 14, 10, 4.80
BARREL_RADIUS = SHEET_SPACING / (2.0 * np.sin(np.pi / N_STRANDS))
BARREL_TWIST_DEG, BARREL_PLEAT = 36.0, 0.70
# Pleat phases (0 or 1): which residues pleat out. They decide which strand pairs py2Dmol
# sees as hydrogen-bonded, and so whether the residues flanking each loop read as strand.
BARREL_PHASE, LEG_PHASE, CAP_SEGMENTS = 0, 0, 3   # scanned: leg phase 0 reads as strand on every rung, cap loops shorter than 3 steps lose strand
# Physical strands 0..13 around the barrel, in chain order: round one way to strand 8,
# under the belly to strand 1, and back round the other way.
BARREL_ORDER = (1, 2, 3, 4, 5, 6, 7, 0, 13, 12, 11, 10, 9, 8)
LEFT_LEG_EDGE, RIGHT_LEG_EDGE, CROSSOVER_EDGE, HEAD_EDGE = (1, 2), (5, 6), (7, 0), (4, 5)
ARM_RESIDUES = 34                     # 49.5 A reach
HEAD_RAISE = 2.0                      # the head bundle sits this much higher than in humanoid v8
FOOT_RUNGS, FOOT_REGISTER = 3, 0          # rungs of foot past the ankle; 1 pleats the foot's rails opposite
LEG_PLEAT, ANKLE_BEND_RUNGS = 0.70, 3       # the sheet's pleat, and how many rungs the ankle's right-angle bend is spread over: three keeps a visible corner and the H-bond ladder
HEAD_HELIX, HEAD_BASE_Y = 12, 22.0    # residues per helix of the bundle (v8 had 8: a turn more here), and where its bottom sat in v8


# ----------------------------------------------------------------------- geometry
def alpha_helix(start, direction, count, phase=0.0, preferred=(0.0, 0.0, 1.0)):
    """Right-handed ideal alpha-helix CA trace whose first residue is at `start`."""
    direction = unit(direction)
    radial = perpendicular(direction, preferred)
    tangent = unit(np.cross(direction, radial))
    rise, twist = 1.50, np.deg2rad(100.0)
    radius = np.sqrt(CA_STEP ** 2 - rise ** 2) / (2.0 * np.sin(twist / 2.0))
    start = np.asarray(start, float)
    axis_start = start - radius * (np.cos(phase) * radial + np.sin(phase) * tangent)
    return np.asarray([axis_start + i * rise * direction + radius * (np.cos(phase + i * twist) * radial + np.sin(phase + i * twist) * tangent)
                       for i in range(count)])


def barrel_strand(physical_index):
    """Strand `physical_index` of the barrel, top to bottom: on a ring about the y axis,
    sweeping BARREL_TWIST_DEG around it, pleating radially, with exact CA steps. The
    base angle is chosen so that the two leg edges mirror each other in x exactly."""
    phi_0 = np.pi - np.deg2rad(BARREL_TWIST_DEG)
    base_theta = phi_0 + 2.0 * np.pi * physical_index / N_STRANDS
    horizontal = []
    for index in range(STRAND_LENGTH):
        theta = base_theta + np.deg2rad(BARREL_TWIST_DEG * index / (STRAND_LENGTH - 1))
        radial = np.array([np.cos(theta), 0.0, np.sin(theta)])
        pleat = BARREL_PLEAT if (index + BARREL_PHASE) % 2 == 0 else -BARREL_PLEAT
        horizontal.append((BARREL_RADIUS + pleat) * radial)
    vertical = [0.0]
    for first, second in zip(horizontal[:-1], horizontal[1:]):
        vertical.append(vertical[-1] - np.sqrt(CA_STEP ** 2 - np.linalg.norm(second - first) ** 2))
    vertical = np.asarray(vertical) - 0.5 * (vertical[0] + vertical[-1])
    return np.asarray([point + y * np.array([0.0, 1.0, 0.0]) for point, y in zip(horizontal, vertical)])


def flat_leg(anchor_a, anchor_b, side):
    """A leg as a paired antiparallel beta sheet hanging between two barrel anchors: one
    curved sheet of rungs 1..21 down the out rail (knee at 9), bending forward through
    the ankle (rung 18) into the foot, a toe turn, and the return rail back up. The bend
    is spread over ANKLE_BEND_RUNGS so the hydrogen-bond ladder runs on through it and
    the foot reads as sheet with the shin. Returns points, labels and each point's rung."""
    name = 'left' if side < 0 else 'right'
    knee, ankle = 9, 18
    count = ankle + FOOT_RUNGS
    down, across, forward = np.array([0.0, -1.0, 0.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])
    start = np.asarray(anchor_b, float) - np.asarray(anchor_a, float)
    radius = np.linalg.norm(start) / 2.0
    center = 0.5 * (np.asarray(anchor_a, float) + np.asarray(anchor_b, float))
    # The sheet's centreline: straight down, then turning to forward through the ankle.
    def heading(i):
        u = min(max((i - (ankle - ANKLE_BEND_RUNGS / 2.0)) / ANKLE_BEND_RUNGS, 0.0), 1.0)
        phi = 0.5 * np.pi * u
        return np.cos(phi) * down + np.sin(phi) * forward
    rails = []
    for s in (-1.0, 1.0):
        pts = [center + s * start / 2.0]
        offset_old = s * start / 2.0
        c = center.copy()
        for i in range(1, count + 1):
            d = heading(i)
            normal = unit(np.cross(d, across))          # the pleat is normal to the local sheet
            t = min(i / 4.0, 1.0)                         # the rails settle from the anchors' line to straight across
            direction = unit((1.0 - t) * unit(start) + t * across)
            pleat = LEG_PLEAT if ((i + LEG_PHASE) % 2 == 0) else -LEG_PLEAT
            if s > 0 and FOOT_REGISTER and i > ankle:
                pleat = -pleat
            offset = s * radius * direction + pleat * normal
            delta = offset - offset_old
            along = delta @ d
            travel = -along + np.sqrt(CA_STEP ** 2 - delta @ delta + along ** 2)
            c = c + travel * d
            pts.append(c + offset)
            offset_old = offset
        rails.append(pts)
    # A two-residue hairpin at the toe, then exact CA steps along the whole leg.
    last_0, last_1 = rails[0][-1], rails[1][-1]
    ahead = heading(count)
    t1 = last_0 + 0.3 * (last_1 - last_0) + 1.1 * np.array([0.0, 1.0, 0.0]) + 2.7 * ahead
    t2 = last_1 - 0.3 * (last_1 - last_0) + 0.8 * np.array([0.0, 1.0, 0.0]) + 2.6 * ahead
    turn_pts = [last_0.copy(), t1, t2, last_1.copy()]
    for _ in range(50):
        d01 = np.linalg.norm(turn_pts[1] - turn_pts[0])
        turn_pts[1] -= (d01 - CA_STEP) * (turn_pts[1] - turn_pts[0]) / d01
        d12 = np.linalg.norm(turn_pts[2] - turn_pts[1])
        corr = 0.5 * (d12 - CA_STEP) * (turn_pts[2] - turn_pts[1]) / d12
        turn_pts[1] += corr
        turn_pts[2] -= corr
        d23 = np.linalg.norm(turn_pts[3] - turn_pts[2])
        turn_pts[2] -= (d23 - CA_STEP) * (turn_pts[2] - turn_pts[3]) / d23
    all_pts = np.vstack([rails[0][1:], turn_pts[1:-1], rails[1][:0:-1]])
    for _ in range(100):
        for i in range(len(all_pts) - 1):
            d = np.linalg.norm(all_pts[i + 1] - all_pts[i])
            corr = 0.5 * (d - CA_STEP) * (all_pts[i + 1] - all_pts[i]) / d
            all_pts[i] += corr
            all_pts[i + 1] -= corr
    labels, rungs = [], []
    for i in range(1, count + 1):
        suffix = '_knee' if i == knee else '_foot' if i > ankle else ''
        labels.append(f'{name}_leg_beta_out{suffix}'); rungs.append(i)
    labels += [f'{name}_leg_beta_turn', f'{name}_leg_beta_turn']; rungs += [0, 0]
    for i in range(count, 0, -1):
        suffix = '_knee' if i == knee else '_foot' if i > ankle else ''
        labels.append(f'{name}_leg_beta_return{suffix}'); rungs.append(i)
    return all_pts, labels, rungs


def head_domain(anchor_a, anchor_b):
    """A tight four-helix bundle cranium on two-residue necks: vertical helices on an
    8 x 8 A square, centred above the barrel, HEAD_RAISE above where v8 had it."""
    def canonical_helix(axis_origin, direction, count, phase=0.0, ref=(1.0, 0.0, 0.0)):
        direction = unit(direction)
        radial = perpendicular(direction, ref)
        tangent = unit(np.cross(direction, radial))
        rise, twist = 1.50, np.deg2rad(100.0)
        radius = np.sqrt(CA_STEP ** 2 - rise ** 2) / (2.0 * np.sin(twist / 2.0))
        return np.asarray([axis_origin + i * rise * direction + radius * (np.cos(phase + i * twist) * radial + np.sin(phase + i * twist) * tangent)
                           for i in range(count)])
    dx, dz, z0 = 4.0, 4.0, -2.0
    y_bot = HEAD_BASE_Y + HEAD_RAISE
    y_top = y_bot + (HEAD_HELIX - 1) * 1.50
    h1 = canonical_helix(np.array([-dx, y_bot, z0 - dz]), [0, 1, 0], HEAD_HELIX)
    h2 = canonical_helix(np.array([-dx, y_top, z0 + dz]), [0, -1, 0], HEAD_HELIX)
    h3 = canonical_helix(np.array([+dx, y_bot, z0 + dz]), [0, 1, 0], HEAD_HELIX)
    h4 = canonical_helix(np.array([+dx, y_top, z0 - dz]), [0, -1, 0], HEAD_HELIX)
    t1 = exact_bridge(h1[-1], h2[0], preferred=[0, -1, 0], min_segments=3)
    t2 = exact_bridge(h2[-1], h3[0], preferred=[0, 0, -1], min_segments=3)
    t3 = exact_bridge(h3[-1], h4[0], preferred=[0, -1, 0], min_segments=3)
    neck_in = exact_bridge(anchor_a, h1[0], preferred=[0, 0, 1], min_segments=3)
    neck_out = exact_bridge(h4[-1], anchor_b, preferred=[0, 0, 1], min_segments=3)
    pts = np.vstack([neck_in[1:-1], h1, t1[1:-1], h2, t2[1:-1], h3, t3[1:-1], h4, neck_out[1:-1]])
    labels = (['neck_hinge'] * len(neck_in[1:-1]) + ['head_helix_1'] * len(h1) + ['head_turn_1'] * len(t1[1:-1])
              + ['head_helix_2'] * len(h2) + ['head_turn_2'] * len(t2[1:-1]) + ['head_helix_3'] * len(h3)
              + ['head_turn_3'] * len(t3[1:-1]) + ['head_helix_4'] * len(h4) + ['neck_hinge'] * len(neck_out[1:-1]))
    return pts, labels


# --------------------------------------------------------------------------- build
def build():
    strands = {index: barrel_strand(index) for index in range(N_STRANDS)}
    tr = Trace()
    rungs = []   # per residue: the leg rung it belongs to, 0 otherwise
    anchors = {}

    # Left arm: from the hand in to the shoulder, an unbroken helix along x.
    left_shoulder = strands[BARREL_ORDER[0]][0] + np.array([-CA_STEP, 0.0, 0.0])
    left_arm = alpha_helix(np.zeros(3), [1.0, 0.0, 0.0], ARM_RESIDUES, phase=0.0)
    left_arm += left_shoulder - left_arm[-1]
    tr.add(left_arm, 'left_arm_helix'); rungs += [0] * len(left_arm)

    front_left_leg = None
    for sequence_index, physical_index in enumerate(BARREL_ORDER):
        strand = strands[physical_index]
        if sequence_index % 2:
            strand = strand[::-1]
        tr.add(strand, f'beta_strand_{physical_index + 1:02d}'); rungs += [0] * len(strand)
        if sequence_index == len(BARREL_ORDER) - 1:
            break
        next_physical = BARREL_ORDER[sequence_index + 1]
        next_strand = strands[next_physical]
        if (sequence_index + 1) % 2:
            next_strand = next_strand[::-1]
        anchor_a, anchor_b = strand[-1], next_strand[0]
        edge = (physical_index, next_physical)
        if edge == LEFT_LEG_EDGE:
            points, labels, leg_rungs = flat_leg(anchor_a, anchor_b, -1.0)
            front_left_leg = (points, labels, leg_rungs, 0.5 * (anchor_a + anchor_b))
            anchors['lleg'] = (anchor_a, anchor_b)
            tr.add(points, labels); rungs += leg_rungs
        elif edge == RIGHT_LEG_EDGE:
            source, source_labels, source_rungs, left_mid = front_left_leg
            right_mid = 0.5 * (anchor_a + anchor_b)
            reflected = source.copy()
            reflected[:, 0] = -reflected[:, 0]   # the exact mirror of the left leg across x = 0
            reflected[:, 1] += right_mid[1] - left_mid[1]
            reflected[:, 2] += right_mid[2] - left_mid[2]
            anchors['rleg'] = (anchor_a, anchor_b)
            tr.add(reflected[::-1], [l.replace('left_', 'right_') for l in source_labels[::-1]]); rungs += source_rungs[::-1]
        elif edge == CROSSOVER_EDGE:
            crossover = exact_bridge(anchor_a, anchor_b, preferred=(0.0, 1.0, 0.0), min_segments=7)
            tr.add(crossover[1:-1], 'bottom_crossover_loop'); rungs += [0] * (len(crossover) - 2)
        elif edge == HEAD_EDGE:
            head_pts, head_labels = head_domain(anchor_a, anchor_b)
            tr.add(head_pts, head_labels); rungs += [0] * len(head_pts)
        else:
            cap = (0.0, 1.0, 0.0) if anchor_a[1] > 0 else (0.0, -1.0, 0.0)
            bridge = exact_bridge(anchor_a, anchor_b, -np.asarray(cap), min_segments=CAP_SEGMENTS)
            if len(bridge) > 2:
                tr.add(bridge[1:-1], 'barrel_cap_loop'); rungs += [0] * (len(bridge) - 2)

    right_shoulder = strands[BARREL_ORDER[-1]][0] + np.array([CA_STEP, 0.0, 0.0])
    tr.add(alpha_helix(right_shoulder, [1.0, 0.0, 0.0], ARM_RESIDUES, phase=0.0), 'right_arm_helix'); rungs += [0] * ARM_RESIDUES

    ca = np.asarray(tr.points)
    labels = list(tr.labels)

    # --- rigid domains and pivots ------------------------------------------------------
    idx = lambda pred: [i for i, l in enumerate(labels) if pred(l)]
    domains = {
        'larm': idx(lambda l: l == 'left_arm_helix'),
        'rarm': idx(lambda l: l == 'right_arm_helix'),
        'head': idx(lambda l: l.startswith('head_')),
        'torso': idx(lambda l: l.startswith('beta_strand_') or l in ('barrel_cap_loop', 'bottom_crossover_loop')),
    }
    pivots = {
        'larm_shoulder': ca[domains['larm'][-1]].tolist(), 'larm_hand': ca[domains['larm'][0]].tolist(),
        'rarm_shoulder': ca[domains['rarm'][0]].tolist(), 'rarm_hand': ca[domains['rarm'][-1]].tolist(),
    }
    for s, name in (('l', 'left'), ('r', 'right')):
        leg = idx(lambda l: l.startswith(f'{name}_leg_'))
        rung_of = lambda i: rungs[i]
        # Rung 9 is the knee and rung 18 the ankle; the hip hinge is the bond from the barrel
        # to rung 1, which moves with the thigh so rung 2 keeps its pairing.
        domains[f'{s}leg_thigh'] = [i for i in leg if 1 <= rung_of(i) <= 8]
        domains[f'{s}leg_shin'] = [i for i in leg if 10 <= rung_of(i) <= 17]
        domains[f'{s}leg_foot'] = [i for i in leg if rung_of(i) >= 19 or labels[i].endswith('_turn')]
        mean_of = lambda pred: np.mean([ca[i] for i in leg if pred(i)], axis=0).tolist()
        a, b = anchors[f'{s}leg']
        pivots[f'{s}leg_hip'] = (0.5 * (a + b)).tolist()
        pivots[f'{s}leg_knee'] = mean_of(lambda i: rung_of(i) == 9)
        pivots[f'{s}leg_ankle'] = mean_of(lambda i: rung_of(i) == 18)
        pivots[f'{s}leg_toe'] = mean_of(lambda i: labels[i].endswith('_turn'))
    neck = idx(lambda l: l == 'neck_hinge')
    pivots['head_cranium'] = np.mean(ca[domains['head']], axis=0).tolist()
    # The head rocks about a point under its middle at the height of the neck.
    pivots['head_neck'] = pivots['neck'] = [pivots['head_cranium'][0], float(np.mean(ca[neck][:, 1])), pivots['head_cranium'][2]]
    return ca, labels, pivots, domains


def write(ca, labels, pivots, domains, js_path, pdb_path):
    data = {
        'n_ca': len(ca),
        'ca_res': list(range(1, len(ca) + 1)),
        'ca_xyz': [[round(float(v), 3) for v in p] for p in ca],
        'pivots': {k: [round(float(v), 4) for v in p] for k, p in pivots.items()},
        'domain_indices': domains,
    }
    js = ('// The barrel humanoid (humanoid v8): C-alpha scaffold, joint pivots and rigid domains.\n'
          '// Generated by scripts/build_barrel_fighter.py - edit that, not this.\n'
          f'const HUMANOID_V8_RIG = {json.dumps(data, separators=(",", ":"))};\n'
          'if (typeof module !== "undefined") module.exports = { HUMANOID_V8_RIG };\n'
          'if (typeof window !== "undefined") window.HUMANOID_V8_RIG = HUMANOID_V8_RIG;\n'
          'if (typeof globalThis !== "undefined") globalThis.HUMANOID_V8_RIG = HUMANOID_V8_RIG;\n')
    Path(js_path).write_text(js)
    lines = ['REMARK 950 BARREL HUMANOID V8: 14-STRAND BETA BARREL, HELIX ARMS, SHEET LEGS, HELIX BUNDLE HEAD',
             'REMARK 950 C-ALPHA TRACE, ONE CHAIN; B-FACTOR 20 STRAND, 40 HELIX, 65 LOOP']
    for i, (p, l) in enumerate(zip(ca, labels)):
        b = 20.0 if 'beta' in l else 40.0 if 'helix' in l else 65.0
        lines.append(f'ATOM  {i + 1:5d}  CA  ALA A{i + 1:4d}    {p[0]:8.3f}{p[1]:8.3f}{p[2]:8.3f}  1.00{b:6.2f}           C')
    lines += ['TER', 'END']
    Path(pdb_path).write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    ca, labels, pivots, domains = build()
    steps = np.linalg.norm(np.diff(ca, axis=0), axis=1)
    print(f'{len(ca)} residues; CA step {steps.min():.4f}-{steps.max():.4f} A; head raised {HEAD_RAISE} A')
    print('domains:', {k: len(v) for k, v in domains.items()})
    write(ca, labels, pivots, domains, ROOT / 'rig_data.js', ROOT / 'scripts' / 'barrel_fighter.pdb')
    print('wrote rig_data.js and scripts/barrel_fighter.pdb')

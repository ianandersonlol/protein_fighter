# Protein Fighter

A two-player-vs-CPU fighting game where both fighters are proteins, drawn live by
[py2Dmol](https://github.com/sokrypton/py2Dmol). Every tick the game poses each
protein with a joint rig, writes the new C-alpha coordinates into one py2Dmol
scene, and py2Dmol works out the secondary structure and cartoon from them. Damage
unfolds residues near each impact: their helices and strands come apart on screen
because the geometry that defined them is gone.

The two fighters are different proteins, each other's inside out:

- **P1**, a 379-residue humanoid from `../dance`: a 14-strand β-barrel body, two
  α-helix arms at the chain ends, β-sheet legs with sheet feet, and a small four-helix
  bundle head
- **P2**, a 424-residue helical fighter: an eight-helix bundle body, two β-hairpin arms
  that grow out of the loops on the front helices, a single α-helix for each leg
  hanging from the back helices at the chain ends, finishing in a short helix foot,
  and a small eight-strand β-barrel head on the loop at the back

Both hang off the same joints (hips, knees, ankles, shoulders, elbows, neck) at the same
heights, so one set of moves drives both.

## Play

https://sokrypton.github.io/protein_fighter

## Run locally

No build step. Serve the folder and open it:

```
python3 -m http.server 8000
```

then http://localhost:8000. WebGL2 is required.

## Controls

Pick 1 player (against the CPU), 2 players on one keyboard, or REMOTE: a second device
joins over the network. REMOTE shows a QR code; scan it with a phone (or open the link
it encodes) and the fight starts, that device playing P2 with its on-screen keys or
keyboard. Both devices run the game: the guest's keys act on its own screen at once and
go to the host, and the host, whose judgement of every hit is final, sends a small
packet fifteen times a second (each fighter's state and the springs of its motion,
the HUD, the overlay, and any hits, callouts and sounds since the last one) that keeps
the guest in step. The connection is a WebRTC data channel set up through PeerJS's
public signaling server, direct where it can be and through PeerJS's relays where it
can't, so both devices need internet even on one Wi-Fi; the page loads PeerJS and a QR
library from unpkg. A status line under the switches shows the packet rate and the
link's state on both sides. A TURN server of your own can be given as
`?turn=turn:host:port&tu=user&tp=password` before pressing REMOTE; the join link carries
it to the guest. A connection that fails says what the browser saw.

| | P1 (left hand) | P2 (right hand) |
| --- | --- | --- |
| move | W A S D | ↑ ← ↓ → |
| punch | F | . (or numpad 1) |
| kick | G | / (or numpad 2) |

Playing the CPU, both sets drive P1, and J / K punch and kick as well.

- Walk left and right
- Jump: tap for a short hop, hold for a full jump that clears the other fighter; add a
  direction to jump forward or back
- Crouch
- Block: hold back, away from the other fighter, and a blow is taken on the guard: no
  unfolding, a shove back and a short brace. A low attack gets under a standing guard, so
  block it crouching; an attack from the air comes over a crouching guard, so block it
  standing. The CPU braces now and then too
- Throw: forward and punch with the two torsos touching. It can't be blocked: the other
  is lifted over your head and flung, tumbling, and the damage lands when it does
- Heat shock: punch and kick together. A wave runs out along the membrane from your
  hands, flinging ligands, and unfolds what it reaches; it runs low, so it is blocked
  crouching. Once every four seconds
- Hits in a row while the other is still reeling count up as a combo, each with its
  damage; the CPU on HARD blocks most of what it sees coming, hits back while you are
  recovering, kicks you out of the air and throws you up close, so a strike thrown over
  and over is a bad idea. EASY and NORMAL are gentler
- Under the title screen each player picks BARREL or BUNDLE, and a guest picks its own
- Punch and kick change with what you are doing. Crouching they become low attacks,
  which unfold only the legs. In the air they hit from above. Pressing jump and an
  attack together gives the air attack, whichever lands first
- Left alone for two seconds, a protein slowly refolds
- Reading the colours: each protein is coloured by pLDDT, AlphaFold's per-residue
  confidence (dark blue confident, orange disordered). The map under each health bar is
  a PAE plot, computed as AlphaFold defines aligned error: each row lines the protein up
  on one residue (its frame from that alpha carbon and its two neighbours), and each
  column is how far another residue then sits from where it was at the start of the
  round, dark green at 0 Å to white at 30 Å. A limb that swings lights up against the
  body. A stretch that unfolds goes white along its rows but not its columns: lined up on
  a disordered residue, nothing else can be placed, while the folded body still places
  the loose chain roughly where it hangs. It updates live
- Damage is local. Unfolded legs walk, run and jump slower and kick weaker, but still
  work; unfolded arms punch weaker. A protein whose legs are gone can still fight with
  its upper body, and only a protein unfolded all over is knocked out
- Esc pause

Damage is shown in AlphaFold pLDDT colours: dark blue is intact, orange is
unfolded. Unfolded residues are a chain under gravity, and the more a protein has
unfolded, the harder each blow throws that chain around. A knocked-out protein falls
apart on the floor, and the next round it pulls itself back together. CA–CA bonds are
held at 3.8 Å throughout.

Music and effects are synthesised in the browser with WebAudio; SOUND ON/OFF toggles both.

The switches under the timer pick a dark or light theme and how the proteins are
coloured: by pLDDT (damage), as a rainbow along the chain, blue at the N-terminus to
red at the C-terminus, which shows how each protein is threaded, or by secondary
structure. Both choices are remembered. Clicking a PAE map lights the two stretches of
residues that pixel scores on the body. The camera follows the fight, closing in when the fighters are close and
pulling back as they part, so the game fits a phone as well as a monitor; on a
touchscreen the on-screen keys are the controls.

## Files

- `index.html` — page, HUD, styles
- `game.js` — combat, CPU, damage and unfolding, the body physics, PAE, sound, and the
  py2Dmol scene
- `net.js` — remote play: the PeerJS connection and the QR code; the state packets and
  the guest's drawing are in `game.js`
- `motion.js` — how a fighter moves, in one pass: pose on springs, hips, planted feet that
  step, two-bone leg IK, then the rig; the arms, head and shins swing on their own
  springs, and a blow jolts them
- `rig.js` — forward kinematics for either protein: rigid domains on joints, arms
  hinged at the elbow, hinge loops relaxed (from `../dance`)
- `rig_data.js` — the humanoid's C-alpha scaffold, joint pivots and rigid domains,
  generated by `scripts/build_barrel_fighter.py`, a self-contained port of humanoid v8
  from `../dance` (it also writes `scripts/barrel_fighter.pdb`)
- `rig_data_helix.js` — the same for the helical fighter, generated by
  `scripts/build_helix_fighter.py` (and `scripts/helix_fighter.pdb`). Rerun a builder
  after changing its design
- `tests/rig_pose.js`, `tests/secondary_structure.js` — run with `node`: the first
  poses both rigs through the game's motion and checks every CA–CA bond and rigid
  domain holds; the second runs py2Dmol's own secondary-structure assignment over each
  scaffold and checks that helices read as helix and sheets as strand
- `tests/play.js` — plays the game in headless Chrome: a fight against the CPU with a
  walk, a block, strikes, a heat shock, a throw and a PAE click, checking each registered
  and nothing threw; `--remote` runs a host and a guest in two browsers over PeerJS. A
  minute or two, since the browser draws with software OpenGL
- `cell.js` — the cell behind the fight and the effects over it: membrane, vesicles, a
  mitochondrion, ribosomes, microtubules, shadows, sparks, ligands, footfall ripples,
  all drawn to the game's camera

The walk in `game.js` is learned from `../dance/humanoid_v8_walk.pdb` (CMU mocap 07_01
retargeted onto this rig): each thigh and shin's pitch over a stride, reduced to three
harmonics and driven by distance walked so the feet don't skate.
- `vendor/py2Dmol.embed.min.js` — py2Dmol's embed bundle, byte-identical to the build in
  `../py2Dmol/py2Dmol/resources/bundles/` at its commit `d856487`. It carries the change
  that lets `replaceFrame` animate without rebuilding the cartoon mesh (the camera and
  extent are held across same-size frames, and the mesh is updated in place: the
  "station" draw the game switches on), and the fix for ribbon loops flickering as they
  move (each quad split along its shorter diagonal)

To update py2Dmol, copy a newer `py2Dmol.embed.min.js` over the vendored one.

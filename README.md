# Protein Fighter

A two-player-vs-CPU fighting game where both fighters are 362-residue proteins,
drawn live by [py2Dmol](https://github.com/sokrypton/py2Dmol). Every tick the
game poses each protein with a joint rig, writes the new C-alpha coordinates into
one py2Dmol scene, and py2Dmol works out the secondary structure and cartoon
from them. Damage unfolds residues near each impact: their helices and strands
come apart on screen because the geometry that defined them is gone.

## Play

https://sokrypton.github.io/protein_fighter

## Run locally

No build step. Serve the folder and open it:

```
python3 -m http.server 8000
```

then http://localhost:8000. WebGL2 is required.

## Controls

Pick 1 player (against the CPU) or 2 players on one keyboard.

| | P1 (left hand) | P2 (right hand) |
| --- | --- | --- |
| move | W A S D | ↑ ← ↓ → |
| punch | F | . (or numpad 1) |
| kick | G | / (or numpad 2) |

Playing the CPU, both sets drive P1, and J / K punch and kick as well.

- Walk left and right, double-tap to run; hold away from your opponent to block
- Jump: tap for a short hop, hold for a full jump that clears the other fighter; add a
  direction to jump forward or back
- Crouch; crouch and hold back to block low attacks
- Punch and kick change with what you are doing. Crouching they become low attacks,
  which unfold only the legs and must be blocked crouching. In the air they hit from
  above and must be blocked standing. Pressing jump and an attack together gives
  the air attack, whichever lands first
- Left alone for two seconds, a protein slowly refolds
- Esc pause

Damage is shown in AlphaFold pLDDT colours: dark blue is intact, orange is
unfolded. Unfolded residues are a chain under gravity, so a knocked-out protein
falls apart onto the floor; CA–CA bonds are held at 3.8 Å throughout.

## Files

- `index.html` — page, HUD, styles
- `game.js` — combat, CPU, poses, unfolding, and the py2Dmol scene
- `rig.js` — forward kinematics for the humanoid protein (from `../dance`)
- `rig_data.js` — the humanoid v8 C-alpha scaffold and joint pivots (from `../dance`)

The walk in `game.js` is learned from `../dance/humanoid_v8_walk.pdb` (CMU mocap 07_01
retargeted onto this rig): each thigh and shin's pitch over a stride, reduced to three
harmonics and driven by distance walked so the feet don't skate.
- `vendor/py2Dmol.embed.min.js` — py2Dmol embed bundle, copied from
  `../py2Dmol/py2Dmol/resources/bundles/` at commit `8d5b700`

To update py2Dmol, copy a newer `py2Dmol.embed.min.js` over the vendored one.

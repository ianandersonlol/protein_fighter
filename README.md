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

Playing the CPU, both sets drive P1, and J / K punch and kick as well. Each round the CPU
squares up and blocks, but does not attack until you do.

- Walk left and right, double-tap to run; hold away from your opponent to block
- Jump: tap for a short hop, hold for a full jump that clears the other fighter; add a
  direction to jump forward or back
- Crouch; crouch and hold back to block low attacks
- Punch and kick change with what you are doing. Crouching they become low attacks,
  which unfold only the legs and must be blocked crouching. In the air they hit from
  above and must be blocked standing. Pressing jump and an attack together gives
  the air attack, whichever lands first
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

## Files

- `index.html` — page, HUD, styles
- `game.js` — combat, CPU, poses, unfolding, and the py2Dmol scene
- `rig.js` — forward kinematics for the humanoid protein (from `../dance`)
- `rig_data.js` — the humanoid v8 C-alpha scaffold and joint pivots (from `../dance`)

The walk in `game.js` is learned from `../dance/humanoid_v8_walk.pdb` (CMU mocap 07_01
retargeted onto this rig): each thigh and shin's pitch over a stride, reduced to three
harmonics and driven by distance walked so the feet don't skate.
- `vendor/py2Dmol.embed.min.js` — py2Dmol embed bundle, built from
  `../py2Dmol/py2Dmol/resources/bundles/` ahead of its commit `8d5b700`: it carries the
  change that lets `replaceFrame` animate without rebuilding the cartoon mesh (the camera
  and extent are held across same-size frames), and a fix for ribbon loops flickering
  light and dark as they move (each quad is split along its shorter diagonal); neither is
  committed there yet

To update py2Dmol, copy a newer `py2Dmol.embed.min.js` over the vendored one.

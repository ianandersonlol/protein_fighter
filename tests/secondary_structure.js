// What py2Dmol makes of each fighter's bind pose: its own secondary-structure assignment
// (a backbone predicted from the C-alpha trace, then hydrogen bonds) over the scaffold,
// so a design change that would stop an arm reading as helix or strand shows up here
// before it shows up on screen. Run with:  node tests/secondary_structure.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

// The bundle expects a browser; give it just enough of one to define its cartoon module.
const noop = () => {};
const el = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop, appendChild: noop, getContext: () => null, setAttribute: noop });
global.window = global;
global.document = { createElement: el, createElementNS: el, querySelector: () => null, querySelectorAll: () => [], body: el(), head: el(), documentElement: el(), addEventListener: noop, getElementById: () => null };
global.navigator = { userAgent: 'node', platform: 'node' };
global.localStorage = { getItem: () => null, setItem: noop };
global.requestAnimationFrame = noop; global.self = global; global.HTMLElement = class {}; global.ResizeObserver = class { observe() {} };
try { new Function(fs.readFileSync(path.join(ROOT, 'vendor/py2Dmol.embed.min.js'), 'utf8'))(); } catch (e) { /* the viewer itself needs a real page; the cartoon module is defined by then */ }
const cartoon = window.py2dmolCartoon;
if (!cartoon) { console.log('py2Dmol cartoon module not available'); process.exit(1); }

const RIGS = {
  barrel: require(path.join(ROOT, 'rig_data.js')).HUMANOID_V8_RIG,
  helix: require(path.join(ROOT, 'rig_data_helix.js')).HELIX_FIGHTER_RIG,
};
// What each rigid domain should mostly read as.
const EXPECT = {
  barrel: { torso: 'E', larm: 'H', rarm: 'H', lleg_thigh: 'E', lleg_shin: 'E', rleg_thigh: 'E', rleg_shin: 'E', head: 'H' },
  helix: { torso: 'H', larm: 'E', rarm: 'E', lleg_thigh: 'H', lleg_shin: 'H', lleg_foot: 'H', rleg_thigh: 'H', rleg_shin: 'H', rleg_foot: 'H', head: 'E' },
};
let failures = 0;
for (const [name, data] of Object.entries(RIGS)) {
  const ca = data.ca_xyz.map(p => ({ x: p[0], y: p[1], z: p[2] }));
  // The viewer's own call (assignSecondary: no ring closures here, so assignSecondaryOpen),
  // with what it passes: every position a protein residue named GLY (as game.js writes the
  // PDB) and one chain, so no link breaks. The hydrogen-bond cutoff and ladder settings
  // are its defaults.
  const types = new Array(ca.length).fill('P'), names = new Array(ca.length).fill('GLY'), links = new Int32Array(ca.length).fill(0);
  const sec = cartoon.assignSecondary(ca, ca.length, types, { names, rings: [], groups: null, links }).sec;
  const bare = cartoon.assignSecondaryOpen(ca, ca.length, null, {}).sec;
  if (sec.join('') !== bare.join('')) { failures++; console.log('  FAIL the viewer\'s call and the bare call disagree'); }
  console.log(`${name}:`);
  console.log(sec.join('').replace(/(.{80})/g, '  $1\n').replace(/\n$/, '').replace(/^(?!  )/, '  '));
  for (const [dom, want] of Object.entries(EXPECT[name])) {
    const idx = data.domain_indices[dom], have = idx.filter(i => sec[i] === want).length / idx.length;
    const ok = have >= 0.5;   // turns and loop ends count against it: a head is half turns
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${dom.padEnd(11)} ${Math.round(100 * have)}% ${want === 'H' ? 'helix' : 'strand'}`);
  }
}
console.log(failures ? `${failures} failure(s)` : 'ok');
process.exit(failures ? 1 : 0);

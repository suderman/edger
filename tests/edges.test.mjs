// Herdr app mod logic: node --test tests/edges.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { Edges, Forwards, Local, REPEAT_MS, forwardKeys, isEditor, keyHex, localLetter, parseKey, resizeWeights } from "../herdr-app/mods/edger/edges.js";

test("editors are found by foreground name or argv[0]", () => {
  assert.ok(isEditor({ foreground: { name: ".emacsclient-wr", argv: ["/nix/store/x/bin/emacsclient", "--tty"] } }));
  assert.ok(isEditor({ foreground: { name: "nvim", argv: ["nvim", "file"] } }));
  assert.ok(!isEditor({ foreground: { name: "zsh", argv: ["/bin/zsh"] }, argv: ["nvim"] }));
  assert.ok(isEditor({ argv: ["/usr/bin/vim"] }));
  assert.ok(!isEditor(undefined));
});

test("key commands name an op and the key to forward", () => {
  assert.deepEqual(parseKey("left"), { op: "left", key: "alt+h" });
  assert.deepEqual(parseKey("close:ctrl+alt+q"), { op: "close", key: "ctrl+alt+q" });
  assert.deepEqual(parseKey("resize-left"), { op: "resize-left", key: "alt+shift+h" });
  assert.equal(parseKey("sync:3"), null);
  assert.equal(parseKey("wake"), null);
});

test("shifted Alt keys reach legacy editors as ESC then the shifted letter", () => {
  const emacs = { foreground: { name: ".emacsclient-wr", argv: ["/bin/emacsclient", "-t"] } };
  const nvim = { foreground: { name: "nvim", argv: ["nvim"] } };
  assert.deepEqual(forwardKeys(emacs, "alt+shift+k"), ["esc", "shift+k"]);
  assert.deepEqual(forwardKeys(nvim, "alt+shift+k"), ["alt+shift+k"]);
  assert.deepEqual(forwardKeys(emacs, "alt+k"), ["alt+k"]);
  assert.deepEqual(forwardKeys(emacs, "ctrl+alt+shift+k"), ["ctrl+alt+shift+k"]);
});

test("keys become the bytes a legacy terminal sends", () => {
  assert.equal(keyHex("alt+h"), "1b68");
  assert.equal(keyHex("alt+shift+k"), "1b4b");
  assert.equal(keyHex("ctrl+alt+h"), "1b08");
  assert.equal(keyHex("alt+1"), "1b31");
  assert.equal(keyHex("ctrl+shift+h"), null);
  assert.equal(keyHex("alt+shift+1"), null);
  assert.equal(keyHex("alt+left"), null);
  assert.equal(keyHex("hyper+h"), null);
});

// Presses at the outer edge, as the mod makes them: every press is noted,
// and a confirming press creates only if confirm() later agrees.
function edge(e, dir, at) {
  e.pressed(dir, at);
  return e.edge(dir, "p1", at);
}

test("one press arms, a deliberate second press creates", () => {
  const e = new Edges();
  assert.equal(edge(e, "right", 1000), false);
  assert.equal(edge(e, "right", 1250), true);
  assert.equal(e.confirm("right", "p1", 1250), true);
});

test("presses too far apart, or toward the start, never create", () => {
  const e = new Edges();
  assert.equal(edge(e, "down", 1000), false);
  assert.equal(edge(e, "down", 1800), false);
  assert.equal(edge(e, "left", 3000), false);
  assert.equal(edge(e, "left", 3200), false);
  assert.equal(edge(e, "up", 5000), false);
  assert.equal(edge(e, "up", 5200), false);
});

test("a held key never creates, even after its repeat delay", () => {
  const e = new Edges();
  // Press, then the first auto-repeat 600 ms later, then every 40 ms.
  const times = [1000, 1600];
  for (let t = 1640; t <= 4000; t += 40) times.push(t);
  let created = 0;
  for (const t of times) {
    if (edge(e, "right", t)) {
      // The mod checks again REPEAT_MS later; the next repeat came first.
      e.pressed("right", t + 40);
      if (e.confirm("right", "p1", t)) created++;
      e.edge("right", "p1", t + 40);
    }
  }
  assert.equal(created, 0);
});

test("pressing again after a hold creates", () => {
  const e = new Edges();
  for (let t = 1000; t <= 2000; t += 40) edge(e, "right", t);
  assert.equal(edge(e, "right", 2300), true);
  assert.equal(e.confirm("right", "p1", 2300), true);
});

test("arriving at the edge by rapid travel does not arm", () => {
  const e = new Edges();
  e.pressed("right", 1000);
  e.traveled("right", 1000);
  assert.equal(edge(e, "right", 1150), false);
  assert.equal(edge(e, "right", 1300), false);
  // After a quiet period the usual double press works.
  assert.equal(edge(e, "right", 1900), false);
  assert.equal(edge(e, "right", 2100), true);
});

test("an armed press in another pane or direction starts over", () => {
  const e = new Edges();
  assert.equal(edge(e, "right", 1000), false);
  e.pressed("right", 1200);
  assert.equal(e.edge("right", "p2", 1200), false);
  assert.equal(edge(e, "down", 1400), false);
  assert.equal(edge(e, "right", 1600), false);
});

test("a fast third press cancels a pending creation", () => {
  const e = new Edges();
  edge(e, "right", 1000);
  assert.equal(edge(e, "right", 1200), true);
  e.pressed("right", 1200 + REPEAT_MS - 20);
  assert.equal(e.confirm("right", "p1", 1200), false);
});

test("an editor's label answers the forward it matches, once", () => {
  const f = new Forwards();
  f.add("t7", "right", 1000, "right:old");
  assert.equal(f.answer("t7", "right:old"), null);
  assert.deepEqual(f.answer("t7", "right:new"), { terminal: "t7", op: "right", at: 1000 });
  assert.equal(f.answer("t7", "right:new"), null);
  assert.equal(f.pending(1001), false);
});

test("labels for another key, terminal or after expiry do nothing", () => {
  const f = new Forwards();
  f.add("lux/t3", "left", 1000, undefined);
  assert.equal(f.answer("lux/t3", "close:1"), null);
  assert.equal(f.answer("t3", "left:2"), null);
  assert.equal(f.pending(3000), false);
  assert.equal(f.answer("lux/t3", "left:3"), null);
});

test("a later forward settles earlier ones to the same terminal", () => {
  const f = new Forwards();
  f.add("t7", "right", 1000, undefined);
  f.add("t7", "right", 1100, undefined);
  f.add("t7", "close", 1200, undefined);
  assert.equal(f.answer("t7", "right:1").at, 1000);
  assert.equal(f.answer("t7", "right:2").at, 1100);
  assert.equal(f.answer("t7", "close:3").at, 1200);
  assert.equal(f.pending(1300), false);
});

// p1 | (p2 over p3), as Core stores a tab: weights default to 1.
function tab() {
  return {
    id: "tb", type: "row", children: [
      { id: "p1", type: "block", size: { weight: 0.5 } },
      { id: "s1", type: "column", size: { weight: 0.5 }, children: [
        { id: "p2", type: "block" },
        { id: "p3", type: "block" },
      ] },
    ],
  };
}
const near = (sizes, expected) => {
  assert.equal(sizes.length, expected.length);
  sizes.forEach((s, i) => { assert.equal(s.id, expected[i].id); assert.ok(Math.abs(s.weight - expected[i].weight) < 1e-9, `${s.id} ${s.weight}`); });
};

test("resize moves the divider after the pane, else the one before", () => {
  near(resizeWeights(tab(), "p1", "right"), [{ id: "p1", weight: 0.55 }, { id: "s1", weight: 0.45 }]);
  near(resizeWeights(tab(), "p1", "left"), [{ id: "p1", weight: 0.45 }, { id: "s1", weight: 0.55 }]);
  // p2 has no divider on its right, so the one on its left moves.
  near(resizeWeights(tab(), "p2", "right"), [{ id: "p1", weight: 0.55 }, { id: "s1", weight: 0.45 }]);
  near(resizeWeights(tab(), "p2", "down"), [{ id: "p2", weight: 1.1 }, { id: "p3", weight: 0.9 }]);
  near(resizeWeights(tab(), "p3", "down"), [{ id: "p2", weight: 1.1 }, { id: "p3", weight: 0.9 }]);
  near(resizeWeights(tab(), "p3", "up"), [{ id: "p2", weight: 0.9 }, { id: "p3", weight: 1.1 }]);
});

test("resize does nothing without a divider on that axis", () => {
  assert.equal(resizeWeights(tab(), "p1", "up"), null);
  assert.equal(resizeWeights({ id: "tb", type: "block" }, "tb", "left"), null);
  assert.equal(resizeWeights(tab(), "missing", "left"), null);
  assert.equal(resizeWeights(null, "p1", "left"), null);
});

test("resize stops at the minimum share and never reverses", () => {
  // p1 0.03 + s1 0.5: the step and the minimum are both 5% of 0.53.
  const t = tab();
  t.children[0].size.weight = 0.03;
  near(resizeWeights(t, "p1", "left"), [{ id: "p1", weight: 0.0265 }, { id: "s1", weight: 0.5035 }]);
  near(resizeWeights(t, "p1", "right"), [{ id: "p1", weight: 0.0565 }, { id: "s1", weight: 0.4735 }]);
  // Already below the minimum: shrinking does nothing rather than grow it.
  t.children[0].size.weight = 0.02;
  assert.equal(resizeWeights(t, "p1", "left"), null);
  const fixed = tab();
  fixed.children[1].size = { px: 300 };
  assert.equal(resizeWeights(fixed, "p1", "right"), null);
});

test("each op has the letter Emacs publishes for it", () => {
  assert.equal(localLetter("left"), "h");
  assert.equal(localLetter("resize-right"), "L");
  assert.equal(localLetter("close"), "w");
  assert.equal(localLetter("horizontal"), null);
});

test("Emacs's published keys count only once it has caught up", () => {
  const l = new Local();
  assert.equal(l.letters("t3", undefined, 1000), null);
  assert.equal(l.letters("t3", "lHLw:4", 1000), "lHLw");
  l.sent("t3", 1100);
  assert.equal(l.owes("t3", 1110), true);
  // Not yet answered: the old letters may be stale.
  assert.equal(l.letters("t3", "lHLw:4", 1120), null);
  assert.equal(l.letters("t3", "hHLw:5", 1150), "hHLw");
  assert.equal(l.owes("t3", 1150), false);
  // Two keys sent, one answered.
  l.sent("t3", 1200);
  l.sent("t3", 1210);
  assert.equal(l.letters("t3", "lHLw:6", 1230), null);
  assert.equal(l.letters("t3", "hHLw:7", 1250), "hHLw");
  // The app's copy lags: an older count there says nothing.
  assert.equal(l.letters("t3", "lHLw:6", 1260), null);
  // A key Emacs never answers stops counting after REQUEST_MS.
  l.sent("t3", 2000);
  assert.equal(l.letters("t3", "hHLw:7", 2100), null);
  assert.equal(l.letters("t3", "hHLw:7", 3600), "hHLw");
  // From Core, a lower count means Emacs restarted.
  assert.equal(l.letters("t3", ":0", 3700, true), "");
  assert.equal(l.letters("t3", "l:1", 3710), "l");
  assert.equal(l.letters("t3", "garbage", 3800), null);
});

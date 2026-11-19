// Herdr app mod logic: node --test tests/edges.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { Edges, Forwards, REPEAT_MS, isEditor, parseKey } from "../herdr-app/mods/edger/edges.js";

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
  assert.equal(parseKey("sync:3"), null);
  assert.equal(parseKey("wake"), null);
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

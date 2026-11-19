// Edger for the Herdr app: Alt+h/j/k/l, Alt+u/i and Alt+w go to Emacs or
// Neovim first, then move between panes, tabs and spaces, split, or close.
//
// keys.json binds each key to "edger.<op>" (left, down, up, right,
// horizontal, vertical, close), optionally with ":<key>" naming the key to
// forward to an editor (default alt+<letter>). An editor in the focused
// terminal gets the key through `hc keys`. When it has no window that way, or
// nothing left to close, the editor runs `edger cross <op>`, which changes the
// `edger` label on its own Core terminal. This mod acts on that label only for
// a terminal it just forwarded the same key to, so another Herdr window on the
// same Core, or an old label, does nothing. Labels reach the app through Core,
// so editors on other machines work the same way.
//
// The mod must be shown to receive key commands: mod.json makes it a kept,
// frameless 2 px window (`herdr-app do mod.open --name edger`, once per
// layout), or a personal layout can show it as a float. Only the copy that
// started last acts, so a second host does not move twice.

import { View, div } from "gpui-kit";
import { appHome, checking, exec, focused, hc, nextCommand, panes, run, setShared, shared, spaces, terminals } from "herdr";
import { Edges, Forwards, Local, REPEAT_MS, STEP, forwardKeys, isEditor, keyHex, localLetter, parseKey, resizeWeights } from "./edges.js";

const POLL_MS = 10;
// The app stores its layout in Core about half a second after a change, so
// resizes within this long of the last one reuse the tree they changed.
const TREE_MS = 1500;

function record(address) {
  return address ? terminals().find((t) => t.address === address) : undefined;
}

export default class Edger extends View {
  init(_props, cx) {
    this.edges = new Edges();
    this.forwards = new Forwards();
    this.local = new Local();
    this.inbox = [];
    this.seq = 0;
    this.polling = false;
    this.trees = new Map();
    this.typing = Promise.resolve();
    this.id = `${Date.now()}:${Math.random()}`;
    if (checking()) return;
    setShared("edger.copy", this.id);
    cx.spawn(async (cx) => {
      for (;;) {
        const next = this.inbox.length ? this.inbox.shift() : await this.receive();
        try {
          await this.handle(next.command, next.at, cx);
        } catch (error) {
          console.log(`edger: ${next.command}: ${error}`);
        }
      }
    });
  }

  async close() {
    if (shared("edger.copy") === this.id) setShared("edger.copy", null);
  }

  // This copy acts unless another one started later and is still shown.
  owner() {
    if (!shared("edger.copy")) setShared("edger.copy", this.id);
    return shared("edger.copy") === this.id;
  }

  // The next command, noting when each key arrived.
  async receive() {
    const command = await nextCommand();
    const at = Date.now();
    const parsed = parseKey(command);
    if (parsed) this.edges.pressed(parsed.op, at);
    return { command, at };
  }

  // Waits until the app has run every command sent before this one. Other
  // commands that arrive meanwhile wait in the inbox.
  async settle() {
    const marker = `sync:${++this.seq}`;
    run(`edger.${marker}`);
    for (;;) {
      const next = await this.receive();
      if (next.command === marker) return;
      if (!next.command.startsWith("sync:")) this.inbox.push(next);
    }
  }

  async handle(command, now, cx) {
    if (!this.owner()) return;
    if (command.startsWith("cross:")) {
      const [, op, terminal, at] = command.split(":");
      return this.cross(op, terminal, Number(at), cx);
    }
    const parsed = parseKey(command);
    if (!parsed) return;
    const { op, key } = parsed;
    const f = focused();
    if (!f?.pane) return;
    const r = record(f.terminal);
    if (isEditor(r) && !(await this.passes(f.terminal, op, r, now))) {
      // A move inside the editor ends a confirmation armed for another key.
      if (this.edges.arm?.dir !== op) this.edges.clear();
      this.forwards.add(f.terminal, op, now, r?.labels?.edger);
      this.local.sent(f.terminal, now);
      this.type(f.terminal, r, key);
      this.poll(cx);
      return;
    }
    if (op in STEP) return this.navigate(op, f, now, cx);
    if (op.startsWith("resize-")) return this.resize(op.slice(7), f);
    return this.action(op, f.pane);
  }

  // Whether an editor has said it would not use `op`, so the mod acts at
  // once as for a shell. The app's copy of the label lags Core's by 150 ms
  // or more, so unless that copy is current and says the editor uses the
  // key, the mod asks Core before deciding.
  async passes(terminal, op, record, now) {
    const label = record?.labels?.["edger.local"];
    const letter = localLetter(op);
    // Editors that publish nothing, such as Neovim, always get the key.
    if (letter === null || label === undefined) return false;
    const app = this.local.letters(terminal, label, now);
    if (app !== null && app.includes(letter)) return false;
    try {
      const r = await hc(["get", terminal, "--json"]);
      if (r.code !== 0) return false;
      const core = this.local.letters(terminal, JSON.parse(r.stdout)?.labels?.["edger.local"], now, true);
      return core !== null && !core.includes(letter);
    } catch (error) {
      console.log(`edger: hc get ${terminal}: ${error}`);
      return false;
    }
  }

  // Types a key into an editor's terminal, one key at a time so fast presses
  // keep their order. `hc keys` waits until nobody has typed in the terminal
  // for 3 s, so the `type` helper types as an attached viewer instead, and
  // `hc keys` is only the fallback when the helper cannot attach.
  type(terminal, record, key) {
    const hex = keyHex(key);
    const keys = () => hc(["keys", terminal, ...forwardKeys(record, key)]).then(
      (r) => { if (r.code !== 0) console.log(`edger: hc keys ${terminal}: ${r.stderr.trim()}`); },
      (error) => console.log(`edger: hc keys ${terminal}: ${error}`));
    const typed = () => {
      if (!hex || !record?.cols || !record?.rows) return keys();
      const args = [`${appHome()}/mods/edger/type`, terminal, String(record.cols), String(record.rows), hex];
      return exec("bash", args, { timeout: 3000 }).then(
        (r) => { if (r.code !== 0) { console.log(`edger: type ${terminal}: ${r.stderr.trim()}`); return keys(); } },
        (error) => { console.log(`edger: type ${terminal}: ${error}`); return keys(); });
    };
    this.typing = this.typing.then(typed, typed);
  }

  // Watches forwarded terminals' labels until every forward answers or expires.
  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    const tick = (cx) => {
      for (const terminal of new Set(this.forwards.list.map((f) => f.terminal))) {
        const found = this.forwards.answer(terminal, record(terminal)?.labels?.edger);
        if (found) {
          this.inbox.push({ command: `cross:${found.op}:${terminal}:${found.at}`, at: found.at });
          run("edger.wake");
        }
      }
      if (this.forwards.pending(Date.now())) cx.timer.after(POLL_MS, tick);
      else this.polling = false;
    };
    cx.timer.after(POLL_MS, tick);
  }

  async cross(op, terminal, at, cx) {
    const f = focused();
    // The editor's terminal must still have focus in this window.
    if (!f?.pane || f.terminal !== terminal) return;
    if (op in STEP) return this.navigate(op, f, at, cx);
    if (op.startsWith("resize-")) return this.resize(op.slice(7), f);
    if (op === "close") return this.action(op, f.pane);
  }

  // Moves the focused pane's nearest Herdr divider in `dir`. The app's
  // layout.resize sets a node's weight; the current weights live in the
  // "herdr-app" document of the machine the space is on.
  async resize(dir, f) {
    this.edges.clear();
    const space = spaces().find((s) => s.id === f.space);
    const tab = space?.tabs.find((t) => t.id === f.tab);
    if (!tab) return;
    const machine = space.machine ?? null;
    const prefix = machine ? `${machine}/` : "";
    const local = (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
    let cached = this.trees.get(f.tab);
    if (cached && (Date.now() - cached.at > TREE_MS || cached.panes !== tab.panes)) cached = null;
    let sizes = cached && resizeWeights(cached.root, local(f.pane), dir);
    if (!sizes) {
      cached = { root: await this.tree(machine, local(f.tab)), panes: tab.panes };
      sizes = resizeWeights(cached.root, local(f.pane), dir);
    }
    if (!sizes) return;
    for (const { id, weight } of sizes) run("layout.resize", { id: prefix + id, weight });
    const set = (node) => {
      const size = sizes.find((s) => s.id === node.id);
      if (size) node.size = { weight: size.weight };
      (node.children ?? []).forEach(set);
    };
    set(cached.root);
    cached.at = Date.now();
    this.trees.set(f.tab, cached);
  }

  async tree(machine, tab) {
    const params = machine ? { name: "herdr-app", on: machine } : { name: "herdr-app" };
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params });
    const r = await exec("sh", ["-c", 'printf \'%s\\n\' "$1" | exec hc connect', "edger", request], { timeout: 5000 });
    if (r.code !== 0) throw new Error(`hc connect: ${r.stderr.trim()}`);
    for (const line of r.stdout.split("\n")) {
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (reply?.id !== 1) continue;
      if (reply.error) throw new Error(`doc.get: ${JSON.stringify(reply.error)}`);
      for (const s of reply.result?.value?.spaces ?? []) {
        const found = (s.tabs ?? []).find((t) => t.id === tab);
        if (found) return found.root;
      }
    }
    return null;
  }

  async navigate(dir, f, at, cx) {
    const zoomed = panes().some((p) => p.pane === f.pane && p.zoomed);
    run("pane.go", { direction: dir });
    await this.settle();
    const to = focused()?.pane;
    if (to !== f.pane) {
      // As in the TUI, moving to a neighboring split shows the whole tab.
      if (zoomed && to && panes().some((p) => p.pane === to && p.zoomed)) run("pane.zoom", { pane: to });
      this.edges.traveled(dir, at);
      return;
    }
    const all = spaces();
    const si = all.findIndex((s) => s.id === f.space);
    const space = all[si];
    if (!space) return;
    if (dir === "left" || dir === "right") {
      const tabs = space.tabs.filter((t) => !t.settled || t.id === f.tab);
      const ti = tabs.findIndex((t) => t.id === f.tab);
      const target = ti < 0 ? undefined : tabs[ti + STEP[dir]];
      if (target) { run("tab.select", { id: target.id }); this.edges.traveled(dir, at); return; }
    } else {
      const target = all[si + STEP[dir]];
      if (target) { run("space.select", { id: target.id }); this.edges.traveled(dir, at); return; }
    }
    if (!this.edges.edge(dir, f.pane, at)) return;
    const wait = Math.max(0, at + REPEAT_MS - Date.now()) + POLL_MS;
    cx.timer.after(wait, () => {
      if (!this.edges.confirm(dir, f.pane, at)) return;
      if (dir === "right") run("tab.new", { space: space.id });
      else run("space.new", { machine: space.machine ?? "" });
    });
  }

  action(op, pane) {
    this.edges.clear();
    if (op === "horizontal") return run("pane.split", { direction: "down", pane });
    if (op === "vertical") return run("pane.split", { direction: "right", pane });
    if (op !== "close") return;
    // Keep the last pane of the last space, as the TUI does.
    const all = spaces();
    if (all.length === 1 && all[0].tabs.length === 1 && all[0].tabs[0].panes === 1) return;
    run("pane.close", { pane });
  }

  render() {
    return div();
  }
}

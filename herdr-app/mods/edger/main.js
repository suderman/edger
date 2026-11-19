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
import { checking, focused, hc, nextCommand, panes, run, setShared, shared, spaces, terminals } from "herdr";
import { Edges, Forwards, REPEAT_MS, STEP, isEditor, parseKey } from "./edges.js";

const POLL_MS = 10;

function record(address) {
  return address ? terminals().find((t) => t.address === address) : undefined;
}

export default class Edger extends View {
  init(_props, cx) {
    this.edges = new Edges();
    this.forwards = new Forwards();
    this.inbox = [];
    this.seq = 0;
    this.polling = false;
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
    if (isEditor(r)) {
      // A move inside the editor ends a confirmation armed for another key.
      if (this.edges.arm?.dir !== op) this.edges.clear();
      this.forwards.add(f.terminal, op, now, r?.labels?.edger);
      hc(["keys", f.terminal, key]).then(
        (r) => { if (r.code !== 0) console.log(`edger: hc keys ${f.terminal}: ${r.stderr.trim()}`); },
        (error) => console.log(`edger: hc keys ${f.terminal}: ${error}`));
      this.poll(cx);
      return;
    }
    if (op in STEP) return this.navigate(op, f, now, cx);
    return this.action(op, f.pane);
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
    if (op === "close") return this.action(op, f.pane);
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

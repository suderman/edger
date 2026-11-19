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
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, hc, nextCommand, openOverlay, panes, props, readTextFile, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { Edges, Forwards, LETTER, Local, PREFIX_DEFAULTS, REPEAT_MS, STEP, copyKey, forwardKeys, isEditor, keyHex, lineSelection, localLetter, parseKey, prefixMatch, prefixRows, resizeWeights } from "./edges.js";

const POLL_MS = 10;
// The app stores its layout in Core about half a second after a change, so
// resizes within this long of the last one reuse the tree they changed.
const TREE_MS = 1500;

function record(address) {
  return address ? terminals().find((t) => t.address === address) : undefined;
}

export default class Edger extends View {
  init(_props, cx) {
    // The Alt+Z prefix popup and copy mode are other copies of this mod.
    if (props()?.prefix) return this.initPrefix(cx);
    if (props()?.copy) return this.initCopy(cx);
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
    // A popup flag left by a crash or restart would capture the next key.
    if (shared("edger.prefix")) setShared("edger.prefix", null);
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
    if (this.copy) return this.leaveCopy(false);
    if (this.prefix) {
      if (shared("edger.prefix") === props().overlay) setShared("edger.prefix", null);
      return;
    }
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
    if (command === "prefix") return this.openPrefix();
    if (command === "copy") return this.openCopy();
    if (command.startsWith("cross:")) {
      const [, op, terminal, at] = command.split(":");
      return this.cross(op, terminal, Number(at), cx);
    }
    const parsed = parseKey(command);
    if (!parsed) return;
    const { op, key } = parsed;
    // With Alt still held after Alt+Z, the app sends Edger's own keys here,
    // not to the popup: treat them as the prefix's next key.
    if (shared("edger.prefix")) return this.prefixKey(op);
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

  // Alt+Z: show the prefix table and wait for one key, with no timeout.
  // edger.json beside keys.json may give the table as {"prefix": {...}}.
  async openPrefix() {
    const open = shared("edger.prefix");
    if (open) { closeOverlay(open); setShared("edger.prefix", null); return; }
    let table = PREFIX_DEFAULTS;
    try {
      const text = await readTextFile(`${appHome()}/edger.json`);
      const prefix = text && JSON.parse(text)?.prefix;
      if (prefix && typeof prefix === "object") table = prefix;
    } catch (error) {
      console.log(`edger: edger.json: ${error}`);
    }
    this.prefixTable = table;
    openOverlay({ mod: "edger", props: { prefix: true, table }, kind: "popup", at: "top", offset: 40, width: 560 });
  }

  prefixKey(op) {
    closeOverlay(shared("edger.prefix"));
    setShared("edger.prefix", null);
    const letter = LETTER[op];
    const action = prefixMatch(this.prefixTable, { keystroke: op.startsWith("resize-") ? `shift-${letter}` : letter, modifiers: {} });
    if (!action) return;
    if (action.args === undefined) run(action.command);
    else run(action.command, action.args);
  }

  initPrefix(cx) {
    this.prefix = true;
    this.table = props().table ?? PREFIX_DEFAULTS;
    this.rows = prefixRows(this.table);
    this.handle = cx.focus_handle();
    setShared("edger.prefix", props().overlay);
    // The popup takes the keyboard once it has drawn.
    this.handle.focus();
    for (const ms of [20, 80, 200]) cx.timer.after(ms, () => this.handle.focus());
  }

  dismiss() {
    if (shared("edger.prefix") === props().overlay) setShared("edger.prefix", null);
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    cx.stop_propagation();
    if (e.key === "escape") return this.dismiss();
    // Accept the key whether or not Alt is still held from Alt+Z.
    const bare = e.modifiers?.alt ? { ...e, keystroke: e.keystroke.replace(/(^|-)alt-/, "$1"), modifiers: { ...e.modifiers, alt: false } } : e;
    const action = prefixMatch(this.table, e) ?? prefixMatch(this.table, bare);
    this.dismiss();
    if (!action) return;
    if (action.args === undefined) run(action.command);
    else run(action.command, action.args);
  }

  renderPrefix() {
    const t = theme();
    return v_flex()
      .id("edger-prefix")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().px(6).py(2).rounded(5).bg(t.accent).text_color(t.accent_foreground).font_semibold().child("alt-z"))
        .child(div().flex_1().text_color(t.muted).child("then a key"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex().flex_wrap().gap_y(4).children(this.rows.map((r) =>
        h_flex().w(176).gap(8).items_center()
          .child(div().w(52).flex_none().text_color(t.accent).font_semibold().child(r.key))
          .child(div().flex_1().truncate().text_color(t.foreground).child(r.action.label)))));
  }

  // Copy mode for the focused terminal, opened from the prefix (Alt+Z m).
  openCopy() {
    const terminal = focused()?.terminal;
    if (!terminal) return;
    openOverlay({ mod: "edger", props: { copy: true, terminal }, kind: "popup", at: "top", offset: 6, width: 600 });
  }

  initCopy(cx) {
    this.copy = true;
    this.terminal = props().terminal;
    this.mode = "cursor";
    this.keys = [];
    this.busy = false;
    this.seq = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    for (const ms of [20, 80, 200]) cx.timer.after(ms, () => this.handle.focus());
    // A one-character selection at the program's cursor is the cursor.
    this.queueCopy({ op: "start" }, cx);
  }

  // Runs commands, then waits until the app has applied them.
  async apply(commands) {
    for (const [name, args] of commands) run(name, args);
    const marker = `copysync:${++this.seq}:${props().overlay}`;
    run(`edger.${marker}`);
    for (;;) if ((await nextCommand()) === marker) return;
  }

  selection() {
    return terminals().find((t) => t.address === this.terminal)?.selection ?? null;
  }

  rows() {
    const scroll = panes().find((p) => p.terminal === this.terminal)?.scroll;
    return scroll?.total ?? record(this.terminal)?.rows ?? 1;
  }

  queueCopy(key, cx) {
    this.keys.push(key);
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      while (this.keys.length) {
        try {
          await this.copyStep(this.keys.shift());
        } catch (error) {
          console.log(`edger: copy mode: ${error}`);
        }
        cx.notify();
      }
      this.busy = false;
    });
  }

  async copyStep(key) {
    const terminal = this.terminal;
    const collapse = async () => {
      const end = this.selection()?.end;
      if (end) await this.apply([["terminal.select", { terminal, at: end }]]);
    };
    switch (key.op) {
      case "start":
        await this.apply([["terminal.select", { terminal }]]);
        return;
      case "exit":
        return this.leaveCopy(true);
      case "copy":
        // A cursor alone is not worth replacing the clipboard for.
        if (this.mode !== "cursor") await this.apply([["terminal.copy", {}]]);
        return this.leaveCopy(true);
      case "select":
        if (this.mode === "char") { this.mode = "cursor"; return collapse(); }
        if (this.mode === "lines") await this.apply([["terminal.select", { terminal, at: { row: this.row, col: 0 } }]]);
        this.mode = "char";
        return;
      case "lines": {
        if (this.mode === "lines") {
          this.mode = "cursor";
          return this.apply([["terminal.select", { terminal, at: { row: this.row, col: 0 } }]]);
        }
        const end = this.selection()?.end;
        if (!end) return;
        this.anchor = this.row = end.row;
        this.mode = "lines";
        return this.apply(lineSelection(terminal, this.anchor, this.row, record(terminal)?.cols ?? 1));
      }
      case "move": {
        if (this.mode === "lines") {
          const page = panes().find((p) => p.terminal === terminal)?.scroll?.len ?? record(terminal)?.rows ?? 1;
          const by = { up: -1, down: 1, page_up: -page, page_down: page }[key.move];
          if (!by) return;
          this.row = Math.max(0, Math.min(this.rows() - 1, this.row + by));
          return this.apply(lineSelection(terminal, this.anchor, this.row, record(terminal)?.cols ?? 1));
        }
        await this.apply([["terminal.adjust_selection", { terminal, direction: key.move }]]);
        if (this.mode === "cursor") await collapse();
        return;
      }
    }
  }

  // Clears the selection, returns the view to the bottom, and closes.
  leaveCopy(close) {
    if (this.left) return;
    this.left = true;
    run("terminal.clear_selection", { terminal: this.terminal });
    run("terminal.scroll", { terminal: this.terminal, to: "bottom" });
    if (close) closeOverlay(props().overlay);
  }

  renderCopy() {
    const t = theme();
    const label = { cursor: "move the cursor", char: "selecting", lines: "selecting lines" }[this.mode];
    const hint = (k, text) => h_flex().gap(4).child(div().text_color(t.accent).font_semibold().child(k)).child(div().text_color(t.muted).child(text));
    return h_flex()
      .id("edger-copy")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        cx.stop_propagation();
        const key = copyKey(e);
        if (key) this.queueCopy(key, cx);
      })
      .w_full()
      .px(10)
      .py(6)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .text_size(12)
      .child(div().px(6).py(1).rounded(4).bg(t.accent).text_color(t.accent_foreground).font_semibold().child("COPY"))
      .child(div().flex_1().text_color(t.foreground).child(label))
      .child(hint("m", "select"))
      .child(hint("M", "lines"))
      .child(hint("c", "copy"))
      .child(hint("Esc", "leave"));
  }

  render() {
    if (this.copy) return this.renderCopy();
    return this.prefix ? this.renderPrefix() : div();
  }
}

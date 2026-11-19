// Edger's decisions for the Herdr app, without the app: which program counts
// as an editor, when a press at the outer edge creates a tab or space, and
// which forwarded key an editor's request answers. Times are milliseconds.

export const EDITOR = /^(emacs|emacsclient|nvim|vim|vi|view|gvim|nvimdiff|vimdiff)$/;
export const LETTER = {
  left: "h", down: "j", up: "k", right: "l", horizontal: "u", vertical: "i", close: "w",
  "resize-left": "h", "resize-down": "j", "resize-up": "k", "resize-right": "l",
};
export const STEP = { left: -1, up: -1, right: 1, down: 1 };
// As in bin/edger: how long a confirmation stays armed, the quiet period
// after rapid navigation, and presses closer than this count as key repeat.
export const BOUNDARY_MS = 700;
export const CREATION_IDLE_MS = 400;
export const REPEAT_MS = 120;
// How long a forwarded key may take to come back from the editor as a request.
export const REQUEST_MS = 1500;
// A resize moves a divider by this share of its split, and leaves each side
// at least this share.
export const RESIZE_STEP = 0.05;

// A Core terminal record: what runs in the foreground now, else what started.
export function isEditor(record) {
  const fg = record?.foreground;
  const names = fg ? [fg.name, fg.argv?.[0]] : [record?.argv?.[0]];
  return names.some((n) => typeof n === "string" && EDITOR.test(n.split("/").pop().toLowerCase()));
}

// Core 0.1.21's `hc keys alt+shift+k` drops Shift for a program in legacy
// keyboard mode (it sends ESC k). ESC then Shift+k are the bytes a real
// terminal sends there. Neovim asks for the kitty keyboard protocol, where
// Core encodes Shift correctly and ESC would arrive as a key of its own.
const KITTY = /^nvim$/;
export function forwardKeys(record, key) {
  const shifted = /^alt\+shift\+([a-z])$/.exec(key);
  if (!shifted) return [key];
  const fg = record?.foreground;
  const names = fg ? [fg.name, fg.argv?.[0]] : [record?.argv?.[0]];
  const kitty = names.some((n) => typeof n === "string" && KITTY.test(n.split("/").pop().toLowerCase()));
  return kitty ? [key] : ["esc", `shift+${shifted[1]}`];
}

// The bytes a terminal in its legacy keyboard mode sends for a key such as
// "alt+h", "alt+shift+h" or "ctrl+alt+h", as hex; null for keys it cannot
// tell apart there (ctrl+shift) or names other than a letter or digit.
export function keyHex(spec) {
  const parts = spec.toLowerCase().split("+");
  const name = parts.pop();
  if (!/^[a-z0-9]$/.test(name)) return null;
  const mods = new Set();
  for (const m of parts) {
    if (m === "alt" || m === "meta") mods.add("alt");
    else if (m === "ctrl" || m === "control") mods.add("ctrl");
    else if (m === "shift") mods.add("shift");
    else return null;
  }
  const letter = /[a-z]/.test(name);
  if ((mods.has("shift") || mods.has("ctrl")) && !letter) return null;
  if (mods.has("shift") && mods.has("ctrl")) return null;
  let code = name.charCodeAt(0);
  if (mods.has("shift")) code -= 32;
  if (mods.has("ctrl")) code &= 0x1f;
  return (mods.has("alt") ? "1b" : "") + code.toString(16).padStart(2, "0");
}

// "edger.<op>[:<key>]" from keys.json, without the mod name.
export function parseKey(command) {
  const i = command.indexOf(":");
  const op = i < 0 ? command : command.slice(0, i);
  if (!(op in LETTER)) return null;
  const shift = op.startsWith("resize-") ? "shift+" : "";
  return { op, key: (i < 0 ? "" : command.slice(i + 1)) || `alt+${shift}${LETTER[op]}` };
}

// A tab's split tree as Core stores it (doc.get "herdr-app": nodes with id,
// type "row" | "column" | "block", children, and size {weight} or {px}).
// Moving `pane`'s divider in `dir`, as Edger does in Emacs and tmux: the
// nearest divider after the pane on that axis, else the one before it, moves
// that way. Returns the two new sizes, or null when nothing can move.
export function resizeWeights(root, pane, dir) {
  const axis = dir === "left" || dir === "right" ? "row" : "column";
  const path = [];
  const find = (node) => {
    if (node.id === pane) return true;
    for (const child of node.children ?? []) {
      path.push([node, child]);
      if (find(child)) return true;
      path.pop();
    }
    return false;
  };
  if (!root || !find(root)) return null;
  const levels = path.filter(([node]) => node.type === axis).reverse();
  const divider = (offset) => {
    for (const [node, child] of levels) {
      const i = node.children.indexOf(child);
      const j = i + offset;
      if (j >= 0 && j < node.children.length) return [node, Math.min(i, j)];
    }
    return null;
  };
  const found = divider(1) ?? divider(-1);
  if (!found) return null;
  const [node, i] = found;
  const fixed = (n) => n.size?.px !== undefined;
  const weight = (n) => n.size?.weight ?? 1;
  const a = node.children[i];
  const b = node.children[i + 1];
  if (fixed(a) || fixed(b)) return null;
  const total = node.children.filter((n) => !fixed(n)).reduce((sum, n) => sum + weight(n), 0);
  const least = total * RESIZE_STEP;
  const wanted = total * RESIZE_STEP * (dir === "left" || dir === "up" ? -1 : 1);
  // Never past the minimum, and never back the other way.
  const d = wanted < 0 ? Math.min(0, Math.max(wanted, least - weight(a)))
    : Math.max(0, Math.min(wanted, weight(b) - least));
  if (Math.abs(d) < total * 1e-6) return null;
  return [{ id: a.id, weight: weight(a) + d }, { id: b.id, weight: weight(b) - d }];
}

// One window's double-press state. The app gives key bindings no release or
// repeat flag, so a held key looks like a fast stream of presses. A press
// that would create waits REPEAT_MS: another press of the same key in that
// time means the key is held, and nothing is created.
export class Edges {
  constructor() {
    this.arm = null;
    this.travel = null;
    this.last = {};
  }

  // Every press of an Edger key, as it arrives.
  pressed(op, now) { this.last[op] = now; }
  clear() { this.arm = null; }
  // A neighbor took focus: confirmation ends, and travel is remembered.
  traveled(dir, now) { this.arm = null; this.travel = { dir, at: now }; }

  // At the outer edge with nothing beyond, for the press made at `now`:
  // true when it confirms a creation, which `confirm` must still allow.
  edge(dir, pane, now) {
    if (STEP[dir] < 0) { this.arm = null; this.travel = null; return false; }
    const t = this.travel;
    if (t && t.dir === dir && now >= t.at && now - t.at < CREATION_IDLE_MS) {
      this.arm = null;
      this.travel = { dir, at: now };
      return false;
    }
    if (t && t.dir !== dir) this.travel = null;
    const a = this.arm;
    if (!a || a.dir !== dir || a.pane !== pane || now < a.at || now - a.at > BOUNDARY_MS) {
      this.arm = { dir, pane, at: now, last: now };
      return false;
    }
    if (now - a.last < REPEAT_MS) { a.last = now; return false; }
    this.arm = null;
    this.travel = { dir, at: now };
    return true;
  }

  // REPEAT_MS after a confirming press at `at`: create unless pressed again.
  confirm(dir, pane, at) {
    const later = this.last[dir];
    if (later !== undefined && later > at) {
      this.arm = { dir, pane, at: later, last: later };
      return false;
    }
    return true;
  }
}

// Keys forwarded to editors, waiting for an editor to ask for the move. An
// editor answers by changing its terminal's `edger` label to "<op>:<nonce>".
export class Forwards {
  constructor() {
    this.list = [];
    this.seen = {};
  }

  add(terminal, op, at, label) {
    if (!this.list.some((f) => f.terminal === terminal)) this.seen[terminal] = label;
    this.list.push({ terminal, op, at });
  }

  // Drops expired forwards; true while any remain.
  pending(now) {
    this.list = this.list.filter((f) => now - f.at < REQUEST_MS);
    return this.list.length > 0;
  }

  // A terminal's label now. Returns the forward it answers, at most once per
  // label value, or null. Older forwards to that terminal are settled too.
  answer(terminal, label) {
    if (label === undefined || label === this.seen[terminal]) return null;
    this.seen[terminal] = label;
    const op = String(label).split(":")[0];
    const i = this.list.findIndex((f) => f.terminal === terminal && f.op === op);
    if (i < 0) return null;
    const found = this.list[i];
    this.list = this.list.filter((f, j) => f.terminal !== terminal || j > i);
    return found;
  }
}

// Which letter an editor publishes when it handles `op` itself (see Local);
// null for splits, which an editor always handles.
export function localLetter(op) {
  if (op.startsWith("resize-")) return LETTER[op].toUpperCase();
  if (op === "horizontal" || op === "vertical") return null;
  return LETTER[op] ?? null;
}

// Emacs publishes the label edger.local = "<letters>:<count>": the Edger
// keys it would handle itself in its selected window, and how many Edger
// commands it has run in that terminal. Each key sent to it owes one more
// count; until Emacs has caught up, its letters may be out of date and the
// key goes to it as before.
export class Local {
  constructor() {
    this.seen = {};
    this.owed = {};
  }

  sent(terminal, at) {
    (this.owed[terminal] ??= []).push(at);
  }

  // Whether keys sent to the terminal are still unanswered.
  owes(terminal, now) {
    this.owed[terminal] = (this.owed[terminal] ?? []).filter((at) => now - at < REQUEST_MS);
    return this.owed[terminal].length > 0;
  }

  // The letters, or null when unknown or not yet current. `fresh` labels
  // come from Core; the app's copy lags, so a count below one already read
  // there is old, while from Core it means Emacs restarted.
  letters(terminal, label, now, fresh = false) {
    this.owes(terminal, now);
    const m = /^([A-Za-z]*):(\d+)$/.exec(label ?? "");
    if (!m) return null;
    const count = Number(m[2]);
    const seen = this.seen[terminal];
    if (seen !== undefined && count < seen && !fresh) return null;
    if (seen !== undefined && count > seen) this.owed[terminal] = this.owed[terminal].slice(count - seen);
    this.seen[terminal] = count;
    return this.owed[terminal].length ? null : m[1];
  }
}

// The Alt+Z prefix: a table of keys to actions, written as in keys.json
// ("pane.split:down", "edger.left", or {command, args}), with an optional
// {label}. Read from edger.json's "prefix", else these defaults.
export const PREFIX_DEFAULTS = {
  u: "pane.split:down",
  i: "pane.split:right",
  z: "pane.zoom",
  h: "pane.go:left",
  j: "pane.go:down",
  k: "pane.go:up",
  l: "pane.go:right",
  "?": "app.help",
};

const LABELS = {
  "pane.split:down": "split down", "pane.split:right": "split right",
  "pane.go:left": "focus left", "pane.go:down": "focus down", "pane.go:up": "focus up", "pane.go:right": "focus right",
  "pane.swap:left": "swap left", "pane.swap:down": "swap down", "pane.swap:up": "swap up", "pane.swap:right": "swap right",
  "pane.zoom": "zoom pane", "pane.close": "close pane",
  "tab.new": "new tab", "tab.close": "close tab", "tab.rename": "rename tab", "tab.prev": "previous tab", "tab.next": "next tab",
  "space.new": "new space", "space.close": "close space", "space.rename": "rename space",
  "app.help": "help", "app.settings": "settings", "app.palette": "palette", "window.close": "close window",
  "layout.toggle:sidebar": "sidebar", "terminal.select": "select text", "mod.open:picker": "go to…",
};

// One table entry as {command, args, label}: `command` may carry a
// keys.json shorthand value ("pane.split:down"), which run() accepts.
export function prefixAction(value) {
  if (typeof value === "string") {
    const tab = /^tab\.select:(\d+)$/.exec(value);
    return { command: value, args: undefined, label: LABELS[value] ?? (tab ? `tab ${tab[1]}` : value) };
  }
  if (!value || typeof value.command !== "string") return null;
  const by = value.args?.by;
  const label = value.label
    ?? (value.command === "tab.move" && typeof by === "number" ? `move tab ${by < 0 ? "left" : "right"}` : null)
    ?? LABELS[value.command] ?? value.command;
  return { command: value.command, args: value.args, label };
}

// Rows for the popup, in a stable order: letters, digits, then the rest.
// Digits that select tabs by number show as one row.
export function prefixRows(table) {
  const rank = (k) => (/^[a-z]$/.test(k) ? 0 : /^shift-[a-z]$/.test(k) ? 1 : /^[0-9]/.test(k) ? 2 : 3);
  const rows = Object.entries(table ?? {})
    .map(([key, value]) => ({ key, action: prefixAction(value) }))
    .filter((r) => r.action);
  const tabs = rows.filter((r) => /^[1-9]$/.test(r.key) && r.action.command === `tab.select:${r.key}`).map((r) => r.key).sort();
  const grouped = tabs.length > 2
    ? rows.filter((r) => !tabs.includes(r.key)).concat([{ key: `${tabs[0]}–${tabs.at(-1)}`, action: { label: "tab by number" } }])
    : rows;
  return grouped.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

// The entry a key press selects: its keystroke as keys.json spells it
// ("shift-d"), or the character it types ("?", "{") when no Ctrl, Alt or
// Super is held.
export function prefixMatch(table, event) {
  if (!table || !event) return null;
  if (Object.hasOwn(table, event.keystroke)) return prefixAction(table[event.keystroke]);
  const m = event.modifiers ?? {};
  if (event.key_char && !m.control && !m.alt && !m.platform && Object.hasOwn(table, event.key_char)) {
    return prefixAction(table[event.key_char]);
  }
  return null;
}

// Edger's decisions for the Herdr app, without the app: which program counts
// as an editor, when a press at the outer edge creates a tab or space, and
// which forwarded key an editor's request answers. Times are milliseconds.

export const EDITOR = /^(emacs|emacsclient|nvim|vim|vi|view|gvim|nvimdiff|vimdiff)$/;
export const LETTER = { left: "h", down: "j", up: "k", right: "l", horizontal: "u", vertical: "i", close: "w" };
export const STEP = { left: -1, up: -1, right: 1, down: 1 };
// As in bin/edger: how long a confirmation stays armed, the quiet period
// after rapid navigation, and presses closer than this count as key repeat.
export const BOUNDARY_MS = 700;
export const CREATION_IDLE_MS = 400;
export const REPEAT_MS = 120;
// How long a forwarded key may take to come back from the editor as a request.
export const REQUEST_MS = 1500;

// A Core terminal record: what runs in the foreground now, else what started.
export function isEditor(record) {
  const fg = record?.foreground;
  const names = fg ? [fg.name, fg.argv?.[0]] : [record?.argv?.[0]];
  return names.some((n) => typeof n === "string" && EDITOR.test(n.split("/").pop().toLowerCase()));
}

// "edger.<op>[:<key>]" from keys.json, without the mod name.
export function parseKey(command) {
  const i = command.indexOf(":");
  const op = i < 0 ? command : command.slice(0, i);
  if (!(op in LETTER)) return null;
  return { op, key: (i < 0 ? "" : command.slice(i + 1)) || `alt+${LETTER[op]}` };
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

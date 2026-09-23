# Edger

One directional key family moves through nested editor and multiplexer layers. When an editor window reaches an edge, Edger tries the enclosing pane. At a pane edge, it moves to the outer container.

| Direction | Editor | Pane edge in Herdr | Pane edge in tmux |
| --- | --- | --- | --- |
| left/right | Emacs or Neovim window | previous/next tab | previous/next window |
| up/down | Emacs or Neovim window | previous/next workspace | session navigation off by default |

Herdr tabs and workspaces wrap. tmux windows use tmux's native previous/next behavior. tmux sessions are opt-in, since switching sessions affects a client rather than an individual pane. No desktop window manager participates.

## How it works

`bin/edger left|down|up|right` checks the active multiplexer pane's foreground process. If it is Emacs, Neovim, or Vim, Edger forwards the configured key. Otherwise it tries the multiplexer pane, then its outer container. An editor calls `bin/edger cross <direction>` only after trying its own windows. Both Herdr and tmux use this one executable for process detection and outward routing.

The script needs Bash and the host's multiplexer CLI. Herdr additionally needs `jq`; tmux foreground detection uses `ps`. There is no compiled build step or daemon. `HERDR_BIN_PATH`, `TMUX_BIN_PATH`, `EDGER_BACKEND`, and `EDGER_KEY_MODIFIER` can override the executable, backend, or forwarded Herdr modifier. You can supply the exact forwarding key as the optional second argument, for example `edger left alt+h` or `edger left C-M-h`. Normally the host integration supplies it.

## Emacs

Emacs 31 can install this repository directly:

```elisp
(use-package edger
  :vc (:url "https://github.com/suderman/edger" :lisp-dir "emacs" :rev :newest)
  :bind (("C-M-h" . edger-left)
         ("C-M-j" . edger-down)
         ("C-M-k" . edger-up)
         ("C-M-l" . edger-right)))
```

Use `M-h/j/k/l` instead if those are your preferred keys. The package does not install mappings. Set `edger-executable` to the script's path or put `edger` on `PATH`. Ordinary terminal Emacs inherits `HERDR_PANE_ID` or `TMUX_PANE`. A graphical Emacs daemon serving terminal clients needs the pane identity per frame; pass `edger-herdr-pane-id` and `edger-herdr-socket-path` with `emacsclient --tty -F`, or `edger-tmux-pane-id` and `edger-tmux-socket` for tmux. The socket value is `$TMUX` for tmux and `$HERDR_SOCKET_PATH` for Herdr. Graphical frames stay inside Emacs.

## Neovim

With lazy.nvim:

```lua
{ "suderman/edger", opts = {} }
```

This maps normal-mode `<C-M-h/j/k/l>`. Change to Alt with `opts = { modifier = "M" }`, disable mappings with `opts = { keymaps = false }`, or set `opts.bin = "/path/to/edger"`. Directional `:EdgerLeft`, `:EdgerDown`, `:EdgerUp`, and `:EdgerRight` commands are always created. Without lazy.nvim, add the repository to `runtimepath` and call `require("edger").setup()`.

## Herdr

Install the repository as a plugin:

```sh
herdr plugin install suderman/edger
```

Bind the four exposed actions in `config.toml`. The default forwarded key family is Ctrl+Alt:

```toml
[[keys.command]]
key = "ctrl+alt+h"
type = "plugin_action"
command = "edger.left"

[[keys.command]]
key = "ctrl+alt+j"
type = "plugin_action"
command = "edger.down"

[[keys.command]]
key = "ctrl+alt+k"
type = "plugin_action"
command = "edger.up"

[[keys.command]]
key = "ctrl+alt+l"
type = "plugin_action"
command = "edger.right"
```

For Alt-only keys, bind `alt+h/j/k/l` to `type = "shell"` commands such as `EDGER_KEY_MODIFIER=alt /path/to/edger left`. An action's command arguments are fixed in its plugin manifest, so a shell binding or an environment variable set where Herdr launches is needed to change the forwarded chord. Keep direct pane movement available under a prefix if you want to bypass editor routing.

## tmux

With TPM:

```tmux
set -g @plugin 'suderman/edger'
```

Or execute `edger.tmux` from your tmux startup config. By default it binds `C-M-h/j/k/l` in the root table. Set `@edger-key 'M'` before loading it for Alt-only keys, or `@edger-mappings 'off'` to bind your own commands. `@edger-sessions 'on'` enables client-scoped vertical session cycling; otherwise up/down stop at the pane edge. tmux selects neighboring panes and windows natively and wraps windows using its normal behavior. The tmux plugin passes its pane and client identities to the same `bin/edger` script.

## Terminal keys and updates

`C-M-h/j/k/l` is the public recommendation, not a promise that every terminal encodes it distinctly. Traditional terminals may send ESC plus a control byte, and `C-h` can collide with Backspace. Confirm what your terminal delivers with Emacs `C-h k` or Neovim `:verbose nmap <C-M-h>` and test through the multiplexer before changing active mappings. Alt-only keys avoid the Ctrl+Backspace ambiguity and are the choice in Jon's local Herdr/Emacs setup. tmux 3.6a accepts `C-M-h/j/k/l` bindings; acceptance alone does not prove the physical key arrives distinctly.

Update the Herdr plugin, editor package, and tmux plugin from the same revision when possible. The shell script is interpreted directly, so updates need no compilation. After changing Herdr bindings run `herdr server reload-config`; after changing tmux options reload the tmux plugin. Run `tests/run.sh` and `emacs --batch -Q -L emacs -l emacs/edger.el -l tests/edger-test.el -f ert-run-tests-batch-and-exit` for focused checks.

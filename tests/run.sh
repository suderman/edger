#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; if [[ -n ${server:-} ]]; then PATH=${system_path:-$PATH} tmux -L "$server" kill-server 2>/dev/null || :; fi' EXIT
export EDGER_TEST_LOG="$tmp/log"

mkdir -p "$tmp/bin"
cat > "$tmp/bin/herdr" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$EDGER_TEST_LOG"
case "$1 $2" in
  'pane process-info')
    printf '{"result":{"process_info":{"foreground_processes":[{"name":".emacsclient-wr","argv":["%s"]}]}}}\n' "${EDGER_TEST_PROCESS:-/bin/bash}" ;;
  'pane focus') printf '{"result":{"focus":{"changed":%s}}}\n' "${EDGER_TEST_MOVED:-false}" ;;
  'pane current') printf '{"result":{"pane":{"workspace_id":"%s","tab_id":"%s"}}}\n' "${EDGER_TEST_WORKSPACE:-w1}" "${EDGER_TEST_TAB:-t2}" ;;
  'pane layout')
    case ${EDGER_TEST_AXIS_SPLIT:-both} in
      horizontal) x=0; y=20 ;; vertical) x=40; y=0 ;; both) x=40; y=20 ;;
      *) x=; y= ;;
    esac
    if [[ -n $x ]]; then
      printf '{"result":{"layout":{"panes":[{"rect":{"x":0,"y":0}},{"rect":{"x":%s,"y":%s}}]}}}\n' "$x" "$y"
    else
      printf '{"result":{"layout":{"panes":[{"rect":{"x":0,"y":0}}]}}}\n'
    fi ;;
  'tab list') printf '{"result":{"tabs":[{"tab_id":"t1","number":1},{"tab_id":"t2","number":2},{"tab_id":"t3","number":3}]}}\n' ;;
  'workspace list') if [[ ${EDGER_TEST_ONLY_SESSION:-0} == 1 ]]; then printf '{"result":{"workspaces":[{"workspace_id":"w1"}]}}\n'; else printf '{"result":{"workspaces":[{"workspace_id":"w1","number":1},{"workspace_id":"w2","number":2},{"workspace_id":"w3","number":3}]}}\n'; fi ;;
  'workspace get') printf '{"result":{"workspace":{"pane_count":%s}}}\n' "${EDGER_TEST_PANES:-2}" ;;
  *) echo '{}' ;;
esac
SH
cat > "$tmp/bin/tmux" <<'SH'
#!/usr/bin/env bash
if [[ $1 != show-option && $1 != set-option ]]; then printf '%s\n' "$*" >> "$EDGER_TEST_LOG"; fi
case "$1" in
  display-message)
    case "${*: -1}" in
      '#{pane_tty}') echo /dev/null ;;
      '#{pane_at_left}'|'#{pane_at_right}'|'#{pane_at_top}'|'#{pane_at_bottom}') echo "${EDGER_TEST_EDGE:-1}" ;;
      '#{window_id}') echo "${EDGER_TEST_WINDOW:-@1}" ;;
      '#{session_id}') echo "${EDGER_TEST_SESSION:-\$1}" ;;
      '#{session_windows}'|'#{window_panes}') echo "${EDGER_TEST_PANES:-2}" ;;
      *) echo %1 ;;
    esac ;;
  list-panes)
    case ${EDGER_TEST_AXIS_SPLIT:-both} in
      horizontal) printf '0 0\n0 20\n' ;; vertical) printf '0 0\n40 0\n' ;;
      both) printf '0 0\n40 20\n' ;; *) printf '0 0\n' ;;
    esac ;;
  list-windows) printf '@1\n@2\n@3\n' ;;
  list-sessions) if [[ ${EDGER_TEST_ONLY_SESSION:-0} == 1 ]]; then printf '$1\n'; else printf '$1\n$2\n$3\n'; fi ;;
esac
SH
cat > "$tmp/bin/ps" <<'SH'
#!/usr/bin/env bash
printf 'Ss+ nvim /nix/store/hash/bin/nvim file\n'
SH
chmod +x "$tmp/bin/"*
system_path=$PATH
export PATH="$tmp/bin:$PATH" HERDR_BIN_PATH="$tmp/bin/herdr" TMUX_BIN_PATH="$tmp/bin/tmux" EDGER_BACKEND=herdr HERDR_PANE_ID=p1
export EDGER_STATE_DIR="$tmp/state" EDGER_TEST_NOW_US=1000000000
edger="$root/bin/edger"
assert_log() { grep -Fx -- "$1" "$EDGER_TEST_LOG" >/dev/null || { echo "Missing: $1" >&2; cat "$EDGER_TEST_LOG" >&2; exit 1; }; }
assert_absent() { if grep -q -- "$1" "$EDGER_TEST_LOG"; then echo "Unexpected: $1" >&2; exit 1; fi; }
reset_log() { : > "$EDGER_TEST_LOG"; rm -rf "$EDGER_STATE_DIR"; clock=1000000000; }
press() { EDGER_TEST_NOW_US=$clock "$edger" cross "$@"; clock=$((clock + 200000)); }

if "$edger" diagonal 2>/dev/null; then echo 'invalid direction accepted' >&2; exit 1; fi
reset_log
EDGER_TEST_PROCESS=/bin/emacsclient "$edger" left alt+h
assert_log 'pane send-keys p1 alt+h'
assert_absent 'pane focus'
reset_log
EDGER_TEST_PROCESS=/bin/nvim "$edger" down
assert_log 'pane send-keys p1 ctrl+alt+j'
reset_log
EDGER_TEST_PROCESS=/bin/bash EDGER_TEST_MOVED=true "$edger" down
assert_log 'pane focus --direction down --pane p1'
assert_absent 'workspace list'
reset_log
press right
assert_log 'pane focus --direction right --pane p1'
assert_absent 'notification show'
assert_absent 'tab focus'
press right
assert_log 'tab focus t3'
reset_log
press left
assert_absent 'tab focus'
press left
assert_log 'tab focus t1'
reset_log
press down
assert_absent 'workspace focus'
press down
assert_log 'workspace focus w2'
reset_log
EDGER_TEST_WORKSPACE=w2 press up
EDGER_TEST_WORKSPACE=w2 press up
assert_log 'workspace focus w1'
reset_log
EDGER_TEST_WORKSPACE=w2 press down
EDGER_TEST_WORKSPACE=w2 press down
assert_log 'workspace focus w3'
reset_log
EDGER_TEST_TAB=t1 press left
EDGER_TEST_TAB=t1 press left
assert_absent 'tab create'
assert_absent 'tab focus'
assert_absent 'notification show'
reset_log
EDGER_TEST_WORKSPACE=w1 press up
EDGER_TEST_WORKSPACE=w1 press up
assert_absent 'workspace create'
assert_absent 'workspace focus'
reset_log
EDGER_TEST_TAB=t3 press right
assert_absent 'tab create'
EDGER_TEST_TAB=t3 press right
assert_log 'tab create --workspace w1 --focus'
assert_absent 'notification show'
reset_log
EDGER_TEST_WORKSPACE=w3 press down
assert_absent 'workspace create'
EDGER_TEST_WORKSPACE=w3 press down
assert_log 'workspace create --focus'
reset_log
EDGER_TEST_AXIS_SPLIT=0 press right
assert_log 'tab focus t3'
assert_absent 'notification show'
reset_log
EDGER_TEST_AXIS_SPLIT=horizontal press right
assert_log 'tab focus t3'
reset_log
EDGER_TEST_AXIS_SPLIT=vertical press down
assert_log 'workspace focus w2'
reset_log
EDGER_TEST_AXIS_SPLIT=0 EDGER_TEST_TAB=t3 press right
assert_log 'tab create --workspace w1 --focus'
reset_log
EDGER_TEST_AXIS_SPLIT=0 EDGER_TEST_WORKSPACE=w3 press down
assert_log 'workspace create --focus'
reset_log
EDGER_TEST_AXIS_SPLIT=0 press right split
assert_absent 'tab focus'
EDGER_TEST_AXIS_SPLIT=0 press right split
assert_log 'tab focus t3'
reset_log
press right
clock=$((clock + 800000))
press right
assert_absent 'tab focus'
reset_log
EDGER_BOUNDARY_TIMEOUT_MS=150 press right
EDGER_BOUNDARY_TIMEOUT_MS=150 press right
assert_absent 'tab focus'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 press right
assert_absent 'display-message -d'
reset_log
press right
press down
press down
assert_log 'workspace focus w2'
assert_absent 'tab focus'
reset_log
EDGER_TEST_TAB=t3 press right
EDGER_TEST_TAB=t3 press right
clock=$((clock - 170000))
EDGER_TEST_TAB=t3 press right
clock=$((clock - 170000))
EDGER_TEST_TAB=t3 press right
[[ $(grep -Fc 'tab create' "$EDGER_TEST_LOG") == 1 ]] || { echo 'Repeat created another tab' >&2; exit 1; }
reset_log
press right
EDGER_TEST_MOVED=true press right
press right
assert_absent 'tab focus'
reset_log
press right
"$edger" clear
press right
assert_absent 'tab focus'
reset_log
press right
"$edger" cross resize left
press right
assert_absent 'tab focus'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" left C-M-h
assert_log 'send-keys -t %1 C-M-h'
assert_absent 'select-pane'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_EDGE=0 "$edger" cross right
assert_log 'select-pane -t %1 -R'
assert_absent 'list-windows'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 press right
assert_absent 'select-window'
EDGER_BACKEND=tmux TMUX_PANE=%1 press right
assert_log 'select-window -t @2'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@2 press left
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@2 press left
assert_log 'select-window -t @1'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@2 press right
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@2 press right
assert_log 'select-window -t @3'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@1 press left
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@1 press left
assert_absent 'select-window'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@3 press right
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_WINDOW=@3 press right
assert_log 'new-window -a -t @3 -c #{pane_current_path}'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_AXIS_SPLIT=0 press right
assert_log 'select-window -t @2'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_AXIS_SPLIT=horizontal press right
assert_log 'select-window -t @2'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_AXIS_SPLIT=vertical EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty press down
assert_log "switch-client -c /dev/tty -t \$2"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_AXIS_SPLIT=0 EDGER_TEST_WINDOW=@3 press right
assert_log 'new-window -a -t @3 -c #{pane_current_path}'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross up
assert_absent 'switch-client'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty press down
assert_absent 'switch-client'
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty press down
session="\$2"
assert_log "switch-client -c /dev/tty -t $session"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty "$edger" cross up
assert_absent 'switch-client'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$2 press up
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$2 press up
assert_log "switch-client -c /dev/tty -t \$1"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$2 press down
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$2 press down
assert_log "switch-client -c /dev/tty -t \$3"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$3 press down
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_SESSION=\$3 press down
assert_log 'new-session -d -P -F #{session_id} -c %1'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_AXIS_SPLIT=0 press down
assert_log "switch-client -c /dev/tty -t \$2"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TMUX_SESSIONS=1 EDGER_TMUX_CLIENT_TTY=/dev/tty EDGER_TEST_AXIS_SPLIT=0 EDGER_TEST_SESSION=\$3 press down
assert_log 'new-session -d -P -F #{session_id} -c %1'
reset_log
EDGER_TEST_PROCESS=/bin/nvim "$edger" resize left alt+shift+h
assert_log 'pane send-keys p1 alt+shift+h'
reset_log
"$edger" cross resize left
assert_log 'pane resize --direction left --pane p1'
reset_log
EDGER_TEST_PROCESS=/bin/nvim "$edger" tab
assert_log 'pane send-keys p1 ctrl+alt+t'
reset_log
EDGER_TEST_PROCESS=/bin/bash "$edger" tab
assert_log 'tab create --workspace w1 --focus'
reset_log
EDGER_TEST_PROCESS=/bin/bash "$edger" horizontal
assert_log 'pane split --pane p1 --direction down --focus'
reset_log
EDGER_TEST_PROCESS=/bin/bash "$edger" vertical
assert_log 'pane split --pane p1 --direction right --focus'
reset_log
"$edger" cross close
assert_log 'pane close p1'
reset_log
EDGER_TEST_PANES=1 "$edger" cross close
assert_log 'pane close p1'
reset_log
EDGER_TEST_PANES=1 EDGER_TEST_ONLY_SESSION=1 "$edger" cross close
assert_absent 'pane close'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" resize right M-L
assert_log 'send-keys -t %1 M-L'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross resize right
assert_log 'resize-pane -t %1 -R 5'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross tab
assert_log "new-window -t \$1: -c #{pane_current_path}"
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross horizontal
assert_log 'split-window -t %1 -c #{pane_current_path}'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross vertical
assert_log 'split-window -h -t %1 -c #{pane_current_path}'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 "$edger" cross close
assert_log 'kill-pane -t %1'
reset_log
EDGER_BACKEND=tmux TMUX_PANE=%1 EDGER_TEST_ONLY_SESSION=1 EDGER_TEST_PANES=1 "$edger" cross close
assert_absent 'kill-pane'
reset_log
TMUX_BIN_PATH="$tmp/bin/missing-tmux" EDGER_BACKEND=herdr press left
TMUX_BIN_PATH="$tmp/bin/missing-tmux" EDGER_BACKEND=herdr press left
assert_log 'tab focus t1'
reset_log
HERDR_BIN_PATH="$tmp/bin/missing-herdr" EDGER_BACKEND=tmux TMUX_PANE=%1 press right
HERDR_BIN_PATH="$tmp/bin/missing-herdr" EDGER_BACKEND=tmux TMUX_PANE=%1 press right
assert_log 'select-window -t @2'
if HERDR_BIN_PATH="$tmp/bin/missing-herdr" EDGER_BACKEND=herdr "$edger" cross left > "$tmp/error" 2>&1; then
  echo 'Missing Herdr executable accepted' >&2; exit 1
fi
grep -F 'Herdr executable not found' "$tmp/error" >/dev/null
if TMUX_BIN_PATH="$tmp/bin/missing-tmux" EDGER_BACKEND=tmux "$edger" cross left > "$tmp/error" 2>&1; then
  echo 'Missing tmux executable accepted' >&2; exit 1
fi
grep -F 'tmux executable not found' "$tmp/error" >/dev/null
cat > "$tmp/bin/edger" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$EDGER_TEST_LOG"
SH
chmod +x "$tmp/bin/edger"
export EDGER_TEST_BIN="$tmp/bin/edger"
reset_log
(cd "$root" && nvim --headless --clean -u NONE -l tests/neovim.lua)
# Load the actual tmux plugin on an isolated server, not the user's session.
server="edger-test-$$"
PATH=$system_path tmux -L "$server" -f /dev/null new-session -d -s edger-test
socket=$(PATH=$system_path tmux -L "$server" display-message -p '#{socket_path}')
PATH=$system_path TMUX="$socket,0,0" bash "$root/edger.tmux"
PATH=$system_path tmux -L "$server" list-keys -T root | grep -F 'edger resize left C-M-H' >/dev/null
PATH=$system_path tmux -L "$server" list-keys -T root | grep -F 'edger close C-M-w' >/dev/null
PATH=$system_path tmux -L "$server" set-option -g @edger-close-key q
PATH=$system_path TMUX="$socket,0,0" bash "$root/edger.tmux"
PATH=$system_path tmux -L "$server" list-keys -T root | grep -F 'edger close C-M-q' >/dev/null
PATH=$system_path tmux -L "$server" set-option -g @edger-sessions on
PATH=$system_path TMUX="$socket,0,0" bash "$root/edger.tmux"
PATH=$system_path tmux -L "$server" list-keys -T root C-M-j | grep -F 'EDGER_TMUX_SESSIONS=1' >/dev/null
PATH=$system_path tmux -L "$server" kill-server
echo 'edger routing, Neovim, and tmux checks passed'

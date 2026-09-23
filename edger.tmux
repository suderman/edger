#!/usr/bin/env bash
# TPM entry point. Set @edger-key to M for Alt-hjkl or @edger-mappings to off.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
modifier=$(tmux show-option -gqv @edger-key)
modifier=${modifier:-C-M}
[[ $(tmux show-option -gqv @edger-mappings) == off ]] && exit 0
sessions=0
[[ $(tmux show-option -gqv @edger-sessions) == on ]] && sessions=1
for spec in 'h left' 'j down' 'k up' 'l right'; do
  read -r letter direction <<< "$spec"
  key="$modifier-$letter"
  # tmux formats resolve the pane and client at keypress time.
  printf -v command 'TMUX_PANE="#{pane_id}" EDGER_TMUX_CLIENT_TTY="#{client_tty}" EDGER_BACKEND=tmux EDGER_TMUX_SESSIONS=%q %q %q %q' \
    "$sessions" "$root/bin/edger" "$direction" "$key"
  tmux bind-key -n "$key" run-shell "$command"
done

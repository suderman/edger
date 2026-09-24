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
for spec in 'horizontal u' 'vertical i' 'close w'; do
  read -r action default <<< "$spec"
  letter=$(tmux show-option -gqv "@edger-$action-key")
  key="$modifier-${letter:-$default}"
  printf -v command 'TMUX_PANE="#{pane_id}" EDGER_BACKEND=tmux %q %q %q' \
    "$root/bin/edger" "$action" "$key"
  tmux bind-key -n "$key" run-shell "$command"
done
for spec in 'h left' 'j down' 'k up' 'l right'; do
  read -r letter direction <<< "$spec"
  key="$modifier-${letter^^}"
  printf -v command 'TMUX_PANE="#{pane_id}" EDGER_BACKEND=tmux %q resize %q %q' \
    "$root/bin/edger" "$direction" "$key"
  tmux bind-key -n "$key" run-shell "$command"
done

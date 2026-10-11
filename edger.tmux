#!/usr/bin/env bash
# TPM entry point. Set @edger-key to C or C-M to change the modifier.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
modifier=$(tmux show-option -gqv @edger-key)
modifier=${modifier:-M}
[[ $(tmux show-option -gqv @edger-mappings) == off ]] && exit 0
printf -v edger %q "$root/bin/edger"

# tmux settles common presses itself, since each script run starts sh and bash
# (hundreds of milliseconds on Android). An editor in the foreground gets the
# key. A shell gets the plain tmux action unless the pane is zoomed or at the
# edge. Anything else, such as an editor under git commit, runs the script.
editor='#{m/ri:^(emacs|emacsclient|nvim|vim|vi|view|gvim|nvimdiff|vimdiff)$,#{pane_current_command}}'
shell='#{m/ri:^-?(zsh|bash|fish)$,#{pane_current_command}}'

# Print a binding: KEY SHELL_CONDITION SHELL_COMMAND SCRIPT_ARGS [ENV]. With no
# shell command, everything but an editor runs the script. tmux keeps
# single-quoted text as is, so sh sees the %q escapes.
bind() {
  local key=$1 condition=$2 fast=$3 args=$4 env=${5-} script
  script="run-shell '${env}TMUX_PANE=#{pane_id} EDGER_BACKEND=tmux $edger $args $key'"
  [[ -z $fast ]] || script="if-shell -F \"$condition\" { $fast } { $script }"
  cat <<EOF
bind-key -n $key if-shell -F "$editor" {
  send-keys $key
} {
  $script
}
EOF
}

{
  for spec in 'h left L pane_at_left' 'j down D pane_at_bottom' 'k up U pane_at_top' 'l right R pane_at_right'; do
    read -r letter direction flag edge <<< "$spec"
    # tmux formats resolve the pane and client at keypress time.
    bind "$modifier-$letter" "#{&&:$shell,#{&&:#{!=:#{window_zoomed_flag},1},#{!=:#{$edge},1}}}" \
      "select-pane -$flag" "$direction" 'EDGER_TMUX_CLIENT_TTY=#{client_tty} '
  done
  for spec in 'horizontal u' 'vertical i' 'close w'; do
    read -r action default <<< "$spec"
    letter=$(tmux show-option -gqv "@edger-$action-key")
    case $action in
      horizontal) fast="split-window -c '#{pane_current_path}'" ;;
      vertical) fast="split-window -h -c '#{pane_current_path}'" ;;
      # Closing keeps the last pane of the last session, which the script checks.
      close) fast= ;;
    esac
    bind "$modifier-${letter:-$default}" "$shell" "$fast" "$action"
  done
  for spec in 'h left L 5' 'j down D 3' 'k up U 3' 'l right R 5'; do
    read -r letter direction flag amount <<< "$spec"
    bind "$modifier-${letter^^}" "$shell" "resize-pane -$flag $amount" "resize $direction"
  done
} | tmux source-file -

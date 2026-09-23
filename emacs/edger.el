;;; edger.el --- Navigate editor and multiplexer edges -*- lexical-binding: t; -*-

;; Author: Jon Suderman
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: convenience, terminals
;; URL: https://github.com/suderman/edger

;;; Commentary:
;; Bind edger-left/down/up/right in your own keymaps.  A terminal Emacs frame
;; crosses into Herdr or tmux when no eligible Emacs window exists that way.

;;; Code:

(require 'windmove)

(defgroup edger nil "Directional window and pane navigation." :group 'windows)

(defcustom edger-executable
  (expand-file-name "../bin/edger" (file-name-directory load-file-name))
  "Path to the edger executable.  Defaults to the copy in this checkout."
  :type 'string
  :group 'edger)

(defun edger--navigate (direction)
  "Navigate DIRECTION locally, then cross a terminal multiplexer edge."
  (let* ((frame (selected-frame))
         (terminal (not (display-graphic-p frame)))
         (herdr-pane (and terminal
                          (or (frame-parameter frame 'edger-herdr-pane-id)
                              (unless (daemonp) (getenv "HERDR_PANE_ID")))))
         (tmux-pane (and terminal
                         (or (frame-parameter frame 'edger-tmux-pane-id)
                             (unless (daemonp) (getenv "TMUX_PANE")))))
         (neighbor (windmove-find-other-window direction)))
    (if (or (and neighbor
                 (or (not (window-minibuffer-p neighbor))
                     (active-minibuffer-window)))
            (not (or herdr-pane tmux-pane)))
        (windmove-do-window-select direction nil nil this-command)
      (let* ((socket (frame-parameter frame 'edger-herdr-socket-path))
             (tmux (frame-parameter frame 'edger-tmux-socket))
             (process-environment
              (append (if tmux-pane
                          (list "EDGER_BACKEND=tmux" (concat "TMUX_PANE=" tmux-pane)
                                (concat "TMUX=" (or tmux (getenv "TMUX") "")))
                        (list "EDGER_BACKEND=herdr" (concat "HERDR_PANE_ID=" herdr-pane)
                              (concat "HERDR_SOCKET_PATH=" (or socket (getenv "HERDR_SOCKET_PATH") ""))))
                      process-environment)))
        (unless (eq 0 (call-process edger-executable nil nil nil "cross" (symbol-name direction)))
          (user-error "Edger could not navigate %s" direction))))))

(defun edger-left () "Navigate left." (interactive) (edger--navigate 'left))
(defun edger-down () "Navigate down." (interactive) (edger--navigate 'down))
(defun edger-up () "Navigate up." (interactive) (edger--navigate 'up))
(defun edger-right () "Navigate right." (interactive) (edger--navigate 'right))

(provide 'edger)
;;; edger.el ends here

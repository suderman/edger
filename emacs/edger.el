;;; edger.el --- Navigate editor and multiplexer edges -*- lexical-binding: t; -*-

;; Author: Jon Suderman
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: convenience, terminals
;; URL: https://github.com/suderman/edger

;;; Commentary:
;; Bind navigation and window commands in your own keymaps.  Terminal Emacs
;; crosses into Herdr or tmux when no eligible Emacs window exists.

;;; Code:

(require 'windmove)
(require 'tab-bar)
(require 'cl-lib)

(defgroup edger nil "Directional window and pane navigation." :group 'windows)

(defcustom edger-executable
  (expand-file-name "../bin/edger" (file-name-directory load-file-name))
  "Path to the edger executable.  Defaults to the copy in this checkout."
  :type 'string
  :group 'edger)

(defun edger--pane-context ()
  "Return the selected terminal frame's backend and pane, if available."
  (unless (display-graphic-p)
    (let ((frame (selected-frame)))
      (cond
       ((or (frame-parameter frame 'edger-tmux-pane-id)
            (unless (daemonp) (getenv "TMUX_PANE"))) 'tmux)
       ((or (frame-parameter frame 'edger-herdr-pane-id)
            (unless (daemonp) (getenv "HERDR_PANE_ID"))) 'herdr)))))

(defun edger--cross (&rest args)
  "Call the multiplexer with ARGS for the selected terminal frame."
  (let* ((frame (selected-frame))
         (backend (edger--pane-context))
         (pane (pcase backend
                 ('tmux (or (frame-parameter frame 'edger-tmux-pane-id) (getenv "TMUX_PANE")))
                 ('herdr (or (frame-parameter frame 'edger-herdr-pane-id) (getenv "HERDR_PANE_ID")))))
         (socket (pcase backend
                   ('tmux (or (frame-parameter frame 'edger-tmux-socket) (getenv "TMUX")))
                   ('herdr (or (frame-parameter frame 'edger-herdr-socket-path) (getenv "HERDR_SOCKET_PATH")))))
         (process-environment
          (append (pcase backend
                    ('tmux (list "EDGER_BACKEND=tmux" (concat "TMUX_PANE=" pane)
                                 (concat "TMUX=" (or socket ""))))
                    ('herdr (list "EDGER_BACKEND=herdr" (concat "HERDR_PANE_ID=" pane)
                                  (concat "HERDR_SOCKET_PATH=" (or socket "")))))
                  process-environment)))
    (when backend
      (unless (eq 0 (apply #'call-process edger-executable nil nil nil "cross" args))
        (user-error "Edger could not %s" (mapconcat #'identity args " "))))))

(defun edger--clear ()
  "Clear a pending multiplexer boundary after local navigation."
  (when (edger--pane-context) (edger--cross "clear")))

(defun edger--navigate (direction)
  "Navigate DIRECTION locally, then confirm a terminal multiplexer edge."
  (let ((neighbor (windmove-find-other-window direction)))
    (if (or (and neighbor
                 (or (not (window-minibuffer-p neighbor))
                     (active-minibuffer-window)))
            (not (edger--pane-context)))
        (progn (windmove-do-window-select direction nil nil this-command)
               (edger--clear))
      (let* ((axis (if (memq direction '(left right)) 0 1))
             (position (nth axis (window-edges)))
             (split (cl-some (lambda (window)
                               (/= position (nth axis (window-edges window))))
                             (window-list nil 'nomini))))
        (if split
            (edger--cross (symbol-name direction) "split")
          (edger--cross (symbol-name direction)))))))

(defun edger--resize (direction)
  "Move a window divider in DIRECTION, or resize the multiplexer split."
  (let* ((horizontal (memq direction '(left right)))
         (forward (if horizontal 'right 'below))
         (backward (if horizontal 'left 'above))
         (delta (* (if (memq direction '(left up)) -1 1)
                   (if horizontal 5 3)))
         (window (selected-window))
         (next (window-in-direction forward window))
         (previous (window-in-direction backward window)))
    (cond
     (next (adjust-window-trailing-edge window delta horizontal) (edger--clear))
     (previous (adjust-window-trailing-edge previous delta horizontal) (edger--clear))
     (t (edger--cross "resize" (symbol-name direction))))))

(defun edger-resize-left () "Resize left." (interactive) (edger--resize 'left))
(defun edger-resize-down () "Resize down." (interactive) (edger--resize 'down))
(defun edger-resize-up () "Resize up." (interactive) (edger--resize 'up))
(defun edger-resize-right () "Resize right." (interactive) (edger--resize 'right))

(defun edger-tab () "Open an Emacs tab." (interactive) (tab-new) (edger--clear))
(defun edger-horizontal () "Split below and select the new window." (interactive)
  (select-window (split-window-below)) (edger--clear))
(defun edger-vertical () "Split right and select the new window." (interactive)
  (select-window (split-window-right)) (edger--clear))
(defun edger-close () "Close a window, or its enclosing multiplexer pane."
  (interactive)
  (if (one-window-p t)
      (if (edger--pane-context)
          (edger--cross "close")
        (when (> (length (tab-bar-tabs)) 1) (tab-bar-close-tab)))
    (delete-window)
    (edger--clear)))

(defun edger-left () "Navigate left." (interactive) (edger--navigate 'left))
(defun edger-down () "Navigate down." (interactive) (edger--navigate 'down))
(defun edger-up () "Navigate up." (interactive) (edger--navigate 'up))
(defun edger-right () "Navigate right." (interactive) (edger--navigate 'right))

(provide 'edger)
;;; edger.el ends here

;;; edger.el --- Navigate editor and multiplexer edges -*- lexical-binding: t; -*-

;; Author: Jon Suderman
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: convenience, terminals
;; URL: https://github.com/suderman/edger

;;; Commentary:
;; `edger-mode' binds Alt navigation, resize, split, and close keys.
;; Terminal Emacs crosses into Herdr or tmux at a window edge.

;;; Code:

(require 'windmove)
(require 'tab-bar)

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
  "Navigate DIRECTION locally, then cross a terminal multiplexer edge."
  (let ((neighbor (windmove-find-other-window direction)))
    (if (or (and neighbor
                 (or (not (window-minibuffer-p neighbor))
                     (active-minibuffer-window)))
            (not (edger--pane-context)))
        (progn (windmove-do-window-select direction nil nil this-command)
               (edger--clear))
      (edger--cross (symbol-name direction)))))

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

(defun edger-horizontal () "Split below and select the new window." (interactive)
  (select-window (split-window-below)) (edger--clear))
(defun edger-vertical () "Split right and select the new window." (interactive)
  (select-window (split-window-right)) (edger--clear))
(defun edger-close () "Close a window, then an editor tab, then its multiplexer pane."
  (interactive)
  (cond
   ((not (one-window-p t)) (delete-window) (edger--clear))
   ((> (length (tab-bar-tabs)) 1) (tab-bar-close-tab) (edger--clear))
   ((edger--pane-context) (edger--cross "close"))))

(defun edger-left () "Navigate left." (interactive) (edger--navigate 'left))
(defun edger-down () "Navigate down." (interactive) (edger--navigate 'down))
(defun edger-up () "Navigate up." (interactive) (edger--navigate 'up))
(defun edger-right () "Navigate right." (interactive) (edger--navigate 'right))

(defvar edger-mode-map (make-sparse-keymap)
  "Keymap for `edger-mode'.")

;;;###autoload
(define-minor-mode edger-mode
  "Bind Edger navigation and window actions globally."
  :global t
  :keymap edger-mode-map)

(defun edger-setup (&optional modifier horizontal vertical close)
  "Bind Edger keys with MODIFIER and HORIZONTAL, VERTICAL, CLOSE letters.
MODIFIER uses Emacs key syntax and defaults to \"M\" (Alt); \"C\" and
\"C-M\" are also supported.  The action letters default to u, i, w."
  (let ((modifier (or modifier "M")))
    (unless (member modifier '("M" "C" "C-M"))
      (user-error "Edger modifier must be M, C, or C-M"))
    (setcdr edger-mode-map nil)
    (dolist (binding '(("h" edger-left edger-resize-left)
                       ("j" edger-down edger-resize-down)
                       ("k" edger-up edger-resize-up)
                       ("l" edger-right edger-resize-right)))
      (keymap-set edger-mode-map (format "%s-%s" modifier (nth 0 binding)) (nth 1 binding))
      (keymap-set edger-mode-map
                  (if (equal modifier "M")
                      (format "M-%s" (upcase (nth 0 binding)))
                    (format "%s-S-%s" modifier (nth 0 binding)))
                  (nth 2 binding)))
    (dolist (binding (list (cons (or horizontal "u") #'edger-horizontal)
                           (cons (or vertical "i") #'edger-vertical)
                           (cons (or close "w") #'edger-close)))
      (keymap-set edger-mode-map (format "%s-%s" modifier (car binding)) (cdr binding)))
    (edger-mode 1)))

(edger-setup)

(provide 'edger)
;;; edger.el ends here

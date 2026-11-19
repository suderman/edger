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

(require 'seq)
(require 'windmove)
(require 'tab-bar)

(defgroup edger nil "Directional window and pane navigation." :group 'windows)

(defcustom edger-executable
  (expand-file-name "../bin/edger" (file-name-directory load-file-name))
  "Path to the edger executable.  Defaults to the copy in this checkout."
  :type 'string
  :group 'edger)

(defcustom edger-hc-executable "hc"
  "Herdr Core's command line, used in Herdr app terminals."
  :type 'string
  :group 'edger)

(defun edger--client-getenv (variable)
  "Return VARIABLE from the selected frame's client environment.
A daemon's terminal frames carry the environment of their emacsclient."
  (if (daemonp) (getenv variable (selected-frame)) (getenv variable)))

(defun edger--hc-terminal ()
  "Return the Herdr Core terminal of the selected frame, outside tmux and Herdr."
  (or (frame-parameter (selected-frame) 'edger-hc-terminal-id)
      (and (not (edger--client-getenv "TMUX"))
           (not (edger--client-getenv "HERDR_PANE_ID"))
           (edger--client-getenv "HC_TERMINAL_ID"))))

(defun edger--pane-context ()
  "Return the selected terminal frame's backend and pane, if available."
  (unless (display-graphic-p)
    (let ((frame (selected-frame)))
      (cond
       ((or (frame-parameter frame 'edger-tmux-pane-id)
            (unless (daemonp) (getenv "TMUX_PANE"))) 'tmux)
       ((or (frame-parameter frame 'edger-herdr-pane-id)
            (unless (daemonp) (getenv "HERDR_PANE_ID"))) 'herdr)
       ((edger--hc-terminal) 'app)))))

(defvar edger--hc-connections nil
  "Open `hc connect' processes, by Core session (nil: the default).")

(defun edger--hc-connection ()
  "Return a live `hc connect' for the selected frame's Core session, or nil."
  (let* ((session (edger--client-getenv "HC_SESSION"))
         (process (alist-get session edger--hc-connections nil nil #'equal)))
    (if (process-live-p process)
        process
      (condition-case nil
          (let* ((process-environment
                  (if session (cons (concat "HC_SESSION=" session) process-environment)
                    process-environment))
                 (process (make-process :name "edger-hc" :noquery t :connection-type 'pipe
                                        :command (list edger-hc-executable "connect")
                                        :filter #'ignore :sentinel #'ignore)))
            (setf (alist-get session edger--hc-connections nil nil #'equal) process))
        (error nil)))))

(defvar edger--hc-requests 0 "Requests sent to Herdr Core, also used as a nonce.")

(defun edger--hc-label (terminal key value)
  "Set label KEY to VALUE on Core TERMINAL; return non-nil once sent.
One long-lived `hc connect' carries every label, so no process starts."
  (when-let* ((process (edger--hc-connection)))
    (setq edger--hc-requests (1+ edger--hc-requests))
    (condition-case nil
        (progn
          (process-send-string
           process
           (concat (json-serialize
                    `((jsonrpc . "2.0") (id . ,edger--hc-requests) (method . "terminal.label")
                      (params . ((terminal . ,terminal) (labels . ((,(intern key) . ,value)))))))
                   "\n"))
          t)
      (error nil))))

(defun edger--cross (&rest args)
  "Call the multiplexer with ARGS for the selected terminal frame."
  (if (and (eq (edger--pane-context) 'app)
           (or (equal args '("clear"))
               ;; The Herdr app's Edger mod acts on this label (see bin/edger).
               (edger--hc-label (edger--hc-terminal) "edger"
                                (format "%s:%s.%d" (mapconcat #'identity args "-")
                                        (format-time-string "%s%6N") edger--hc-requests))))
      nil
    (apply #'edger--call args)))

(defun edger--call (&rest args)
  "Run the edger executable with ARGS for the selected terminal frame."
  (let* ((frame (selected-frame))
         (backend (edger--pane-context))
         (pane (pcase backend
                 ('tmux (or (frame-parameter frame 'edger-tmux-pane-id) (getenv "TMUX_PANE")))
                 ('herdr (or (frame-parameter frame 'edger-herdr-pane-id) (getenv "HERDR_PANE_ID")))
                 ('app (edger--hc-terminal))))
         (socket (pcase backend
                   ('tmux (or (frame-parameter frame 'edger-tmux-socket) (getenv "TMUX")))
                   ('herdr (or (frame-parameter frame 'edger-herdr-socket-path) (getenv "HERDR_SOCKET_PATH")))))
         (process-environment
          (append (pcase backend
                    ('tmux (list "EDGER_BACKEND=tmux" (concat "TMUX_PANE=" pane)
                                 (concat "TMUX=" (or socket ""))))
                    ('herdr (list "EDGER_BACKEND=herdr" (concat "HERDR_PANE_ID=" pane)
                                  (concat "HERDR_SOCKET_PATH=" (or socket ""))))
                    ;; A Core session other than the default comes from the client.
                    ('app (append (list "EDGER_BACKEND=app" (concat "HC_TERMINAL_ID=" pane))
                                  (let ((session (edger--client-getenv "HC_SESSION")))
                                    (and session (list (concat "HC_SESSION=" session)))))))
                  process-environment)))
    (when backend
      (unless (eq 0 (apply #'call-process edger-executable nil nil nil "cross" args))
        (user-error "Edger could not %s" (mapconcat #'identity args " "))))))

(defun edger--clear ()
  "Clear a pending multiplexer boundary after local navigation."
  (when (edger--pane-context) (edger--cross "clear")))

(defun edger--neighbor (direction)
  "Return the window that navigating DIRECTION selects, if any."
  (let ((neighbor (windmove-find-other-window direction)))
    (and neighbor
         (or (not (window-minibuffer-p neighbor)) (active-minibuffer-window))
         neighbor)))

(defun edger--navigate (direction)
  "Navigate DIRECTION locally, then cross a terminal multiplexer edge."
  (if (or (edger--neighbor direction) (not (edger--pane-context)))
      (progn (windmove-do-window-select direction nil nil this-command)
             (edger--clear))
    (edger--cross (symbol-name direction))))

(defun edger--resize-windows (direction)
  "Return (NEXT . PREVIOUS): the windows after and before on DIRECTION's axis."
  (let* ((horizontal (memq direction '(left right)))
         (window (selected-window))
         ;; Side windows can forbid focus cycling without forbidding resizing.
         (find (lambda (dir)
                 (or (window-in-direction dir window)
                     (let ((side (window-in-direction dir window t)))
                       (and side (window-parameter side 'window-side) side))))))
    (cons (funcall find (if horizontal 'right 'below))
          (funcall find (if horizontal 'left 'above)))))

(defun edger--resize (direction)
  "Move a window divider in DIRECTION, or resize the multiplexer split."
  (let* ((horizontal (memq direction '(left right)))
         (delta (* (if (memq direction '(left up)) -1 1)
                   (if horizontal 5 3)))
         (window (selected-window))
         (windows (edger--resize-windows direction))
         (next (car windows))
         (previous (cdr windows)))
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
(defun edger--other-frame ()
  "Return another top-level frame on the selected frame's display, if any.
Frames on other terminals, such as other multiplexer panes, do not count."
  (seq-find (lambda (frame)
              (and (not (eq frame (selected-frame)))
                   (not (frame-parent frame))
                   (eq (frame-terminal frame) (frame-terminal))))
            (frame-list)))

(defun edger--close-local-p ()
  "Return non-nil when `edger-close' closes something inside Emacs."
  (or (not (one-window-p t)) (> (length (tab-bar-tabs)) 1) (edger--other-frame)))

(defun edger-close ()
  "Close a window, then an editor tab, then a frame, then its multiplexer pane.
A frame closes only when another frame on its display can take focus."
  (interactive)
  (cond
   ((not (one-window-p t)) (delete-window) (edger--clear))
   ((> (length (tab-bar-tabs)) 1) (tab-bar-close-tab) (edger--clear))
   ((when-let* ((other (edger--other-frame))
                (frame (selected-frame)))
      (select-frame-set-input-focus other)
      (delete-frame frame)
      t))
   ((edger--pane-context) (edger--cross "close"))))

(defun edger-left () "Navigate left." (interactive) (edger--navigate 'left))
(defun edger-down () "Navigate down." (interactive) (edger--navigate 'down))
(defun edger-up () "Navigate up." (interactive) (edger--navigate 'up))
(defun edger-right () "Navigate right." (interactive) (edger--navigate 'right))

(defconst edger--commands
  '(edger-left edger-down edger-up edger-right edger-resize-left edger-resize-down
    edger-resize-up edger-resize-right edger-horizontal edger-vertical edger-close)
  "Commands the Herdr app's Edger mod sends keys for.")

(defun edger--local-keys ()
  "Letters of the Edger keys Emacs handles itself in the selected window.
h/j/k/l: a window that way; H/J/K/L: a divider on that axis; w: something
to close before the pane."
  (concat
   (mapconcat (lambda (d) (if (edger--neighbor (car d)) (cdr d) ""))
              '((left . "h") (down . "j") (up . "k") (right . "l")) "")
   (mapconcat (lambda (d) (let ((w (edger--resize-windows (car d))))
                            (if (or (car w) (cdr w)) (upcase (cdr d)) "")))
              '((left . "h") (down . "j") (up . "k") (right . "l")) "")
   (if (edger--close-local-p) "w" "")))

(defvar edger--published nil
  "Per Core terminal: (KEYS . COUNT), the last keys published and how many
Edger commands ran there.")

(defun edger--publish ()
  "Tell the Herdr app which Edger keys this Emacs handles itself.
The app's Edger mod then moves past Emacs at once, as for a shell, and
sends keys only when Emacs will use them.  The label value is
\"KEYS:COUNT\"; COUNT lets the mod tell when Emacs has caught up with
the keys it sent."
  (ignore-errors
    (when (eq (edger--pane-context) 'app)
      (let* ((terminal (edger--hc-terminal))
             (old (alist-get terminal edger--published nil nil #'equal))
             (count (+ (or (cdr old) 0) (if (memq this-command edger--commands) 1 0)))
             (keys (edger--local-keys)))
        (when (and (or (not (equal keys (car old))) (not (eql count (cdr old))))
                   (edger--hc-label terminal "edger.local" (format "%s:%d" keys count)))
          (setf (alist-get terminal edger--published nil nil #'equal) (cons keys count)))))))

(defvar edger-mode-map (make-sparse-keymap)
  "Keymap for `edger-mode'.")

;;;###autoload
(define-minor-mode edger-mode
  "Bind Edger navigation and window actions globally."
  :global t
  :keymap edger-mode-map
  (if edger-mode
      (add-hook 'post-command-hook #'edger--publish)
    (remove-hook 'post-command-hook #'edger--publish)))

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

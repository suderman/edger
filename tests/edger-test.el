;;; edger-test.el --- Focused editor edge tests -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)
(require 'edger)

(ert-deftest edger-local-then-cross ()
  (save-window-excursion
    (delete-other-windows)
    (let* ((left (selected-window))
           (right (split-window-right))
           (frame (selected-frame))
           calls)
      (unwind-protect
          (progn
            (set-frame-parameter frame 'edger-herdr-pane-id "w1:p2")
            (set-frame-parameter frame 'edger-herdr-socket-path "/tmp/herdr.sock")
            (cl-letf (((symbol-function 'call-process)
                       (lambda (&rest args)
                         (push (list args (getenv "HERDR_SOCKET_PATH")
                                     (getenv "HERDR_PANE_ID")) calls)
                         0)))
              (edger-right)
              (should (eq (selected-window) right))
              (should-not calls)
              (edger-right)
              (should (equal (car calls)
                             '(("edger" nil nil nil "cross" "right")
                               "/tmp/herdr.sock" "w1:p2")))
              (edger-left)
              (should (eq (selected-window) left))))
        (set-frame-parameter frame 'edger-herdr-pane-id nil)
        (set-frame-parameter frame 'edger-herdr-socket-path nil)))))

(ert-deftest edger-graphical-frame-stays-local ()
  (save-window-excursion
    (delete-other-windows)
    (let ((frame (selected-frame)))
      (unwind-protect
          (progn
            (set-frame-parameter frame 'edger-herdr-pane-id "w1:p2")
            (cl-letf (((symbol-function 'display-graphic-p) (lambda (&rest _) t))
                      ((symbol-function 'call-process)
                       (lambda (&rest _) (ert-fail "Unexpected multiplexer call"))))
              (should-error (edger-left))))
        (set-frame-parameter frame 'edger-herdr-pane-id nil)))))

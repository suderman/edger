local M = {}

local directions = { h = "left", j = "down", k = "up", l = "right" }

local function executable(opts)
  if opts.bin then return opts.bin end
  local here = debug.getinfo(1, "S").source:sub(2)
  local local_bin = vim.fn.fnamemodify(here, ":h:h:h") .. "/bin/edger"
  if vim.fn.executable(local_bin) == 1 then return local_bin end
  return "edger"
end

-- A Herdr app terminal: a Core terminal outside tmux and the Herdr TUI.
local function in_app()
  return vim.env.HC_TERMINAL_ID ~= nil and not vim.env.TMUX and not vim.env.TMUX_PANE
    and not vim.env.HERDR_PANE_ID
end

-- One long-lived `hc connect` carries every label, so no process starts.
local hc = { job = nil, requests = 0 }

local function hc_label(opts, key, value)
  if not hc.job then
    local ok, job = pcall(vim.fn.jobstart, { opts.hc or "hc", "connect" }, {
      on_stdout = function() end,
      on_stderr = function() end,
      on_exit = function() hc.job = nil end,
    })
    if not ok or job <= 0 then return false end
    hc.job = job
  end
  hc.requests = hc.requests + 1
  local line = vim.json.encode({
    jsonrpc = "2.0", id = hc.requests, method = "terminal.label",
    params = { terminal = vim.env.HC_TERMINAL_ID, labels = { [key] = value } },
  })
  local ok, sent = pcall(vim.fn.chansend, hc.job, line .. "\n")
  return ok and sent > 0
end

local function cross(opts, ...)
  if in_app() then
    local args = { ... }
    -- The Herdr app's Edger mod keeps no state to clear.
    if args[1] == "clear" then return end
    -- The mod acts on this label (see bin/edger).
    local nonce = string.format("%d.%d", vim.uv.hrtime(), hc.requests)
    if hc_label(opts, "edger", table.concat(args, "-") .. ":" .. nonce) then return end
  end
  if not vim.env.HERDR_PANE_ID and not vim.env.TMUX_PANE and not vim.env.HC_TERMINAL_ID then return end
  local result = vim.fn.system({ executable(opts), "cross", ... })
  if vim.v.shell_error ~= 0 then vim.notify(result, vim.log.levels.ERROR) end
end

-- The window `wincmd {letter}` selects, when it lies that way.
local function neighbor(letter)
  local there = vim.fn.winnr(letter)
  if there == vim.fn.winnr() then return nil end
  local axis = (letter == "h" or letter == "l") and 2 or 1
  local step = (letter == "l" or letter == "j") and 1 or -1
  local from = vim.api.nvim_win_get_position(0)[axis]
  local to = vim.api.nvim_win_get_position(vim.fn.win_getid(there))[axis]
  return (to - from) * step > 0 and there or nil
end

-- Windows after and before the current one on the letter's axis.
local function resize_windows(letter)
  local horizontal = letter == "h" or letter == "l"
  local here = vim.fn.winnr()
  return vim.fn.winnr(horizontal and "l" or "j") ~= here, vim.fn.winnr(horizontal and "h" or "k") ~= here
end

local function close_local()
  return #vim.api.nvim_tabpage_list_wins(0) > 1 or #vim.api.nvim_list_tabpages() > 1
end

-- Edger commands run, published so the app can tell when Neovim has caught
-- up with the keys it sent.
local count = 0

local function navigate(direction, letter, opts)
  count = count + 1
  if neighbor(letter) then
    vim.cmd.wincmd(letter)
    cross(opts, "clear")
  else
    cross(opts, direction)
  end
end

local function resize(direction, letter, opts)
  count = count + 1
  local adjacent, opposite = resize_windows(letter)
  if not adjacent and not opposite then
    cross(opts, "resize", direction)
    return
  end
  local command = ({ h = "<", l = ">", j = "+", k = "-" })[letter]
  if not adjacent then command = ({ h = ">", l = "<", j = "-", k = "+" })[letter] end
  vim.cmd.wincmd(command)
  cross(opts, "clear")
end

local function action(name, opts)
  count = count + 1
  if name == "close" then
    if #vim.api.nvim_tabpage_list_wins(0) > 1 then vim.cmd.close(); cross(opts, "clear")
    elseif #vim.api.nvim_list_tabpages() > 1 then vim.cmd.tabclose(); cross(opts, "clear")
    else cross(opts, "close") end
  else
    vim.cmd(({ horizontal = "split", vertical = "vsplit" })[name])
    cross(opts, "clear")
  end
end

-- Letters of the Edger keys Neovim handles itself in the current window:
-- h/j/k/l a window that way, H/J/K/L a divider on that axis, w something to
-- close before the pane. The protocol letters stay fixed whatever keys are
-- mapped.
local function local_keys()
  local keys = ""
  for _, letter in ipairs({ "h", "j", "k", "l" }) do
    if neighbor(letter) then keys = keys .. letter end
  end
  for _, letter in ipairs({ "h", "j", "k", "l" }) do
    local adjacent, opposite = resize_windows(letter)
    if adjacent or opposite then keys = keys .. letter:upper() end
  end
  if close_local() then keys = keys .. "w" end
  return keys
end

local published

-- Tells the Herdr app which Edger keys Neovim handles itself, as the label
-- edger.local = "<letters>:<count>". The app's Edger mod then moves past
-- Neovim at once, as for a shell, and sends keys only when Neovim uses them.
function M.publish(opts)
  if not in_app() then return end
  local value = local_keys() .. ":" .. count
  if value ~= published and hc_label(opts or {}, "edger.local", value) then published = value end
end

function M.setup(opts)
  opts = opts or {}
  local modifier = opts.modifier or "M"
  local actions = opts.actions or { horizontal = "u", vertical = "i", close = "w" }
  for letter, direction in pairs(directions) do
    local callback = function() navigate(direction, letter, opts) end
    vim.api.nvim_create_user_command("Edger" .. direction:sub(1, 1):upper() .. direction:sub(2), callback, {})
    local resize_callback = function() resize(direction, letter, opts) end
    vim.api.nvim_create_user_command("EdgerResize" .. direction:sub(1, 1):upper() .. direction:sub(2), resize_callback, {})
    if opts.keymaps ~= false then
      vim.keymap.set("n", "<" .. modifier .. "-" .. letter .. ">", callback,
        { silent = true, desc = "Edger " .. direction })
      vim.keymap.set("n", "<" .. modifier .. "-" .. letter:upper() .. ">", resize_callback,
        { silent = true, desc = "Edger resize " .. direction })
    end
  end
  for _, name in ipairs({ "horizontal", "vertical", "close" }) do
    local letter = actions[name]
    if letter then
      local callback = function() action(name, opts) end
      vim.api.nvim_create_user_command("Edger" .. name:sub(1, 1):upper() .. name:sub(2), callback, {})
      if opts.keymaps ~= false then
        vim.keymap.set("n", "<" .. modifier .. "-" .. letter .. ">", callback,
          { silent = true, desc = "Edger " .. name })
      end
    end
  end
  -- After every command, as Neovim waits for input again.
  if in_app() then
    vim.api.nvim_create_autocmd("SafeState", {
      group = vim.api.nvim_create_augroup("edger", { clear = true }),
      callback = function() M.publish(opts) end,
    })
  end
end

return M

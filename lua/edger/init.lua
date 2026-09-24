local M = {}

local directions = { h = "left", j = "down", k = "up", l = "right" }

local function executable(opts)
  if opts.bin then return opts.bin end
  local here = debug.getinfo(1, "S").source:sub(2)
  local local_bin = vim.fn.fnamemodify(here, ":h:h:h") .. "/bin/edger"
  if vim.fn.executable(local_bin) == 1 then return local_bin end
  return "edger"
end

local function cross(opts, ...)
  if not vim.env.HERDR_PANE_ID and not vim.env.TMUX_PANE then return end
  local result = vim.fn.system({ executable(opts), "cross", ... })
  if vim.v.shell_error ~= 0 then vim.notify(result, vim.log.levels.ERROR) end
end

local function navigate(direction, letter, opts)
  local before = vim.api.nvim_get_current_win()
  vim.cmd.wincmd(letter)
  if vim.api.nvim_get_current_win() ~= before then
    cross(opts, "clear")
  else
    cross(opts, direction)
  end
end

local function resize(direction, letter, opts)
  local forward = (letter == "h" or letter == "l") and "l" or "j"
  local backward = (letter == "h" or letter == "l") and "h" or "k"
  local here = vim.fn.winnr()
  local adjacent = vim.fn.winnr(forward) ~= here
  local opposite = vim.fn.winnr(backward) ~= here
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
  if name == "close" then
    if #vim.api.nvim_tabpage_list_wins(0) > 1 then vim.cmd.close(); cross(opts, "clear")
    elseif #vim.api.nvim_list_tabpages() > 1 then vim.cmd.tabclose(); cross(opts, "clear")
    else cross(opts, "close") end
  else
    vim.cmd(({ horizontal = "split", vertical = "vsplit" })[name])
    cross(opts, "clear")
  end
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
end

return M

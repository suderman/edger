local M = {}

local directions = { h = "left", j = "down", k = "up", l = "right" }

local function executable(opts)
  if opts.bin then return opts.bin end
  local here = debug.getinfo(1, "S").source:sub(2)
  local local_bin = vim.fn.fnamemodify(here, ":h:h:h") .. "/bin/edger"
  if vim.fn.executable(local_bin) == 1 then return local_bin end
  return "edger"
end

local function navigate(direction, letter, opts)
  local before = vim.api.nvim_get_current_win()
  vim.cmd.wincmd(letter)
  if vim.api.nvim_get_current_win() ~= before then return end
  if not vim.env.HERDR_PANE_ID and not vim.env.TMUX_PANE then return end
  local result = vim.fn.system({ executable(opts), "cross", direction })
  if vim.v.shell_error ~= 0 then vim.notify(result, vim.log.levels.ERROR) end
end

function M.setup(opts)
  opts = opts or {}
  local modifier = opts.modifier or "C-M"
  for letter, direction in pairs(directions) do
    local callback = function() navigate(direction, letter, opts) end
    vim.api.nvim_create_user_command("Edger" .. direction:sub(1, 1):upper() .. direction:sub(2), callback, {})
    if opts.keymaps ~= false then
      vim.keymap.set("n", "<" .. modifier .. "-" .. letter .. ">", callback,
        { silent = true, desc = "Edger " .. direction })
    end
  end
end

return M

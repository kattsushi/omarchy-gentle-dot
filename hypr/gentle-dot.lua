-- Gentle Dot (Omarchy plugin): SUPER + ALT + D shows or hides the chat panel.
-- Copy to ~/.config/hypr/gentle-dot.lua and add `require("hypr.gentle-dot")` to hyprland.lua.
local toggle = "omarchy-shell shell toggle omarchy-gentle-dot '{}'"

hl.unbind("SUPER + ALT + D")

local omarchy = rawget(_G, "o")
if omarchy and omarchy.bind then
  omarchy.bind("SUPER + ALT + D", "Gentle Dot", toggle)
else
  hl.bind("SUPER + ALT + D", hl.dsp.exec_cmd(toggle))
end

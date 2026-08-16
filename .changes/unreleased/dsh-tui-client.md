---
category: Added
---
- dsh-tui profile support: the plugin now has a first-class client surface in the terminal TUI — `/fallbacks` and the new read-only `/fallbacks config` subcommand appear in the TUI `/` menu with localized descriptions and `config` completion (via the `tuiCommandTrees` service; zero dsh-TUI changes).
- `/fallbacks config` read-only subcommand: prints the composed configuration summary (enabled / trigger codes / root chain / roles / cooldown / revert / caps / presets) with file-edit hints — the TUI settings readback (the TUI has no settings page; configuration stays file-based).

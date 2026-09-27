---
category: Added
---
- Added localized plugin metadata and an icon: package-root `locale/en.json` / `locale/zh.json` (title "Fallbacks" / "故障降级" plus a one-line description) and a package `icon.svg` in the official gradient-tile style, declared through `package.json` (`icon`, `exports["./locale/*.json"]`, `files`) so the Plugins-page detail view and component row localize automatically.

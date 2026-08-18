---
category: Changed
---
- Settings card: the new 主代理 section groups 分时槽设置 (slot rows + an in-section timezone picker that locks to Asia/Shanghai while any preset row exists; rows are drag-reorderable and collapsible to name + first model; custom rows carry an editable name), 默认降级链 (the all-day chain as a configurable provider/model selector list — the old preemption hints are removed) and 默认模型 (the official V4 Flash | Pro head panel); zh preset labels are 梁文峰 / 梁文谷 / GLM峰 / GLM谷, with a zai-coding-cn validity caveat on the GLM presets.
- Role rules are now subagent-only: the origin control is removed from the settings card, root requests never match rules, and a persisted legacy rule `origin` is ignored at match time; role panels are collapsible to id + first chain model (or inherit-root).

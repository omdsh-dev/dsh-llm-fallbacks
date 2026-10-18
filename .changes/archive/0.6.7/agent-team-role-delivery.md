---
category: Changed
---
- The role a dispatch declares (`**Execute as**: <id>` in the child's prompt) is now an explicit stage of dispatch-time role resolution, so a declared role's chain head drives the child's first request — including an Agent Team teammate's initial spawn prompt.
- Agent Team teammates get their persona, role notice/badge and chain-head model from that same header; teammate names stay arbitrary, several teammates may share one role, and an external provider still delivers no persona, notice or badge.

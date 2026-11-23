---
category: Changed
---
- Upgrade `@deepseek-ai/dsh-*` peers to `^0.2.2-rc.5`; a dsh host on 0.2.2-rc.5 now satisfies the declared peer line.
- A provider content refusal (`CONTENT_REFUSED`, new in dsh 0.2.2-rc.5) no longer cools the route: the provider declined that request, so the next request still starts at the chain head.

---
category: Changed
---
- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.5-rc.1` (dsh 0.1.5-rc.1, corridor from 0.1.2-rc.1 through 0.1.3/0.1.5 alphas). Conversation seats (`conversation.chat.node` / `conversation.session.header.utilities`) unchanged — not a top-level panel Slot migrate. Add host-externalized transitive runtime deps of `dsh-client-ui-primitives` / `dsh-client-store` (`clsx`, `zustand`, `immer`, shiki/micromark stack) as `devDependencies` so the out-of-tree vitest graph still resolves after those packages moved them out of `dependencies`.

---
category: Fixed
---
- A fallback chain keeps advancing when a candidate is parameter-incompatible: an inherited `reasoningEffort` the target model does not list, and an inherited `maxTokens` above the target's disclosed `defaultMaxTokens`, are dropped for that attempt instead of ending the turn.
- A `usage` chunk no longer commits an attempt, so a trigger-code failure that follows it still switches to the next candidate (adapters emit usage before their terminal finish).

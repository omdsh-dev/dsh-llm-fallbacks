---
module: dsh-llm-fallbacks effort pins + official tail
date: 2026-11-09
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: settings-compact-slots-reasoning
applies_when:
  - A chain entry must carry a per-hop request control (effort) without breaking saved configs
  - The official all-day fallback must accept more than one provider family
  - A client-only surface needs config-derived display data without a new RPC
tags:
  - dsh
  - llm-fallbacks
  - selectors
  - reasoning-effort
  - official-tail
  - client-bundle
---

# Effort pins on chain entries, and the dual-provider official tail

## The entry grammar is one scalar

`chains[].entries` and a time-slot row's `chain[]` still hold strings. A pinned
reasoning effort is a suffix: `provider/model@effort`, split at the **last** `@`
after the first `/`, and only when the suffix matches
`^[a-z][a-z0-9_-]{0,31}$`. Anything else stays model text, so an exotic model id
keeps its `@`. `selectorKey()` never sees the suffix: route identity, cooldown
keys, picker ids and pricing stay effort-free, which is what makes the suffix
safe to add to persisted configs.

Why a suffix and not an object array: an object shape changes the schema, the
walk, both conformance gates, the picker and every test; the suffix changes one
parser and inherits everywhere. An unset effort writes **no** suffix, so a
pre-change config round-trips byte-identically and the card's dirty check stays
quiet. The cost is a documented limit: a real model id whose trailing `@token`
looks like an effort id would be re-split.

## Semantics: unset follows, set pins

- Unset = the plugin writes no `reasoningEffort`; the session's selection flows
  through.
- Set = the entry's effort replaces the caller's value for **that hop**, applied
  as a spread copy before `adaptForTarget`. If the route does not disclose the
  tier, the existing adaptation **drops** the control — it never degrades back
  to the session value, because a silent downgrade would make a pin unobservable.
- The pin travels with the target, not with the walk, so it cannot leak into the
  next candidate.

## The official tail is a set, compared by parsed key

`OFFICIAL_ALL_DAY_IDS` is four ids: `deepseek-account` and `deepseek-official`,
each with `deepseek-flash` and `deepseek-v4-pro`, account pair first. Conformance
and the card's radio equality compare the parsed `provider/model` key, so a
pinned official tail still conforms and still selects its radio. The settings
panel derives its radios from the **configured** providers (account first), so a
fresh account-first onboarding sees a provider it can actually use, and a host
with only one family sees two radios instead of four.

## The client cannot share host resolvers

The badge needs the chain label plus the chain's effective head. `effectiveHeadOf`
lives in `src/virtual-adapter.ts`, which value-imports `@deepseek-ai/dsh-llm`;
the client bundle purity gate refuses that, so `src/client/index.ts` mirrors the
pure head resolution over the plugin's own client store. The mirror reads config
and catalog already cached by the plugin (no new RPC, no load on a session
header) and falls back to the raw `FallbacksChain/<id>` route while the store is
cold. Drift between the two copies is the residual risk — it needs a
cross-reference fixture test if either side changes.

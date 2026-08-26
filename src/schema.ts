/**
 * The `fallbacks` settings schema (schemastery), mirroring
 * {@link FallbacksConfig}.
 *
 * Host-only module: `Config` is the schemastery schema the settings section
 * validates/composes against, and `@deepseek-ai/schemastery` is an
 * `@deepseek-ai/*` RUNTIME value import — it must never enter the client
 * bundle, because the web loader module table cannot answer that require
 * (build-time externals drift, 20260815: the client bundle previously
 * externalized `@deepseek-ai/schemastery` and the web settings card failed
 * to load). The client half consumes `FallbacksConfig` and the other
 * config types from `./config.ts` type-only, so the schema stays here, out
 * of the client module graph.
 *
 * Object fields are optional by default in schemastery; `.default()` fills
 * the spec defaults, `.required()` keeps mandatory fields. Unknown keys are
 * RETAINED by the composition (verified plan Task 1 Step 1) — that is what
 * lets `detectLegacyKeys` flag two-block-era leftovers (`chains` /
 * `roles.default`) on the composed object at startup (warn + gateway
 * `legacyKeys`, see `src/index.ts` apply()).
 *
 * @module dsh-llm-fallbacks/schema
 */

import z from '@deepseek-ai/schemastery'
import type { FallbacksConfig } from './config.ts'

export const Config = z.object({
  enabled: z.boolean().default(false),
  triggerCodes: z.array(z.string()).default(['AUTH', 'QUOTA', 'RATE_LIMIT']),
  rootChain: z.array(z.string()).default([]),
  roles: z
    .object({
      list: z
        .array(
          z.object({
            id: z.string().required(),
            persona: z.string().default(''),
            prompt: z.string(),
            permissions: z.object({
              allow: z.array(z.string()),
              deny: z.array(z.string()),
            }),
            chain: z.array(z.string()),
            fallback: z.union([z.const('inherit-root'), z.const('none')]).default('inherit-root'),
          }),
        )
        .default([]),
      rules: z
        .array(
          z.object({
            // Legacy wire field (PR #62 feedback): accepted so pre-feedback
            // configs parse/save unchanged; ignored at match time — rules
            // are subagent-only.
            origin: z.union([z.const('root'), z.const('subagent')]),
            provider: z.string(),
            model: z.string(),
            role: z.string().required(),
          }),
        )
        .default([]),
    })
    .default({ list: [], rules: [] }),
  cooldownMs: z.number().default(300_000),
  revertPolicy: z.union([z.const('cooldown-expiry'), z.const('never')]).default('cooldown-expiry'),
  maxSwitchesPerStep: z.number().default(8),
  alwaysModeRetryCap: z.number().default(5),
  // 9th field (spec §9.4): union-of-const + default, same shape as
  // `revertPolicy` above — illegal values fail at schema resolve, and the
  // default guarantees every resolved config carries `presets`.
  presets: z.union([z.const('bundled'), z.const('none')]).default('bundled'),
  // 10th field (plan fallbacks-role-automatch Task 1): dispatch-time LLM
  // role auto-match switch, default ON. Boolean with a schema default — the
  // same additive shape as the other optional fields — so `Config({})`
  // carries `roleAutoMatch: true` and every resolved config has a value.
  roleAutoMatch: z.boolean().default(true),
  // 11th/12th fields (plan fallbacks-timeslots Task 1, P5): extra time-slot
  // rows (the all-day chain keeps `rootChain`'s name) and the
  // config-level timezone. The row shape is deliberately PERMISSIVE (plain
  // strings, no const unions) — malformed rows (bad kind/preset/window)
  // must WARN at load and be skipped by the resolver, never fail schema
  // resolve (P6 warn-not-crash); the gateway rejects them on save
  // (Task 3). Absent `days`/`chain` compose to [] — the resolver reads
  // []/absent `days` as "all days" and an empty `chain` as malformed.
  timeSlots: z
    .array(
      z.object({
        kind: z.string(),
        preset: z.string(),
        start: z.string(),
        end: z.string(),
        days: z.array(z.number()),
        chain: z.array(z.string()),
      }),
    )
    .default([]),
  tz: z.string().default('Asia/Shanghai'),
  // 13th field (plan fallbacks-half-open-recovery Task 1): cooldown-expiry
  // recovery mode — `'timer'` restores the preferred candidate on expiry
  // (today's behavior, byte-identical); `'half-open'` leaves the route
  // half-open for one logged probe instead. Union-of-const + default, the
  // same shape as `revertPolicy`/`presets` — illegal values fail at schema
  // resolve, and the default guarantees every resolved config carries
  // `recovery`.
  recovery: z.union([z.const('timer'), z.const('half-open')]).default('timer'),
}) as unknown as z<FallbacksConfig>

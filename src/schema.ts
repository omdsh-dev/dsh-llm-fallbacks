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
}) as unknown as z<FallbacksConfig>

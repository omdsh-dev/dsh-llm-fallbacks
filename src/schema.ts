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
 * lets `detectLegacyKeys` flag v1 two-block leftovers (`rootChain` /
 * `roles.rules` / …) on the composed object at startup (warn-only
 * migration; the gateway strips them via LEGACY_KEYS, see
 * `src/gateway.ts`).
 *
 * Current host contract: the whole schema is marked `volatile` (the host
 * retired `installSection` — the Loader entry Config IS the settings
 * section now, and `SettingsForms.update` only accepts volatile paths, so
 * the marker is what keeps the gateway/card write path legal). One marker
 * on the ROOT object makes every field live-editable and hands `apply` a
 * single identity-stable config reference the Loader commits saves into
 * (no remount per save). The marker rides the generic `.extra()` writer —
 * the exact bytes `.volatile()` writes in newer schemastery — because the
 * dev-time schemastery resolved from the lockfile can predate that sugar;
 * the `Meta` augmentation below declares the field the peer range admits
 * at its upper end.
 *
 * @module dsh-llm-fallbacks/schema
 */

import z from '@deepseek-ai/schemastery'
import type { FallbacksConfigSource } from './config.ts'

declare module '@deepseek-ai/schemastery' {
  namespace Schemastery {
    interface Meta {
      /** Live-editable marker read by the Loader / `SettingsForms`. */
      volatile?: boolean;
    }
  }
}

const configSchema = z.object({
  triggerCodes: z.array(z.string()).default(['AUTH', 'QUOTA', 'RATE_LIMIT']),
  // Named virtual chains (v2): id (picker model id) + label (display) +
  // entries (默认降级链 + 链尾) + per-chain timeSlots. The row shape inside
  // timeSlots stays deliberately PERMISSIVE (plain strings, no const
  // unions) — malformed rows must WARN at load and be skipped by the
  // resolver, never fail schema resolve; the gateway rejects them on save.
  chains: z
    .array(
      z.object({
        id: z.string().required(),
        label: z.string().required(),
        entries: z.array(z.string()).default([]),
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
      }),
    )
    .default([]),
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
            // Chain POINTER into chains[].id (「指定降级链」); absent = NOT
            // SPECIFIED (the child inherits the delegating agent's route).
            // The ARRAY form is a v1 profile: cordis composes this schema
            // BEFORE apply(), so rejecting it would kill the fiber and the
            // migration could never run. `migrateLegacyConfig` drops the array
            // to NOT SPECIFIED; the write path never re-persists it.
            chain: z.union([z.string(), z.array(z.string())]),
          }),
        )
        .default([]),
    })
    .default({ list: [] }),
  cooldownMs: z.number().default(300_000),
  revertPolicy: z.union([z.const('cooldown-expiry'), z.const('never')]).default('cooldown-expiry'),
  maxSwitchesPerStep: z.number().default(8),
  // Preset-role injection switch: union-of-const + default, same shape as
  // `revertPolicy` — illegal values fail at schema resolve, and the default
  // guarantees every resolved config carries `presets`.
  presets: z.union([z.const('bundled'), z.const('none')]).default('bundled'),
  tz: z.string().default('Asia/Shanghai'),
  // Cooldown-expiry recovery mode: `'timer'` restores the preferred
  // candidate on expiry (today's behavior, byte-identical); `'half-open'`
  // leaves the route half-open for one logged probe instead.
  // Union-of-const + default, the same shape as `revertPolicy`/`presets`.
  recovery: z.union([z.const('timer'), z.const('half-open')]).default('timer'),
})
// Root volatile marker (see the module docblock). `extra` CLONES the schema
// and marks the clone — exactly what schemastery's `.volatile()` does
// (`return this.extra('volatile', true)`) — so the marked clone is the export.
export const Config = configSchema.extra('volatile', true) as unknown as z<FallbacksConfigSource>

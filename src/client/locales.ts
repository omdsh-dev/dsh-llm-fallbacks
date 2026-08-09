/**
 * Fallbacks settings section dictionaries (zh source of truth) plus the
 * `fallbacks` LocaleNamespaceMap merge — the registration's `locale:` seat
 * (`PropsLocale<'fallbacks'>` puts the typed `t` on the section props).
 *
 * Label conventions follow spec §4 用户直观性: enumerable config values
 * (triggerCodes / revertPolicy) render readable labels, never raw enum
 * strings.
 */
import type { FallbacksConfig } from '../config.ts'
import { defaultFallbacksConfig } from '../config.ts'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': 'Fallbacks',
  'nav.description': '模型故障自动降级',
  'enabled.label': '启用故障降级',
  'enabled.hint': '关闭后插件完全不介入；开启但未配置任何链时行为与未安装插件一致。',
  'triggerCodes.label': '触发失败码',
  'triggerCodes.hint': '命中这些失败码时进入降级链决策；可重试型故障（如 5xx）由 llm-retry 先行退避，预算耗尽后同样进入决策。',
  'triggerCodes.RATE_LIMIT': '限流（429）',
  'triggerCodes.QUOTA': '配额超限',
  'triggerCodes.AUTH': '权限/认证失败',
  'triggerCodes.extra': '此外还保留了 {codes} 等自定义失败码。',
  'revertPolicy.label': '冷却结束后',
  'revertPolicy.cooldown-expiry': '冷却到期后回主模型',
  'revertPolicy.never': '保持备用模型（会话内不回）',
  'revertPolicy.hint': '被切换离的模型在冷却期内不再入选；到期后按此策略决定是否回主。',
  'cooldownMs.label': '冷却时长（毫秒）',
  'cooldownMs.hint': '被切离/失败的模型在冷却期内不再入选。',
  'maxSwitchesPerStep.label': '单步最大切换次数',
  'maxSwitchesPerStep.hint': '超过后停止切换，以原始错误语义结束当前步，防止链循环放大延迟。',
  'alwaysModeRetryCap.label': 'always 模式重试上限',
  'alwaysModeRetryCap.hint': 'retryPolicy 为 always 的模型在同一请求内重试达到该次数后切换；0 表示禁用。',
  'chains.label': '降级链',
  'chains.hint': '键为 角色名 / provider/model / provider/*；条目为有序的 provider/model 或 provider/* 选择器。',
  'chains.key': '键',
  'chains.entries': '有序选择器（每行一个）',
  'chains.add': '添加链',
  'chains.remove': '删除该链',
  'chains.keyPlaceholder': '例如 default 或 openai/gpt-4o',
  'chains.entriesPlaceholder': '例如\nanthropic/claude-3-5-sonnet\nopenai/*',
  'roles.label': '角色',
  'roles.hint': '解析顺序：agent.options.role → rules 顺序匹配 → default。',
  'roles.default': '默认角色',
  'roles.rules': '角色规则',
  'roles.rule.origin': '来源',
  'roles.rule.origin.any': '任意',
  'roles.rule.origin.root': 'root',
  'roles.rule.origin.subagent': 'subagent',
  'roles.rule.provider': 'provider',
  'roles.rule.model': 'model',
  'roles.rule.role': '角色',
  'roles.addRule': '添加规则',
  'roles.removeRule': '删除该规则',
  'status.title': '运行状态（只读）',
  'status.configSummary': '当前配置：已启用 {enabled}；默认角色 {role}；{chains} 条链；触发失败码 {codes}。',
  'status.switchesPlaceholder': '最近切换摘要将在此显示。',
  'status.switchesHint': '切换历史来自会话事件流；设置页的只读事件读取面将在运行期验证（T8）后接入，当前为占位。',
  'defaults.prefix': '默认值',
  'save': '保存',
  'save.saving': '保存中…',
  'save.error': '保存失败：{message}',
  'save.conflict': '配置已被其它地方修改（期望修订 {expected}，当前 {actual}）。请重新加载后再保存。',
  'reload': '重新加载',
  'reset': '恢复默认',
  'reset.confirm': '确定要把 fallbacks 配置恢复为默认值吗？',
  'loading': '加载中…',
  'unavailable': '无法读取 fallbacks 设置（未注册或只读环境）。',
  'error.generic': '出错：{message}',
} satisfies Record<string, string>

/** The fallbacks dictionary key union. */
export type FallbacksKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Fallbacks',
  'nav.description': 'Automatic fallback on model failures',
  'enabled.label': 'Enable failure fallback',
  'enabled.hint': 'When off the plugin never intervenes; when on with no chains configured behavior is identical to an uninstalled plugin.',
  'triggerCodes.label': 'Trigger failure codes',
  'triggerCodes.hint': 'Failures with these codes enter chain decision; retryable failures (e.g. 5xx) back off via llm-retry first and reach the decision only when its budget is exhausted.',
  'triggerCodes.RATE_LIMIT': 'Rate limit (429)',
  'triggerCodes.QUOTA': 'Quota exceeded',
  'triggerCodes.AUTH': 'Auth / permission failure',
  'triggerCodes.extra': 'Custom codes are preserved: {codes}.',
  'revertPolicy.label': 'After cooldown',
  'revertPolicy.cooldown-expiry': 'Return to the primary model',
  'revertPolicy.never': 'Keep the fallback model (until session end)',
  'revertPolicy.hint': 'A model switched away from stays out of candidacy during its cooldown; this policy decides whether it returns afterwards.',
  'cooldownMs.label': 'Cooldown (milliseconds)',
  'cooldownMs.hint': 'Switched-away or failed models stay out of candidacy during the cooldown window.',
  'maxSwitchesPerStep.label': 'Max switches per step',
  'maxSwitchesPerStep.hint': 'Beyond this the step stops switching and ends with the original error semantics, preventing chain loops from amplifying latency.',
  'alwaysModeRetryCap.label': 'Always-mode retry cap',
  'alwaysModeRetryCap.hint': 'Models whose retryPolicy is always switch after this many retries within one request; 0 disables.',
  'chains.label': 'Fallback chains',
  'chains.hint': 'Keys are role names / provider/model / provider/*; entries are ordered provider/model or provider/* selectors.',
  'chains.key': 'Key',
  'chains.entries': 'Ordered selectors (one per line)',
  'chains.add': 'Add chain',
  'chains.remove': 'Remove this chain',
  'chains.keyPlaceholder': 'e.g. default or openai/gpt-4o',
  'chains.entriesPlaceholder': 'e.g.\nanthropic/claude-3-5-sonnet\nopenai/*',
  'roles.label': 'Roles',
  'roles.hint': 'Resolution order: agent.options.role → rules in order → default.',
  'roles.default': 'Default role',
  'roles.rules': 'Role rules',
  'roles.rule.origin': 'Origin',
  'roles.rule.origin.any': 'Any',
  'roles.rule.origin.root': 'root',
  'roles.rule.origin.subagent': 'subagent',
  'roles.rule.provider': 'provider',
  'roles.rule.model': 'model',
  'roles.rule.role': 'role',
  'roles.addRule': 'Add rule',
  'roles.removeRule': 'Remove this rule',
  'status.title': 'Runtime status (read-only)',
  'status.configSummary': 'Effective config: enabled {enabled}; default role {role}; {chains} chains; trigger codes {codes}.',
  'status.switchesPlaceholder': 'Recent switch summary will appear here.',
  'status.switchesHint': 'Switch history comes from the session event stream; the read-only event face for the settings page lands after runtime verification (T8) — placeholder for now.',
  'defaults.prefix': 'Default',
  'save': 'Save',
  'save.saving': 'Saving…',
  'save.error': 'Save failed: {message}',
  'save.conflict': 'The configuration changed elsewhere (expected revision {expected}, now {actual}). Reload and try again.',
  'reload': 'Reload',
  'reset': 'Reset to defaults',
  'reset.confirm': 'Reset the fallbacks configuration to defaults?',
  'loading': 'Loading…',
  'unavailable': 'Cannot read fallbacks settings (namespace not registered or read-only environment).',
  'error.generic': 'Error: {message}',
} satisfies Record<FallbacksKey, string>

/** The settings section's dictionary namespace. */
export const NS = 'fallbacks'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This feature's settings-section copy. */
    fallbacks: FallbacksKey
  }
}

/** Human-readable trigger-code labels (spec §4 用户直观性). */
export const TRIGGER_CODE_LABELS: Readonly<Record<string, FallbacksKey>> = {
  RATE_LIMIT: 'triggerCodes.RATE_LIMIT',
  QUOTA: 'triggerCodes.QUOTA',
  AUTH: 'triggerCodes.AUTH',
}

/**
 * The known trigger codes the form toggles; unknown codes are preserved.
 * M-04: derived from the host defaults so the toggle set can never drift from
 * the decision set (`defaultFallbacksConfig.triggerCodes` is the single
 * source of truth; the labels mapping above stays keyed by code).
 */
export const KNOWN_TRIGGER_CODES: readonly string[] = [...defaultFallbacksConfig.triggerCodes]

/** Toggle one known code's membership in `codes` (used by the form; pure). */
export function withTriggerCode(codes: readonly string[], code: string, present: boolean): string[] {
  const next = new Set(codes)
  if (present) next.add(code)
  else next.delete(code)
  return [...next]
}

/** Render a config summary line (AC-7 read-only block). */
export function configSummary(config: FallbacksConfig, t: (key: FallbacksKey, params?: Record<string, unknown>) => string): string {
  return t('status.configSummary', {
    enabled: config.enabled ? 'on' : 'off',
    role: config.roles.default,
    chains: String(Object.keys(config.chains).length),
    codes: config.triggerCodes.join(', '),
  })
}

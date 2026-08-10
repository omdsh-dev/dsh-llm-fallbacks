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
  'enabled.off': '功能未开启：打开 enabled 开关以显示配置界面。',
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
  'chains.add': '添加链',
  'chains.remove': '删除该链',
  'chains.keyPlaceholder': '例如 default 或 openai/gpt-4o',
  'chains.selector.add': '添加选择器',
  'chains.selector.remove': '删除该选择器',
  'chains.selector.providerPlaceholder': '选择 provider',
  'chains.selector.modelPlaceholder': '选择 model',
  'chains.selector.wildcard': '通配该 provider（provider/*）',
  'chains.selector.noModels': '该 provider 暂无可用模型（目录查询失败），请使用通配或改选。',
  'roles.label': '角色',
  'roles.hint': '解析顺序：agent.options.role → rules 顺序匹配 → default。',
  'roles.default': '默认角色',
  'roles.rules': '角色规则',
  'roles.rule.origin': '来源',
  'roles.rule.origin.any': '任意',
  'roles.rule.origin.root': 'root',
  'roles.rule.origin.subagent': 'subagent',
  'roles.rule.provider': 'provider',
  'roles.rule.provider.any': '任意',
  'roles.rule.model': 'model',
  'roles.rule.model.any': '任意',
  'roles.rule.role': '角色',
  'roles.addRule': '添加规则',
  'roles.removeRule': '删除该规则',
  'catalog.empty': '暂无可用模型：请先在模型页添加模型，添加后此处将自动可选。',
  'catalog.error': '模型目录读取失败：{message}',
  'catalog.partial': '部分 provider 模型查询失败：{message}',
  'catalog.outside.hint': '目录外：不在当前模型目录，可保留原值并保存（新增条目仅可从目录选择）。',
  'catalog.outside.short': '（目录外）',
  'status.title': '运行状态（只读）',
  'status.configSummary': '当前配置：已启用 {enabled}；默认角色 {role}；{chains} 条链；触发失败码 {codes}。',
  'status.effectiveModel.label': '当前生效模型',
  'status.effectiveModel.unavailable': 'fallbacks 未启用（或未配置）：无当前生效模型。',
  'status.effectiveModel.note': '配置 + 最近切换推导，非实时路由探测。',
  'status.switches.label': '最近切换',
  'status.switches.empty': '本会话暂无 fallback 切换。',
  'status.switches.error': '切换历史读取失败：{message}',
  'status.switches.item': '{role} · {reason} · {time}',
  'status.switches.reason.trigger-code': '触发失败码',
  'status.switches.reason.always-cap': 'always 模式上限',
  'defaults.prefix': '默认值',
  'save': '保存',
  'save.saving': '保存中…',
  'save.error': '保存失败：{message}',
  'save.conflict': '配置已被其它地方修改（期望修订 {expected}，当前 {actual}）。请重新加载后再保存。',
  'reload': '重新加载',
  'close': '关闭',
  'reset': '恢复默认',
  'reset.confirmTitle': '恢复默认配置',
  'reset.confirm': '恢复后 fallbacks 配置将回到插件默认值，当前编辑内容会丢失。',
  'reset.confirm.cancel': '取消',
  'reset.confirm.action': '恢复默认',
  'reset.saving': '恢复中…',
  'loading': '加载中…',
  'unavailable': 'fallbacks 命名空间尚未注册：以下显示默认配置，可尝试保存；保存失败会在此处如实提示。',
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
  'enabled.off': 'Feature disabled: turn on the enabled switch to show the configuration interface.',
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
  'chains.add': 'Add chain',
  'chains.remove': 'Remove this chain',
  'chains.keyPlaceholder': 'e.g. default or openai/gpt-4o',
  'chains.selector.add': 'Add selector',
  'chains.selector.remove': 'Remove this selector',
  'chains.selector.providerPlaceholder': 'Select provider',
  'chains.selector.modelPlaceholder': 'Select model',
  'chains.selector.wildcard': 'Wildcard this provider (provider/*)',
  'chains.selector.noModels': 'No models available for this provider (catalog lookup failed); use the wildcard or pick another provider.',
  'roles.label': 'Roles',
  'roles.hint': 'Resolution order: agent.options.role → rules in order → default.',
  'roles.default': 'Default role',
  'roles.rules': 'Role rules',
  'roles.rule.origin': 'Origin',
  'roles.rule.origin.any': 'Any',
  'roles.rule.origin.root': 'root',
  'roles.rule.origin.subagent': 'subagent',
  'roles.rule.provider': 'provider',
  'roles.rule.provider.any': 'Any',
  'roles.rule.model': 'model',
  'roles.rule.model.any': 'Any',
  'roles.rule.role': 'role',
  'roles.addRule': 'Add rule',
  'roles.removeRule': 'Remove this rule',
  'catalog.empty': 'No models yet: add a model on the Models page first; options will appear here automatically.',
  'catalog.error': 'Model catalog read failed: {message}',
  'catalog.partial': 'Some provider model lookups failed: {message}',
  'catalog.outside.hint': 'Outside catalog: not in the current model catalog; you can keep the original value and save it (new entries are restricted to the catalog).',
  'catalog.outside.short': ' (outside catalog)',
  'status.title': 'Runtime status (read-only)',
  'status.configSummary': 'Effective config: enabled {enabled}; default role {role}; {chains} chains; trigger codes {codes}.',
  'status.effectiveModel.label': 'Current effective model',
  'status.effectiveModel.unavailable': 'Fallbacks disabled (or not configured): no current effective model.',
  'status.effectiveModel.note': 'Derived from configuration and recent switches; not real-time route probing.',
  'status.switches.label': 'Recent switches',
  'status.switches.empty': 'No fallback switches in this session yet.',
  'status.switches.error': 'Switch history read failed: {message}',
  'status.switches.item': '{role} · {reason} · {time}',
  'status.switches.reason.trigger-code': 'trigger code',
  'status.switches.reason.always-cap': 'always-mode cap',
  'defaults.prefix': 'Default',
  'save': 'Save',
  'save.saving': 'Saving…',
  'save.error': 'Save failed: {message}',
  'save.conflict': 'The configuration changed elsewhere (expected revision {expected}, now {actual}). Reload and try again.',
  'reload': 'Reload',
  'close': 'Close',
  'reset': 'Reset to defaults',
  'reset.confirmTitle': 'Reset to defaults',
  'reset.confirm': 'Resetting restores the fallbacks configuration to plugin defaults; your current edits will be lost.',
  'reset.confirm.cancel': 'Cancel',
  'reset.confirm.action': 'Reset',
  'reset.saving': 'Resetting…',
  'loading': 'Loading…',
  'unavailable': 'The fallbacks namespace is not registered yet: showing the default configuration. You can try to save; failures will be reported here.',
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

/**
 * Render a switch event time (Unix epoch ms) for the status block as
 * `YYYY-MM-DD HH:mm` in local time — locale-neutral, so zh/en share the
 * format (the dictionaries stay the sole copy source).
 */
export function formatSwitchTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

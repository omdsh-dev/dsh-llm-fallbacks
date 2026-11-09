/**
 * Fallbacks settings section dictionaries (zh source of truth) plus the
 * `fallbacks` LocaleNamespaceMap merge — the registration's `locale:` seat
 * (`PropsLocale<'fallbacks'>` puts the typed `t` on the section props).
 *
 * Label conventions follow spec §4 用户直观性: enumerable config values
 * (triggerCodes / revertPolicy) render readable labels, never raw enum
 * strings.
 */
import { defaultFallbacksConfig } from '../config.ts'
import type { FallbackSwitchReason } from '../events.ts'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'discard': '放弃修改',
  'retry': '重试',
  'readOnly': '当前环境中的设置为只读。',
  'triggerCodes.label': '触发失败码',
  'triggerCodes.hint': '命中这些失败码时进入降级决策',
  'triggerCodes.tooltip': '命中这些失败码时进入降级链决策；可重试型故障（如 5xx）由 llm-retry 先行退避，预算耗尽后同样进入决策。',
  'triggerCodes.RATE_LIMIT': '限流（429）',
  'triggerCodes.QUOTA': '配额超限',
  'triggerCodes.AUTH': '权限/认证失败',
  'triggerCodes.extra': '此外还保留了 {codes} 等自定义失败码。',
  'revertPolicy.label': '冷却结束后',
  'revertPolicy.cooldown-expiry': '冷却到期后回主模型',
  'revertPolicy.never': '保持备用模型（会话内不回）',
  'revertPolicy.hint': '冷却到期后是否回主模型',
  'revertPolicy.tooltip': '被切换离的模型在冷却期内不再入选；到期后按此策略决定是否回主。',
  'cooldownMs.label': '冷却时长（毫秒）',
  'cooldownMs.hint': '冷却期内模型不再入选',
  'cooldownMs.tooltip': '被切离/失败的模型在冷却期内不再入选。',
  'maxSwitchesPerStep.label': '单次请求行走最大切换',
  'maxSwitchesPerStep.hint': '超过后停止切换',
  'maxSwitchesPerStep.tooltip': '超过后不再切换，以原始错误语义结束本次请求，防止链循环放大延迟。',
  'virtualOnly.rule': '只有模型选择为 FallbacksChain/<链 id> 的会话（含继承该路由的子代理）会执行降级链；选择真实模型的会话没有插件降级，仅由 llm-retry 处理重试。',
  'advanced.label': '高级选项',
  // 高级选项 disclosure (plan fallbacks-card-section-ux T3/T5): the
  // section is collapsed by default — the expand/collapse a11y labels ride
  // the heading toggle (the time-slot/role-row contract).
  'advanced.expand': '展开高级选项',
  'advanced.collapse': '收起高级选项',
  // PR #62 feedback round: 默认降级链 is the all-day fallback chain as a
  // configurable selector list (no Flash|Pro radio — that panel moved to
  // 默认模型); the preemption hints are removed.
  'rootChain.label': '默认降级链',
  'rootChain.tooltip': '未命中任何分时槽时先走这条降级链；全部失败后落到下面的默认模型。',
  'defaultModel.label': '默认模型',
  // Compact chain rows (plan fallbacks-chain-row-compact T3): the visible
  // field labels are gone, so the two selects carry the field AND the
  // 1-based row position in their accessible names ({index}); the remove
  // button names the row it deletes instead of "this selector".
  'chains.selector.remove': '删除第 {index} 个选择器',
  'chains.selector.providerAria': '第 {index} 个选择器的 provider',
  'chains.selector.modelAria': '第 {index} 个选择器的 model',
  // Plan fallbacks-chain-reorder T1: the trailing grip names its row, so a
  // screen reader can tell the reorder handles apart.
  'chains.selector.reorder': '拖拽排序第 {index} 个选择器，或聚焦后按 ↑/↓ 调整',
  'chains.selector.providerPlaceholder': '选择 provider',
  'chains.selector.modelPlaceholder': '选择 model',
  'chains.selector.wildcardLegacy': '该条目为通配（provider/*）：选择具体模型后将转为精确条目',
  'chains.selector.noModelsStrict': '该 provider 暂无可用模型（目录查询失败），请改选其他 provider。',
  // Plan settings-compact-slots-reasoning T3: the per-entry reasoning effort
  // column. `跟随会话` is the unset value — it writes no suffix, so the hop
  // inherits whatever the session selected; a pinned tier overrides it.
  'chains.selector.effortAria': '第 {index} 个选择器的推理等级',
  'chains.selector.effortFollow': '跟随会话',
  'chains.selector.effortNone': '无',
  'chains.selector.effortNoMetadata': '该模型未提供推理等级元数据',
  'chains.selector.effortUnsupported': '不支持，按会话等级发送',
  // PR #62 feedback: the main-agent section heading groups the time-slot
  // rows + the all-day chooser; the subagents heading groups roles list +
  // rules.
  'subagents.label': '子代理',
  'virtualChain.label': '虚拟链',
  'virtualChain.hint': '每条链是一张独立的虚拟路由，可各自配置分时、默认降级链与链尾。',
  'chains.tab.add': '新建链',
  'chains.tab.menu': '管理当前链：重命名 / 删除',
  'chains.name.label': '链名称',
  'chains.name.hint': '仅用于展示（tab 标题与模型选择器前缀）；id「{id}」是模型选择器里的路由，创建后不可改。',
  'chains.name.tooltip': '给这条虚拟链起个可读的名字；实际路由是 FallbacksChain/<链 id>，改名不影响已选该路由的会话。',
  'chains.tab.renameLabel': '链名（仅展示名，id「{id}」不变）',
  'chains.tab.renameDone': '完成',
  'chains.tab.delete': '删除该链',
  'chains.tab.deleteDisabled': '删除该链（至少保留一条链）',
  'chains.tab.dirty': '（未保存修改）',
  'chains.tab.error': '（校验错误）',
  'chains.empty.title': '尚未配置任何降级链',
  'chains.empty.body': '未配置链时，模型选择器中不会出现任何 FallbacksChain/* 虚拟路由；已选 FallbacksChain 路由的会话将没有插件降级，仅由宿主 llm-retry 处理重试。',
  'chains.empty.create': '＋ 新建第一条链',
  'chains.chainFoot.hint': '仅保存当前链：选择器 · 链尾 · 分时槽 · 链名',
  'chains.chainFoot.discard': '放弃修改',
  'chains.chainFoot.save': '保存',
  // Host-policy status area (plan dsh-012-subagent-routing T5 / spec D4):
  // read-only; never a second write-face. zh is the key-set source of truth.
  // Time-slot rows (plan fallbacks-timeslots Task 3; PR #62 feedback
  // round): the extra-row list sits under the 主代理 section; preset
  // Timezone picker lives inside expanded custom rows only; preset
  // windows stay frozen UTC+8. The label carries the UTC± cue.
  'timeSlots.label': '分时槽设置',
  'timeSlots.hint': '自上而下第一条命中生效 · 时区 {tz}',
  'timeSlots.empty': '当前链未配置分时槽：全天沿用默认降级链与默认模型。',
  'timeSlots.drag': '拖拽排序（或使用上下按钮）',
  // PR #62 feedback round: collapsible slot rows — collapsed shows the
  // row name + its first model; custom rows carry an editable name.
  'timeSlots.name': '名称',
  'timeSlots.expand': '展开该行',
  'timeSlots.collapse': '收起该行',
  'timeSlots.tooltip': '自上而下第一条命中生效，全时段行固定最后。命中行的模型链成为 root 生效链（取代全时段链）；未命中任何行时使用全时段链。分时切换是路由种子而非失败决策：不消耗冷却、不计入单次请求行走的切换上限。',
  'timeSlots.addPreset': '添加预设',
  'timeSlots.addCustom': '添加自定义时段',
  'timeSlots.presetPlaceholder': '选择预设',
  'timeSlots.remove': '删除该时段行',
  'timeSlots.moveUp': '上移该时段行',
  'timeSlots.moveDown': '下移该时段行',
  'timeSlots.start': '开始（HH:mm）',
  'timeSlots.end': '结束（HH:mm）',
  'timeSlots.days': '星期',
  'timeSlots.days.hint': '不勾选 = 每天；可跨午夜',
  // Plan settings-compact-slots-reasoning T3: the collapsed slot row IS the
  // row's identity — a preset prints this short window summary (the opened
  // body no longer repeats the preset name or the full window), a custom row
  // prints `timeSlots.customMeta`.
  'timeSlots.customMeta': '{start}–{end} · {days}',
  'timeSlots.days.every': '每天',
  'timeSlots.preset.liang-peak.label': '梁文峰',
  'timeSlots.preset.liang-peak.window': '09:00–12:00 与 14:00–18:00（周一至周五，UTC+8）',
  'timeSlots.preset.liang-peak.meta': '09:00–12:00 · 14:00–18:00 周一–周五',
  'timeSlots.preset.liang-valley.label': '梁文谷',
  'timeSlots.preset.liang-valley.window': 'Liang Peak 之外的所有时间（UTC+8）',
  'timeSlots.preset.liang-valley.meta': '非峰值 · UTC+8',
  'timeSlots.preset.glm-peak.label': 'GLM峰',
  'timeSlots.preset.glm-peak.window': '周一至周五 14:00–18:00（UTC+8）',
  'timeSlots.preset.glm-peak.meta': '周一–周五 14:00–18:00',
  'timeSlots.preset.glm-valley.label': 'GLM谷',
  'timeSlots.preset.glm-valley.window': 'GLM Peak 之外的所有时间（UTC+8）',
  'timeSlots.preset.glm-valley.meta': '非 GLM 峰值 · UTC+8',
  // PR #62 feedback: the GLM presets route to zai-coding-cn models — the
  // caveat rides every GLM preset row (shared by both GLM presets).
  'timeSlots.preset.glm.note': '仅配置了 zai-coding-cn 时有效',
  // PR #62 UX round 4: cost/multiplier tags on the peak preset rows (red
  // 高消耗 + yellow x2/x3) and the active-slot indicator — literal product
  // strings, zh source of truth.
  'timeSlots.preset.highCost': '高消耗',
  'timeSlots.preset.multiplier': 'x{n}',
  'timeSlots.active': '激活',
  // PR #62 UX round 4 part B: the GLM presets route to zai-coding-cn — the
  // suffix explains why the option is disabled until the provider is
  // configured (the note wording: 仅配置了 zai-coding-cn 时有效).
  'timeSlots.preset.glm.unconfigured': '（需配置 zai-coding-cn）',
  'timeSlots.day.sun': '日',
  'timeSlots.day.mon': '一',
  'timeSlots.day.tue': '二',
  'timeSlots.day.wed': '三',
  'timeSlots.day.thu': '四',
  'timeSlots.day.fri': '五',
  'timeSlots.day.sat': '六',
  'timeSlots.selector.add': '添加选择器',
  // All-day head (plan fallbacks-timeslots Task 3; PR #62 feedback round):
  // the 默认模型 panel is the official Flash / Pro XOR head of the default
  // fallback chain — separate from the 默认降级链 selector list. Both tails
  // are selectable: the official catalog serves Pro as
  // `deepseek-official/deepseek-v4-pro`.
  // Plan settings-compact-slots-reasoning T3: the panel is generated from the
  // four legal ids filtered by the configured providers — `deepseek-account`
  // first (preferred), then `deepseek-official`. `allDay.option` is the row
  // label, `optionRoute`'s sibling (the wire id) is rendered verbatim.
  'allDay.hint': '全天链的最后一档兜底；两款官方 provider 均可用，账号优先显示。',
  'allDay.tooltip': '链尾必须是官方兜底模型（Flash / Pro）；这是全时段约束的判定点，其余条目是它之前的降级顺序。',
  'allDay.only': '全天链的最后一档兜底；当前仅 {provider} 可用。',
  'allDay.none': '无可用官方 provider：deepseek-account / deepseek-official 均未配置，链尾无法选择官方兜底模型。',
  'allDay.option': '{model}（{provider}）',
  'allDay.flash': 'Flash',
  'allDay.pro': 'Pro',
  'allDay.account': '账号',
  'allDay.official': '官方',
  'allDay.nonconforming': '当前默认模型不合法：请选择官方 Flash 或 Pro 后保存',
  'roles.list.label': '角色实体',
  'roles.id': 'id',
  'roles.id.hint': '小写字母/数字/连字符，1–32 字符',
  'roles.idPlaceholder': '例如 reviewer',
  'roles.persona': '人格提示',
  'roles.personaPlaceholder': '例如：你是资深代码审查员',
  // Seeded-row read-only UX (plan role-card-seeded-ux): the persona brief's
  // expand/collapse a11y labels and the empty-persona fallback. The source
  // badge localizes the three reserved labels (`bundled` / `external` /
  // the operator's own rows — `external` is the shared unnamed-producer
  // label, plan seeds-source-and-persona-width); only registered set
  // names render verbatim.
  'roles.persona.expand': '展开人格提示',
  'roles.persona.collapse': '收起人格提示',
  'roles.persona.empty': '（未设置）',
  'roles.seedSource.bundled': '内置',
  'roles.seedSource.external': '外部',
  'roles.seedSource.user': '用户',
  'roles.list.hint': '角色是该角色的身份与人格；可在「指定降级链」中手动指定一条命名虚拟链',
  'roles.chain.label': '指定降级链',
  'roles.chain.unspecified': '未指定（沿用 dsh 默认）',
  'roles.chain.tooltip': '手动指定该角色使用的命名虚拟链：派发到该角色的子代理会挂到 FallbacksChain/<链 id>，由那条链承接降级。未指定则插件不干预。',
  'roles.chainMeta.unspecified': '未指定降级链',
  'roles.add': '添加角色',
  'roles.remove': '删除角色 {id}（{chain}）',
  // Short visual tooltip: the aria-label above carries the identity, but a
  // nowrap bubble would overflow the row's trailing edge with it.
  'roles.remove.tip': '删除该角色',
  // Collapsible role panels — collapsed shows the role id + its specified
  // chain route (or 未指定降级链).
  'roles.expand': '展开角色 {id}',
  'roles.collapse': '收起角色 {id}',
  'validation.blocked': '配置校验未通过，保存被拦截：',
  'validation.roleIdFormat': '角色 id "{id}" 不符合格式 /^[a-z0-9-]{1,32}$/',
  'validation.roleIdReserved': '"inherit" 为保留角色 id，不能用于角色实体',
  'validation.roleIdDuplicate': '角色 id "{id}" 重复',
  'validation.chainIdFormat': '链 id "{id}" 不符合格式 /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/',
  'validation.chainIdDuplicate': '链 id "{id}" 重复',
  'validation.chainLabelRequired': '链 "{id}" 缺少展示名（label）',
  'validation.chainEntriesRequired': '默认降级链不能为空：请至少添加一条选择器。',
  'validation.allDayRequired': '默认模型必须二选一：官方 Flash 或 Pro',
  'validation.slotChainRequired': '分时槽未配置模型：请至少添加一条链选择器',
  'validation.slotWindow': '分时槽开始/结束时间须为 HH:mm 格式',
  'validation.slotDays': '星期取值须为 0–6 的整数',
  'validation.slotKind': '分时槽 kind 须为 "preset" 或 "custom"',
  'validation.slotPresetUnknown': '未知的分时槽预设 "{preset}"',
  'validation.slotPresetDuplicate': '预设 "{preset}" 已存在：每个预设只能添加一行',
  'validation.slotPresetFrozen': '预设窗口是冻结代码常量：预设行不能携带 start/end/days',
  'validation.selector': '选择器 "{entry}" 非法：{message}',
  'legacy.banner': '检测到旧格式字段（{keys}）：已自动升级为命名链——原默认降级链成为第 0 条链「默认链」，角色与人格保持不变，旧的角色数组链已置为「未指定」（可在下方重新指定）。保存一次即可固化；插件不会主动改写你的配置文件。',
  'catalog.empty': '暂无可用模型：请先在模型页添加模型，添加后此处将自动可选。',
  'catalog.error': '模型目录读取失败：{message}',
  'catalog.partial': '部分 provider 模型查询失败：{message}',
  'catalog.outside.hint': '目录外，可保留原值',
  'catalog.outside.tooltip': '不在当前模型目录，可保留原值并保存；新增条目仅可从目录选择。',
  'catalog.outside.short': ' （目录外）',
  'catalog.unconfigured.short': ' （未配置）',
  // One shared reason key family for every seat (qc1 F-004): the
  // conversation node resolves reasons through this same map.
  'status.switches.reason.trigger-code': '触发失败码',
  'status.switches.reason.always-cap': 'always 模式上限',
  'status.switches.reason.role-inject': '角色注入',
  'chat.switch.title': '模型已降级',
  'chat.switch.summary': '{from} → {to}（{reason}）',
  // Role-mapped (role-inject) summary on the conversation node (qc1 F-002 /
  // qc2 F-003 dedupe): the `role → model` mapping is the primary info, so
  // the summary carries only the reason — `{to}` does not appear twice.
  'chat.switch.summary.roleInject': '（{reason}）',
  'chat.switch.roleMap': '{role} → {model}',
  // Session-header subagent role/model badge (plan subagent-role-badge T3;
  // plan subagent-role-model): the badge body renders the raw role id
  // (locale-neutral, like the transcript role badge) plus the model route; the
  // hover repeats the mapping. The route is the host `modelSelection`
  // projection read as `next ?? lastUsed` — the next request's route, falling
  // back to the last used one — so the label stays neutral ("request route").
  'subagentRole.hover': '{role} → {model}（请求路由）',
  // Plan settings-compact-slots-reasoning T4: a `FallbacksChain/<id>` route is
  // the plugin's own virtual route, so the pill prints the chain label and the
  // model that chain will actually dispatch (its static effective head).
  'subagentRole.unresolved': '未解析',
  'subagentRole.hoverChain': '{role} → {chain} · {model}（{route}）',
  'subagentRole.hoverChainUnresolved': '{role} → {chain}（链未配置或无可用模型）',
  'defaults.prefix': '默认值',
  'save': '保存',
  'save.saving': '保存中…',
  'save.error': '保存失败：{message}',
  'close': '关闭',
  'loading': '加载中…',
  'unavailable': 'fallbacks 配置通道暂不可达：以下显示默认配置（或上次读取值），可尝试保存；保存失败会在此处如实提示。',
  'error.generic': '出错：{message}',
} satisfies Record<string, string>

/** The fallbacks dictionary key union. */
export type FallbacksKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'discard': 'Discard',
  'retry': 'Retry',
  'readOnly': 'Settings are read-only in this environment.',
  'triggerCodes.label': 'Trigger failure codes',
  'triggerCodes.hint': 'Failures with these codes enter fallback decision',
  'triggerCodes.tooltip': 'Failures with these codes enter chain decision; retryable failures (e.g. 5xx) back off via llm-retry first and reach the decision only when its budget is exhausted.',
  'triggerCodes.RATE_LIMIT': 'Rate limit (429)',
  'triggerCodes.QUOTA': 'Quota exceeded',
  'triggerCodes.AUTH': 'Auth / permission failure',
  'triggerCodes.extra': 'Custom codes are preserved: {codes}.',
  'revertPolicy.label': 'After cooldown',
  'revertPolicy.cooldown-expiry': 'Return to the primary model',
  'revertPolicy.never': 'Keep the fallback model (until session end)',
  'revertPolicy.hint': 'Whether to return to the primary model after cooldown',
  'revertPolicy.tooltip': 'A model switched away from stays out of candidacy during its cooldown; this policy decides whether it returns afterwards.',
  'cooldownMs.label': 'Cooldown (milliseconds)',
  'cooldownMs.hint': 'Models stay out of candidacy during cooldown',
  'cooldownMs.tooltip': 'Switched-away or failed models stay out of candidacy during the cooldown window.',
  'maxSwitchesPerStep.label': 'Max switches per request walk',
  'maxSwitchesPerStep.hint': 'Stops switching beyond the cap',
  'maxSwitchesPerStep.tooltip': 'Beyond this no further switch happens and the request ends with the original error semantics, preventing chain loops from amplifying latency.',
  'virtualOnly.rule': 'Only sessions whose model selection is FallbacksChain/<chain id> (including subagents that inherit that route) walk a chain; a real-model selection gets no plugin fallback — llm-retry alone handles its retries.',
  'advanced.label': 'Advanced options',
  // Advanced-options disclosure (plan fallbacks-card-section-ux T3/T5).
  'advanced.expand': 'Expand advanced options',
  'advanced.collapse': 'Collapse advanced options',
  // PR #62 feedback round: the default fallback chain is the all-day chain
  // as a configurable selector list (no Flash|Pro radio — that panel moved
  // to 默认模型); the preemption hints are removed.
  'rootChain.label': 'Default fallback chain',
  'rootChain.tooltip': 'Walked first whenever no time slot matches; if every entry fails, the default model below is the last fallback.',
  'defaultModel.label': 'Default model',
  // Compact chain rows (plan fallbacks-chain-row-compact T3) — see the zh
  // comment: the selects carry the field plus the 1-based row position.
  'chains.selector.remove': 'Remove selector {index}',
  'chains.selector.providerAria': 'Selector {index} provider',
  'chains.selector.modelAria': 'Selector {index} model',
  'chains.selector.reorder': 'Drag to reorder selector {index}, or focus and press ↑/↓',
  'chains.selector.providerPlaceholder': 'Select provider',
  'chains.selector.modelPlaceholder': 'Select model',
  'chains.selector.wildcardLegacy': 'This entry is a wildcard (provider/*): picking a model converts it to an exact entry',
  'chains.selector.noModelsStrict': 'No models available for this provider (catalog lookup failed); pick another provider.',
  // See the zh comment: the unset value writes no suffix (the hop follows the
  // session); a pinned tier overrides it.
  'chains.selector.effortAria': 'Selector {index} reasoning effort',
  'chains.selector.effortFollow': 'Follow session',
  'chains.selector.effortNone': 'None',
  'chains.selector.effortNoMetadata': 'This model reports no reasoning tiers',
  'chains.selector.effortUnsupported': 'Not supported — sent with the session effort',
  // PR #62 feedback: the main-agent section heading groups the time-slot
  // rows + the all-day chooser; the subagents heading groups roles list +
  // rules.
  'subagents.label': 'Subagents',
  'virtualChain.label': 'Virtual chains',
  'virtualChain.hint': 'Each chain is a standalone virtual route with its own time slots, default chain and chain tail.',
  'chains.tab.add': 'New chain',
  'chains.tab.menu': 'Manage this chain: rename / delete',
  'chains.name.label': 'Chain name',
  'chains.name.hint': 'Display only (tab title and picker prefix); the id "{id}" is the picker route and cannot change after creation.',
  'chains.name.tooltip': 'Give this virtual chain a readable name; the actual route is FallbacksChain/<chain id>, so renaming does not affect sessions already on it.',
  'chains.tab.renameLabel': 'Chain name (display only; id "{id}" stays)',
  'chains.tab.renameDone': 'Done',
  'chains.tab.delete': 'Delete this chain',
  'chains.tab.deleteDisabled': 'Delete this chain (keep at least one)',
  'chains.tab.dirty': ' (unsaved changes)',
  'chains.tab.error': ' (validation error)',
  'chains.empty.title': 'No chains configured',
  'chains.empty.body': 'With no chain configured, no FallbacksChain/* virtual route appears in the model picker; sessions on a FallbacksChain route get no plugin fallback — the host llm-retry alone handles retries.',
  'chains.empty.create': '＋ Create the first chain',
  'chains.chainFoot.hint': 'Saves this chain only: selectors · tail · time slots · name',
  'chains.chainFoot.discard': 'Discard',
  'chains.chainFoot.save': 'Save',
  // Host-policy status area (plan dsh-012-subagent-routing T5 / spec D4).
  // Time-slot rows: extra-row list under Main agent. Timezone picker
  // lives inside expanded custom rows only; preset windows stay UTC+8.
  'timeSlots.label': 'Time slots',
  'timeSlots.hint': 'First match from top to bottom wins · timezone {tz}',
  'timeSlots.empty': 'No time slots configured: this chain runs on its default fallback chain and default model all day.',
  'timeSlots.drag': 'Drag to reorder (or use the up/down buttons)',
  // PR #62 feedback round: collapsible slot rows — collapsed shows the
  // row name + its first model; custom rows carry an editable name.
  'timeSlots.name': 'Name',
  'timeSlots.expand': 'Expand this row',
  'timeSlots.collapse': 'Collapse this row',
  'timeSlots.tooltip': 'First match from top to bottom wins; the all-day row is always last. A matched row\'s model chain becomes the effective root chain (replacing the all-day chain); no match uses the all-day chain. A time-slot switch is a routing seed, not a failure decision: it consumes no cooldown and does not count against the per-request-walk switch cap.',
  'timeSlots.addPreset': 'Add preset',
  'timeSlots.addCustom': 'Add custom time slot',
  'timeSlots.presetPlaceholder': 'Select a preset',
  'timeSlots.remove': 'Remove this time-slot row',
  'timeSlots.moveUp': 'Move this time-slot row up',
  'timeSlots.moveDown': 'Move this time-slot row down',
  'timeSlots.start': 'Start (HH:mm)',
  'timeSlots.end': 'End (HH:mm)',
  'timeSlots.days': 'Days',
  'timeSlots.days.hint': 'None selected = every day; may wrap midnight',
  'timeSlots.customMeta': '{start}–{end} · {days}',
  'timeSlots.days.every': 'every day',
  'timeSlots.preset.liang-peak.label': 'Liang Peak',
  'timeSlots.preset.liang-peak.window': '09:00–12:00 & 14:00–18:00 (Monday–Friday, UTC+8)',
  'timeSlots.preset.liang-peak.meta': '09:00–12:00 · 14:00–18:00 Mon–Fri',
  'timeSlots.preset.liang-valley.label': 'Liang Valley',
  'timeSlots.preset.liang-valley.window': 'All times outside Liang Peak (UTC+8)',
  'timeSlots.preset.liang-valley.meta': 'Off-peak · UTC+8',
  'timeSlots.preset.glm-peak.label': 'GLM Peak',
  'timeSlots.preset.glm-peak.window': 'Monday–Friday 14:00–18:00 (UTC+8)',
  'timeSlots.preset.glm-peak.meta': 'Mon–Fri 14:00–18:00',
  'timeSlots.preset.glm-valley.label': 'GLM Valley',
  'timeSlots.preset.glm-valley.window': 'All times outside GLM Peak (UTC+8)',
  'timeSlots.preset.glm-valley.meta': 'Off GLM Peak · UTC+8',
  // PR #62 feedback: the GLM presets route to zai-coding-cn models — the
  // caveat rides every GLM preset row (shared by both GLM presets).
  'timeSlots.preset.glm.note': 'Only effective when zai-coding-cn is configured',
  // PR #62 UX round 4: cost/multiplier tags on the peak preset rows and
  // the active-slot indicator — literal product strings (zh source of
  // truth); the multiplier carries the `{n}` factor.
  'timeSlots.preset.highCost': 'High Cost',
  'timeSlots.preset.multiplier': 'x{n}',
  'timeSlots.active': 'Active',
  // PR #62 UX round 4 part B: the GLM presets route to zai-coding-cn — the
  // suffix explains why the option is disabled until the provider is
  // configured.
  'timeSlots.preset.glm.unconfigured': ' (requires zai-coding-cn)',
  'timeSlots.day.sun': 'Sun',
  'timeSlots.day.mon': 'Mon',
  'timeSlots.day.tue': 'Tue',
  'timeSlots.day.wed': 'Wed',
  'timeSlots.day.thu': 'Thu',
  'timeSlots.day.fri': 'Fri',
  'timeSlots.day.sat': 'Sat',
  'timeSlots.selector.add': 'Add selector',
  // All-day head (plan fallbacks-timeslots Task 3; PR #62 feedback round):
  // the default-model panel is the official Flash / Pro XOR head of the
  // default fallback chain — separate from the default-chain selector list.
  // Both tails are selectable: the official catalog serves Pro as
  // `deepseek-official/deepseek-v4-pro`.
  'allDay.hint': 'Last-resort tail of the all-day chain; both official providers are usable, the account one is listed first.',
  'allDay.tooltip': 'The chain tail must be an official fallback model (Flash / Pro); that is what the all-day constraint tests, and the other entries are the walk before it.',
  'allDay.only': 'Last-resort tail of the all-day chain; only {provider} is available.',
  'allDay.none': 'No official provider is configured (deepseek-account / deepseek-official), so the chain tail cannot be set.',
  'allDay.option': '{model} ({provider})',
  'allDay.flash': 'Flash',
  'allDay.pro': 'Pro',
  'allDay.account': 'account',
  'allDay.official': 'official',
  'allDay.nonconforming': 'The current default model is not valid: pick official Flash or Pro before saving',
  'roles.list.label': 'Declared roles',
  'roles.list.hint': 'A role is the identity + persona; optionally point it at one named chain via 指定降级链',
  'roles.id': 'ID',
  'roles.id.hint': 'lowercase letters, digits, hyphens; 1–32 chars',
  'roles.idPlaceholder': 'e.g. reviewer',
  'roles.persona': 'Persona',
  'roles.personaPlaceholder': 'e.g. you are a senior code reviewer',
  // Seeded-row read-only UX (plan role-card-seeded-ux): the persona brief's
  // expand/collapse a11y labels and the empty-persona fallback. The source
  // badge localizes the three reserved labels (`bundled` / `external` /
  // the operator's own rows — `external` is the shared unnamed-producer
  // label, plan seeds-source-and-persona-width); only registered set
  // names render verbatim.
  'roles.persona.expand': 'Expand persona',
  'roles.persona.collapse': 'Collapse persona',
  'roles.persona.empty': '(not set)',
  'roles.seedSource.bundled': 'bundled',
  'roles.seedSource.external': 'external',
  'roles.seedSource.user': 'User',
  'roles.chain.label': 'Specified chain',
  'roles.chain.unspecified': 'Not specified (dsh default)',
  'roles.chain.tooltip': 'Manually specify the named virtual chain for this role: children dispatched under it mount on FallbacksChain/<chain id> and that chain owns the fallback. Unspecified ⇒ the plugin does not intervene.',
  'roles.chainMeta.unspecified': 'No chain specified',
  'roles.add': 'Add role',
  'roles.remove': 'Remove role {id} ({chain})',
  // Short visual tooltip: the aria-label above carries the identity, but a
  // nowrap bubble would overflow the row's trailing edge with it.
  'roles.remove.tip': 'Remove this role',
  // Collapsible role panels — collapsed shows the role id + its specified
  // chain route (or "no chain specified").
  'roles.expand': 'Expand role {id}',
  'roles.collapse': 'Collapse role {id}',
  'validation.blocked': 'Configuration validation failed; save was blocked: ',
  'validation.roleIdFormat': 'Role id "{id}" does not match /^[a-z0-9-]{1,32}$/',
  'validation.roleIdReserved': '"inherit" is a reserved role id and cannot be declared',
  'validation.roleIdDuplicate': 'Duplicate role id "{id}"',
  'validation.chainIdFormat': 'Chain id "{id}" does not match /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/',
  'validation.chainIdDuplicate': 'Duplicate chain id "{id}"',
  'validation.chainLabelRequired': 'Chain "{id}" is missing a display label',
  'validation.chainEntriesRequired': 'The default degradation chain cannot be empty: add at least one selector.',
  'validation.allDayRequired': 'The default model must be exactly one official model (Flash or Pro)',
  'validation.slotChainRequired': 'Time-slot row has no models: add at least one chain entry',
  'validation.slotWindow': 'Time-slot start/end must use HH:mm format',
  'validation.slotDays': 'Days must be integers 0–6',
  'validation.slotKind': 'Time-slot kind must be "preset" or "custom"',
  'validation.slotPresetUnknown': 'Unknown time-slot preset "{preset}"',
  'validation.slotPresetDuplicate': 'Preset "{preset}" already exists: at most one row per preset',
  'validation.slotPresetFrozen': 'Preset windows are frozen code constants: a preset row cannot carry start/end/days',
  'validation.selector': 'Invalid selector "{entry}": {message}',
  'legacy.banner': 'Legacy fields detected ({keys}): automatically upgraded to named chains — your previous default chain became chain #0 「默认链」, roles and personas are unchanged, and old per-role chain arrays now read as "not specified" (re-attach them below). Save once to persist this; the plugin never rewrites your config file on its own.',
  'catalog.empty': 'No models yet: add a model on the Models page first; options will appear here automatically.',
  'catalog.error': 'Model catalog read failed: {message}',
  'catalog.partial': 'Some provider model lookups failed: {message}',
  'catalog.outside.hint': 'Outside catalog; the value can be kept',
  'catalog.outside.tooltip': 'Not in the current model catalog; you can keep the original value and save it (new entries are restricted to the catalog).',
  'catalog.outside.short': ' (outside catalog)',
  'catalog.unconfigured.short': ' (not configured)',
  // One shared reason key family for every seat (qc1 F-004): the
  // conversation node resolves reasons through this same map.
  'status.switches.reason.trigger-code': 'trigger code',
  'status.switches.reason.always-cap': 'always-mode cap',
  'status.switches.reason.role-inject': 'role inject',
  'chat.switch.title': 'Model downgraded',
  'chat.switch.summary': '{from} → {to} ({reason})',
  // Role-mapped (role-inject) summary on the conversation node (qc1 F-002 /
  // qc2 F-003 dedupe): the `role → model` mapping is the primary info, so
  // the summary carries only the reason — `{to}` does not appear twice.
  'chat.switch.summary.roleInject': '({reason})',
  'chat.switch.roleMap': '{role} → {model}',
  // Session-header subagent role/model badge (plan subagent-role-badge T3;
  // plan subagent-role-model): neutral "request route" wording because the route
  // is `modelSelection.next ?? lastUsed`.
  'subagentRole.hover': '{role} → {model} (request route)',
  'subagentRole.unresolved': 'unresolved',
  'subagentRole.hoverChain': '{role} → {chain} · {model} ({route})',
  'subagentRole.hoverChainUnresolved': '{role} → {chain} (chain not configured, or no dispatchable model)',
  'defaults.prefix': 'Default',
  'save': 'Save',
  'save.saving': 'Saving…',
  'save.error': 'Save failed: {message}',
  'close': 'Close',
  'loading': 'Loading…',
  'unavailable': 'The fallbacks config channel is unreachable: showing the default configuration (or the last read value). You can try to save; failures will be reported here.',
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

/**
 * Reason → locale key map for switch summaries (shared by the conversation
 * node). All
 * reasons resolve from ONE key family (`status.switches.reason.*`) — the
 * shared reason vocabulary must not mix dictionary families (qc1 F-004). The
 * session log is durable and forward-compatible: a reason value outside the
 * current union (a newer plugin wrote it) renders raw instead of falling
 * into a binary else branch.
 */
export const SWITCH_REASON_KEYS: Readonly<Partial<Record<FallbackSwitchReason, FallbacksKey>>> = {
  'trigger-code': 'status.switches.reason.trigger-code',
  'always-cap': 'status.switches.reason.always-cap',
  'role-inject': 'status.switches.reason.role-inject',
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

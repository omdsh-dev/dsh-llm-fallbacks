---
module: dsh-llm-fallbacks client UI
date: 2026-08-12
last_updated: 2026-08-12
problem_type: best_practice
category: best-practices
severity: low
plan_id: llm-fallbacks-settings-ui-fidelity
applies_when:
  - 复刻/对齐 dsh web 设置 sections（Models/General 等）的视觉形态
  - 为 dsh 插件设置页做 CSS 保真（几何、token、控件形态）
  - 在官方插件配置页自绘卡片 chrome（settings.plugin.item 卡，对齐上游 PluginCard）
  - 评审插件 UI 是否符合宿主 sections 同屏观感
  - 查找 dsh-private 设置 UI 参照文件
tags:
  - dsh
  - ui
  - settings
  - fidelity
  - design-tokens
  - dsw-alias
  - css-modules
  - plugin-card
---

# dsh web 设置 UI 保真参考（参照文件地图 + 几何/token 词表）

在 dsh web 设置面做「与宿主同屏一致」的插件 UI 时，参照哪些文件、用哪些几何与
token 词汇、如何对照与留痕（iter-20260811-fallbacks-mount-only Plan C 验证的方法 +
iter-20260812 插件配置卡扩展）。

## Context

用户对插件设置页的观感要求是「与 dsh web 本体 sections（Models/General）同屏一致」，不是
「和 advisor 差不多」——参照优先级：**dsh web 本体 sections 第一，advisor 第二**。本体 sections
的形态权威在 dsh-private client 包的 `.module.css`；插件 CSS 全部色值必须走
`--dsw-alias-*` token（light/dark 双主题解析），零硬编码色值。对照方法 = 逐维度（几何/
字级/token/控件形态）比对 + 显式记录「用户可见差异」裁决。

## Guidance

### 参照文件地图（dsh-private，只读）

| 代号 | 文件 | 角色 |
|------|------|------|
| MS | `packages/client/ui-models/src/client/ModelsSection.module.css` | 主参照（section 词表 + 行卡 + 输入/胶囊） |
| MSX | `…/ui-models/src/client/ModelsSection.tsx` / `ProviderEditor.tsx` / `DeepSeekModelsEditor.tsx` / `ModelListEditor.tsx` | 结构参照（field、editor、候选行） |
| GR | `…/ui-conversation/src/client/settings/EnterBehaviorRow.module.css` | General 项行（title+desc+控件右置） |
| AR | `…/ui-theme/src/client/AppearanceRow.module.css` | General 项行（16/0 padding + hairline） |
| GS | `…/ui-settings-general/src/client/GeneralSection.module.css` | section 容器（列布局，末项去分隔线） |
| SR | `…/ui-settings-general/src/client/SettingsRoot.module.css` | 外壳几何（panel 800 / options 24 padding） |
| SC | `…/ui-subagent/src/client/SubagentCatalogAction.module.css` | 静默 notice 盒（padding 10/12） |

**已知误导**：`ui-settings/src/client/SettingsRoot.module.css` 不存在（该包仅
contract/index/settings-scope）；外壳几何实际在 `ui-settings-general` 包内。

### 插件配置卡参照（`settings.plugin.item` 卡 chrome，iter-20260812 扩展）

| 代号 | 文件 | 角色 |
|------|------|------|
| PC.tsx | `packages/client/ui-plugin-config/src/client/PluginCard.tsx`（98 行） | 上游卡组件——chrome 契约（`<li>` 折叠列表项：header 按钮 + name/description + dirty pill + chevron + body + footer） |
| PC.css | `…/PluginCard.module.css`（158 行） | 上游卡 CSS——**尺寸权威**（card r12 border-l2 / header padding 14 16 gap 12 / pending pill r999 / footer 等） |
| PCS.tsx | `…/PluginConfigSection.tsx` | 卡列表渲染（section 经 `settings.section` id `plugins` order 30 挂载） |
| SC.ts | `…/slot-contract.ts`（24 行） | `settings.plugin.item` slot 类型（owner `children?: never`——卡自绘） |
| AC.tsx / AC.css | dsh-advisor `src/client/advisor-card.tsx` / `.module.css` | 兄弟插件自绘参考——**chrome 类与上游字节级一致**（advisor 逐字复制上游 chrome 类，仅增 body 通知/表单类）；最接近 fallbacks 需求的自绘参照 |
| ACI.ts | dsh-advisor `src/client/index.ts` | 注册范式（inject + apply + slot.inject） |

**卡 chrome 词表要点**：`--dsw-alias-border-l2`/`bg-layer-3`（卡）、`bg-layer-2`（open）、
name 15px w600 lh1.4 label-primary、description 13px lh1.5 label-tertiary、pending pill
r999 1px 8px bg-module-platform、chevron label-tertiary、body border-top 1px margin 0 16px
padding-bottom 8px、footer gap 8 padding 12 0 4 border-top。折叠态 `aria-expanded` +
`aria-label`（expand/collapse 文案）；dirty pill 骑在 header 上（折叠后仍可见）。


### 几何/token 词表（实测值，落地时须对照 dsh-private 复核）

- **section 容器**：flex column、gap 12、max-width 720、label-primary；title 16/24 w500；
  intro 14/22 label-tertiary；`.rows` 与首卡间距 12。
- **行卡 rowCard**：outlined border-l2 r12、padding 12/14、gap 12；行编辑器 `.editor`：
  r12、bg `--dsw-alias-bg-module-platform`、padding 14/16、gap 14。
- **文本词表**：fieldLabel 12/18 w500 label-secondary；desc/caption 12/18 label-tertiary
  （12/18 是 caption 主词表；不要自造 13/20）；checkbox/候选行 title 14/22 **w400**。
- **输入**：h32、r8、padding 0 10、border-l2、font 14/22、bg-layer-1；focus = border
  brand-primary；disabled opacity 0.6；select max-width 240、chevron 为 12px data-URI
  `#81858C`（双主题共享灰，与本体同源字面量）、padding-right 32、position right 12。
- **按钮**：h36 r18 胶囊、padding 0 14、gap 4、14/22；primary =
  button-primary-fill/label-primary-foreground；secondary = border-l2 透明底；disabled
  opacity 0.4；focus-visible `box-shadow 0 0 0 2px border-l3`；行内 add 为 outline sm
  primitive（h28 r14 12/18）。
- **节奏**：grid/规则网格 gap 8（本体节奏）；numberFields 用
  `repeat(auto-fit, minmax(160px, 1fr))`。
- **iconButton**：28×28、r6、padding 0、label-tertiary；hover
  interactive-bg-hover + label-primary；danger hover interactive-bg-hover-danger +
  state-error-primary；focus-visible 环同按钮。
- **空态**：padding 12、1px dashed border-l3、r8、text-align center、12/18 label-tertiary。
- **状态消息**：本体 sections **无 bordered banner 盒**——`.notice`/`.savedNotice` 是
  12/18 纯 caption 行；需要弱视觉盒时取 SC 静默盒（padding 10/12、无边框）；带
  role="alert" 的语义要求可保留（插件专属需求）。
- **禁用态**：按钮 opacity 0.4 / input 0.6。
- **宿主无 checkbox 先例**：设置行控件形态是 h36 r18 胶囊（Menu/selector）；确需 checkbox
  时保持原生 16px + `accent-color: brand-primary` + focus 环对齐（box-shadow 2px border-l3），
  不要自创宿主没有的控件形态。

### 方法与留痕

1. **逐维度对照表**：维度（容器/卡片/行/字段/输入/网格/候选行/按钮/编辑器/状态块/空态/
   banner/dialog/token）×（本体取值 | 插件现状 | 目标 | 决策：沿用/调整）。值必须来自
   真实 css 文件读取，不靠记忆。
2. **tsx 结构比对先行**：结构已同构 → 全部视觉差异收敛到 CSS 层（T2 只改 css）；
   行为分支、store 交互、aria 结构（role="group" + aria-labelledby、label htmlFor）零改动。
3. **T2 落地清单**：把「调整」项汇总成精确改写列表（旧值 → 新值），「沿用」项显式列出
   证明逐项一致。
4. **用户可见差异裁决记录**：与本体无法同构的点（卡片形态、checkbox、tooltip 等）逐一
   记录差异 + 理由 + 授权口径——评审可据此区分「有意差异」与「漏对齐」。
5. **验证**：light/dark 双主题 + 浏览器 CSSOM 规则生效检查 + 同屏截图——代码级 diff 不足
   为凭（见 build-errors/css-modules-hash-invalid-selector.md）。

### 插件配置卡的已知用户可见差异（iter-20260812 裁决，评审直接引用）

- **Unavailable 态**：上游 `return null`（卡消失）；fallbacks 保留 chrome + 可操作骨架
  （表单仍可写、保存被尝试——KD-G5），与 advisor 同向但更可用（notice 在骨架**上方**）。
- **Reset 按钮**：上游仅 Discard + Save；fallbacks 保留 Reset-to-defaults
  （`/api/fallbacks/reset`，带确认 Modal）——第三方 gateway 方法，记录为有意扩展。
- **Footer 按钮形态**：上游 r8 小按钮（5px 14px）vs fallbacks h36 r18 胶囊——延续
  既有 settings 页按钮词表（brief Global Constraints）。
- **错误面**：上游 save 失败渲染在 footer（`state.failed`）；fallbacks 单 `state.error`
  （load + save 合并）在 body 渲染一次（`role="alert"`），仅表单惰性时给 Retry。
- **read-only 提示门控**：上游 `!writable` 即渲染；fallbacks 加 `status==='ready'` 门控
  ——初始加载窗不闪「只读」。
- **状态块折叠进 body**：原 section 页底只读状态块（有效模型/最近切换）移入卡 body
  （footer 上方），页级 chrome 随 section 删除。

## Why This Matters

- 插件 UI「丑」的根因常是词表/几何级差（如 13/20 与 12/18、w500 与 w400、gap 10 与 8、
  自绘 bordered banner）——按词表逐项对齐即可收敛，无需结构重构。
- 参照文件地图省去每次重新考古 dsh-private（哪个包放 SettingsRoot、哪个 section 最接近）。
- 显式「用户可见差异」记录防止评审把有意差异当缺陷、或把漏对齐当有意。

## When to Apply

- 新插件设置页 / 既有插件设置页 CSS 重写 / UI 保真评审。
- 任何「让插件 UI 像宿主本体」的任务（对照序：本体 sections > advisor）。
- 值在落地前必须对照 dsh-private 当前源码复核（dsh 升级可能漂移；文件路径与词表结构
  是稳定部分，精确像素值需重验）。

## Examples

- iter-20260811-fallbacks-mount-only Plan C：A1–A14 全维度对照表 + C 节 9 条落地清单 +
  「用户可见差异」4 条裁决（卡片形态/checkbox/banner/data-tip），QA CSSOM 全生效。
- iter-20260812 插件配置卡：`guides/card-fidelity-checklist.md` 逐维度对照表（结构/几何/
  tokens/行为/a11y，上游 PluginCard.module.css:1-158 ↔ fallbacks card css）+ 7 条已知差异
  裁决；light/dark 截图 + CSSOM 规则数 == 文本规则数验证。
- 参照实现：`FallbacksCard.module.css` / `FallbacksCard.tsx`（插件侧；2026-08-12 起取代
  整页 `FallbacksSection`）；本体 `ModelsSection.module.css`、`GeneralSection.module.css`
  （dsh-private）。

*Source: iteration iter-20260811-fallbacks-mount-only `guides/ui-fidelity-checklist.md` +
iter-20260812-fallbacks-plugin-config `guides/card-fidelity-checklist.md`，2026-08-12
compound 提升（保留参照地图/词表/方法/裁决，剥离一次性现状快照）。*

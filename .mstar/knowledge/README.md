# Knowledge

| Document | Source Plan | Description | Status |
|----------|-------------|-------------|--------|
| [architecture-patterns/dsh-llm-fallbacks.md](architecture-patterns/dsh-llm-fallbacks.md) | llm-fallbacks-plugin | dsh LLM fallback 双 waterfall 恢复架构（ADR-1..4、链解析、冷却/安全阀、always-cap、状态机、gateway 通道与 KD-G3/种子不变量、入口面、已知限制） | Active |
| [best-practices/dsh-cordis-plugin-authoring.md](best-practices/dsh-cordis-plugin-authoring.md) | llm-fallbacks-plugin | dsh 第三方 cordis 插件创作 playbook（bundle/client/真实包链接 DSH_HOME/构建/设置入口两形态与 gateway 数据面/remote events 失效刷新/事件监听组合顺序与 persona 可读性/关键坑） | Active |
| [workflow-patterns/harness-sandbox-verification.md](workflow-patterns/harness-sandbox-verification.md) | llm-fallbacks-plugin | dsh 沙箱兼容验证模式（scratch DSH_HOME / 只读 git apply --check / 编译级验证） | Active |
| [build-errors/css-modules-hash-invalid-selector.md](build-errors/css-modules-hash-invalid-selector.md) | llm-fallbacks-settings-style | CSS Modules 哈希类名数字开头 → 浏览器静默丢弃样式规则（构建根因 + 双位置契约断言 + CSSOM 验证模式） | Active |
| [build-errors/dsh-client-bundle-purity-gate.md](build-errors/dsh-client-bundle-purity-gate.md) | fallbacks-plugin-config-card | Client bundle purity 门失明缺口：alwaysBundle 静默内联使 require-only 断言失明（94 kB 负向探针实证）；resolveId 门 + emitted-surface token 扫描双层修复 | Active |
| [architecture-patterns/dsh-settings-slot-contract.md](architecture-patterns/dsh-settings-slot-contract.md) | llm-fallbacks-settings-style | dsh web settings slot 契约（settings.plugin.item 插件配置卡/section/general.item/action/onboarding；order tie 语义；navIcon fallback；inject vs register；三个注册面） | Active |
| [architecture-patterns/dsh-gateway-settings-channel.md](architecture-patterns/dsh-gateway-settings-channel.md) | llm-fallbacks-settings-gateway | 插件自有 settings gateway 通道模式（GatewayService + @Remote；wire 契约/KD-G3 无 revision 守卫/KD-G5 可选 settings/reset 语义/种子不变量）——advisor + fallbacks 双实例验证；20260811 remote events 失效刷新 | Active |
| [architecture-patterns/dsh-mount-point-map.md](architecture-patterns/dsh-mount-point-map.md) | fallbacks-mount-map-command | dsh 外部插件挂载点地图（32 seams：settings/gateway/events/commands/会话面/安装面分类 verdict）+ 五列证据标准与可证伪门禁方法 | Active |
| [architecture-patterns/dsh-conversation-surface-mounting.md](architecture-patterns/dsh-conversation-surface-mounting.md) | fallbacks-aux-seams | 会话转录挂载模式：conversationEvents 注册表 + conversation.chat.node keyed 座位双段挂载；纯渲染纪律与 degrade-never-crash（W-001，引擎无 try/catch） | Active |
| [best-practices/dsh-settings-ui-fidelity.md](best-practices/dsh-settings-ui-fidelity.md) | llm-fallbacks-settings-ui-fidelity | dsh web 设置 UI 保真参考（参照文件地图含插件配置卡 chrome、几何/token 词表、逐维度对照方法、用户可见差异裁决） | Active |

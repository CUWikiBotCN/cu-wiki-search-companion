# 灰机平台能力对本地搜索架构的影响

> 调研日期：2026-08-31
>
> 范围：灰机 Wiki 官方帮助、灰机自有 API、MediaWiki 官方 Action API 与前端 JavaScript API。本文记录早期 P1–P5 方案阶段的能力判断。

> 2026-09-07 公开整理说明：下文保留 2026-08-31 的研究时间点和当时建议，外部资料及历史测量未在本次发布中重新验证，不是当前实现规范。当前架构以 [ARCHITECTURE.md](../../ARCHITECTURE.md) 为准：编辑器直接适配 CodeMirror 5 与 textarea，Data 使用独立代码缓存，未引入 EditorAdapter registry、SharedWorker 或新的在线筛选。0.3.4 的结果默认复制纯标题／代码名，插入为显式操作，用户用法见 [README](../../README.md)。

> 实现后补注：后续真实编辑页出现过可见 CodeMirror 5，且再重载时又回到 textarea；因此最终 P1 没有固守本文调研时的“只适配 textarea”建议，而是采用 CodeMirror 5 + textarea 运行时双适配。当前直接适配已在浏览器验证插入与撤销，是否再接 `jquery.textSelection` 留到出现实际兼容问题时决定。

> P1.5 补注：用户随后明确提出“通过中文名找到 Data/MongoDB 对应代码名”。这是一条比通用全文搜索窄得多的映射需求，正式实现因此采用 `/api/rest_v1/namespace/data` 的 `_id + id + locales.zh-CN.name` 投影，500/页、两页约 64KB，缓存进 IndexedDB 后本地搜索。它不把 Mongo 提升为 wiki 事实源，也不改变本文对 P2–P4 页面正文、revision、RC 必须继续走 Action API 的判断。

## 结论先行

**P1–P5 的主架构无需改道。** 灰机提供的 MongoDB/WebAPI 和“搜索器”解决的是 `Data:` 命名空间中的结构化字段筛选，不是跨命名空间全文搜索；灰机自己的文档还把 JavaScript WebAPI 标成实验性，并明确提醒 RESTful API 无缓存、可能经常 504、不宜作为核心功能。MediaWiki 前端 API 能让页面环境检测更规范，但不会替代已经验证过的 Action API 同源抓取。灰机的简繁转换是站点呈现/编辑规则，不是离线查询归一器。

建议保持：

- `api.php` 的 `allpages → revisions/content → recentchanges` 仍是镜像与增量同步的唯一事实入口。
- IndexedDB 中的 `pages` 仍是事实源；MiniSearch、分词结果和快照仍是可重建派生物。
- `opencc-js` 仍同时用于文档侧与查询侧归一；平台简繁转换只可作为未来领域词典的补充信号。
- 编辑器 v1 仍只适配当前实测存在的 `#wpTextbox1`；用 `mw.config` 同时判断 action 与 content model，并优先借用 MediaWiki 的 `jquery.textSelection` 做插入，失败再走原生 textarea fallback。不要为了使用 `mw.Api`/`mw.Rest` 改写已验证的网络层。

## 能力边界与采用判断

| 能力 | 官方资料实际承诺 | 对本项目能替代什么 | 判断 |
| --- | --- | --- | --- |
| 灰机 MongoDB + `/api/rest_v1/namespace/data` | `.json`/`.tab`/`.tabx` 的 Data 页面映射为 MongoDB 文档，按字段做 `find`/`aggregate`/计数；JavaScript WebAPI 被标为实验性 | 最多可另做 Data 子集的结构化筛选 | **不替代镜像或全文索引；P1–P4 不采用** |
| 灰机“快速检索器/自定义搜索器” | 依赖 MongoDB 数据，通过表单控件生成字段条件；文本控件可做大小写不敏感/模糊匹配 | 可为已建模的数据表做商品式筛选 | **不适合任意 wiki 页面全文检索** |
| 灰机 `/api/rest_v1` | 灰机帮助将其主要用途描述为 HTML/Wikitext 转换；另有灰机扩展的 Data 查询路由 | 单页转换或结构化数据访问 | **不替代 Action API 的全量枚举、批量修订、RC** |
| MediaWiki `mw.Api` / `mw.Rest` | 页面内的官方 JS 客户端；`mw.Api` 对应 Action API，`mw.Rest` 对应核心 REST API | 可替换 `fetch` 的调用外观，不能增加服务端能力 | **保留原生 `fetch`；不为包装器增加跨沙箱耦合** |
| `mw.config` / `mw.loader` / `jquery.textSelection` | 读取页面配置、按需加载 ResourceLoader 模块、统一操作 textarea 或 textarea-like 编辑器 | 改善动作/content model 判定、插入和未来适配 | **P1 小范围采用，并保留纯 DOM fallback** |
| 灰机简繁转换 | 管理员申请开启；核心转换表 + 站点 `MediaWiki:Conversiontable/*` + 页面内语言转换标记 | 页面显示变体与标题解析的一部分 | **不能替代本地 term 归一；保留 OpenCC** |

## 1. MongoDB/WebAPI 为什么不能替代本地镜像

灰机的 [MongoDB 支持](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:MongoDB%E6%94%AF%E6%8C%81) 明确限定了数据来源：在 `Data:`（3500）命名空间中，以 `.json`、`.tab`、`.tabx` 结尾的页面会映射到 MongoDB；普通 Data 页面不会映射。`.json` 是一页一个 document，`.tab`/`.tabx` 则把行映射为 document。查询接口是 `find`、`findOne`、`count`、`aggregate` 这类 MongoDB 字段查询。

这与本项目的目标集合不重合：目标约 1817 页，除 658 个 Data 页面外，还有主空间、模板、模块、CSS/JS 等。Mongo API 不提供这些页面的正文，也没有形成 P3/P4 所需的统一 `pageid / revid / contentmodel / 删除移动日志` 事实流。即使仅对 658 个 Data 页面改走 Mongo，也会形成两套分页、错误处理、版本守卫和对账协议，而 Action API 的 revision 内容本来已经能直接返回这些 JSON 文本。

稳定性也不够。灰机 Mongo 文档将 JavaScript WebAPI 标为“实验阶段”；灰机的 [SPA 帮助](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E4%BD%BF%E7%94%A8SPA) 进一步说明其 RESTful API 没有缓存、可能经常 504，并明确“不推荐作为核心功能使用”。灰机 [API 总览](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:API) 则说只有该页列出的 API 才适用于生产环境，并把 `/api.php` 作为标准 MediaWiki API 入口。

官方 [GlobalSearch manifest](https://templatemanager.huijiwiki.com/wiki/Manifest:GlobalSearch) 还提醒接口可能未启用、其结果存在缓存且不会在页面更新后立即刷新；OpenAPI 对 Data 响应只给出宽泛 object schema。若未来做可选结构化筛选，必须先 capability probe，并校验响应形状，不能把返回值直接当强类型持久化数据。

因此：

- 不用 Mongo WebAPI 拉全量 Data 数据，也不用它做增量事实源。
- P2 继续从 `revisions` 获取 BSON/JSON 页原文，在本地解析键和值。
- 如果以后要做“按物品类型/数值范围筛选”，可把 Mongo 查询作为 P5 之后的**独立在线功能**，不能混入离线全文检索的一致性链路。

一次 2026-08-31 的只读探测中，目标站 `/api/rest_v1` 根路径返回 HyperSwitch 的 route 404。这只说明根路径没有可用的发现页，**不能据此推断子路由不存在**；采用判断以上述官方稳定性与数据范围说明为准。

## 2. 灰机“搜索器”为什么不能替代 MiniSearch

[搜索器与检索工具](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E6%90%9C%E7%B4%A2%E5%99%A8%E4%B8%8E%E6%A3%80%E7%B4%A2%E5%B7%A5%E5%85%B7) 所说的“搜索器”更准确地说是结构化数据筛选器：先用 `selection = key::value` 限定 Mongo 数据集，再把文本框、下拉框、单选和复选框绑定到一级字段；`i` flag 提供大小写不敏感和模糊字符串条件。官方页面也明确写着快速检索器“需要配合 MongoDB 数据使用”。

它不具备本项目已经在 P0c 验证的关键性质：

- 不能覆盖任意命名空间的标题与正文；
- 没有 jieba 中文切词、CJK 二元组、拉丁 3-gram、重定向别名加权；
- 没有离线索引、断点恢复、版本守卫和 RC 驱动更新；
- 没有标题/正文双索引与 RRF 排名，也不能保证编辑页的低延迟本地响应。

把全站页面另外转换成 Mongo documents 才能使用它，会把一个浏览器用户脚本变成站点级数据建模和维护项目，并产生第二份服务端派生数据；这是更大的系统，不是简化。

## 3. REST 与 Action API：不要混为一个接口

这里有三个名字相近、实质不同的层次：

1. 灰机历史路径 `/api/rest_v1`，包含 RESTBase/转换能力以及灰机扩展的 `namespace/data` Mongo 路由。
2. MediaWiki 核心 REST API，当前官方说明为比 Action API 更小、更规整的一组操作；见 [MediaWiki REST API](https://www.mediawiki.org/wiki/API:REST_API)。
3. MediaWiki 前端类 `mw.Rest`，其默认地址来自 `mw.util.wikiScript('rest')`；见 [`mw.Rest`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Rest.html)。它不是灰机自定义 `/api/rest_v1/namespace/data` 的专用客户端。

灰机公开的 [`/api/rest_v1/?spec`](https://www.huijiwiki.com/api/rest_v1/?spec) 中，与本项目接近的路由是单页 title/HTML、HTML↔Wikitext 转换和 `namespace/data`；没有 `allpages`、批量 revisions、recentchanges 的等价组合。它适合转换或点查，不具备本地镜像所需的发现—版本—日志闭环。

灰机基于 MediaWiki 1.38.4，而用户给出的前端 JSDoc 是 `master`。因此只能采用明确早已存在且在目标站实测可用的 API，不能因为 master 文档里出现新方法就假定 1.38 有同样行为。

对当前同步任务，Action API 反而精确覆盖需求：

- [`allpages`](https://www.mediawiki.org/wiki/API:Allpages) 官方定义为按命名空间顺序枚举全部页面，有 `apcontinue`，普通上限 500；它还能作为 generator 与 `prop=info/revisions` 组合。
- [`revisions`](https://www.mediawiki.org/wiki/API:Revisions) 能返回 revision id、时间、content model 与 content；官方明确写明请求 content 时 revision limit 会被限制为 50，这与 P2 选择保守小批次的方向一致（多标题请求本身的普通用户 title limit 仍应以目标站 ApiHelp/实测为准）。
- [`recentchanges`](https://www.mediawiki.org/wiki/API:RecentChanges) 返回 edit/new/log 等类型、rcid 与新旧 revision id，并明确警告新记录可能按时间轻微乱序，轮询时应设置重叠区间。这直接支持 P3 已定的 60 秒 overlap + rcid 去重，而不是推翻它。

所以网络层保持同源 `fetch('/api.php?...')`。`mw.Api` 是好用的官方包装器（见 [`mw.Api`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Api.html)），但 Tampermonkey `sandbox-full` 下使用它需要跨 realm 访问页面的 `mw`、等待 `mediawiki.api` 模块，并接收 jQuery Promise；它不会提升限额或绕过 Cloudflare。已经验证的原生 fetch 更简单，也更容易测试与取消。

## 4. 简繁转换为什么仍需 OpenCC

[灰机简繁处理](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E7%AE%80%E7%B9%81%E5%A4%84%E7%90%86) 描述的是 MediaWiki 的语言变体呈现机制：站点需要管理员向灰机申请开启；转换由 MediaWiki 内置表、站点 `MediaWiki:Conversiontable/zh-hans`、`MediaWiki:Conversiontable/zh-hant` 以及页面中的 `-{zh-hans:...;zh-hant:...}-` 标记共同决定。它还要求标题不要简繁混杂，并避免为同一内容建立简繁两份页面。

这些规则解决“同一源码如何显示给不同语言变体用户”，不解决“离线索引中的任意查询词如何与原始标题/正文相遇”。本地搜索需要在没有网络、没有页面 parse、没有站点变体开启的情况下，对文档与查询做相同且确定的归一。故仍应执行 `NFKC + lowercase + OpenCC t2s`。

这条方向还有 MediaWiki 自身实现的直接佐证：1.39 的 [`LanguageZh::normalizeForSearch()`](https://doc.wikimedia.org/mediawiki-core/1.39.9/php/classLanguageZh.html) 默认先转换到 `zh-hans`，源码理由是繁体→简体比反向转换歧义更小。它不能证明 OpenCC 与灰机转换表逐项相同，但能证明“搜索主归一方向选择 t2s”符合 MediaWiki 的中文搜索设计。

MediaWiki Action API 的 `converttitles` 只能在内容语言支持变体时帮助解析输入的**完整标题**，不是全文 term analyzer；它也不能处理正文中的地区词、局部转换标记或用户只输入标题片段的情况。

原始标题和源码必须原样保存在 `pages`；链接、打开页面与插入使用 API 返回的原始标题。精确标题奖励可先比较 raw-NFKC-lower，再比较 t2s，减少 many-to-one 折叠造成的排序损失。

P2 的 wikitext 提取器遇到 `-{zh-hans:...;zh-hant:...}-` 这类显式变体时，不应把整段当噪声删除；应抽取各变体的可见文本并一并送入 analyzer。这里只做保守文本抽取，不完整复刻 LanguageConverter。

可作为 P5 的可选增强：若目标站未来启用转换且两个 `MediaWiki:Conversiontable/*` 页面存在，可通过 Action API 读取其中明确的一对一映射，经过验证后并入领域词典。其变更必须提升 `analyzerVersion` 并触发重建；不要在 P1/P2 动态依赖页面 parse 结果。

## 5. 前端 JavaScript API 对编辑器适配的真实价值

MediaWiki 的 [前端 API 总览](https://doc.wikimedia.org/mediawiki-core/master/js/) 明确把 `mw.config`、`mw.loader`、`mw.Api`、hooks 定义为 user scripts/gadgets 可使用的公共接口。对本项目最有价值的是**读配置和复用官方编辑区抽象**，不是换网络客户端：

- 通过页面 realm 的 `mw.config.get(['wgAction', 'wgPageContentModel', 'wgNamespaceNumber', 'wgVersion'])` 获取可靠环境信号；[`mw.Map#get`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Map.html) 支持一次读取多个键。
- Tampermonkey 沙箱中把访问封装为一个很薄的 `unsafeWindow?.mw?.config` bridge，并保留 URL/DOM fallback；bridge 失败不应阻断搜索。
- P1 仍只在 `wgAction ∈ {edit, submit}`（或 URL fallback 命中）且 `#wpTextbox1` 实际存在时挂载 UI。
- 只有 `wgPageContentModel === 'wikitext'` 时默认插入 `[[标题|显示名]]`；在 BSON、Scribunto、CSS、JavaScript 编辑页，默认动作应是复制原始标题/链接，避免写入对当前语言无意义的 wikitext。
- 把写入封装成 `EditorAdapter`。首选通过页面 realm 加载 [`jquery.textSelection`](https://doc.wikimedia.org/mediawiki-core/master/js/module-jquery.textSelection.html)，对 `#wpTextbox1` 调用 `replaceSelection`。这个官方模块专门操作 textarea/textarea-like 元素，并允许编辑器注册替代实现；其实现会在可用时尝试浏览器 `insertText`。加载/bridge 失败时再退回 `setRangeText`，两条路径都必须在真实 Edge 验证光标与撤销。
- `wgUserVariant` 仅在站点启用语言变体时存在，可以用于 UI 展示偏好；它不应改变索引统一使用 t2s 做召回的规则。

[`mw.loader.using`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.loader.html) 会等待 ResourceLoader 模块及其依赖就绪。P1 只为一次插入按需加载 `jquery.textSelection`，不预加载 CodeMirror/VisualEditor。`mw.hook` 只在以后出现动态编辑器挂载或站点 SPA 导航后才有价值，当前静态 edit 页面无需增加生命周期复杂度。

## P1–P5 逐期影响

### P1 — 标题搜索 MVP

- **不变**：`siteinfo → allpages → pages stub → titleIndex`。
- **小改进**：页面判定优先读取 `mw.config.get('wgAction')`，URL 参数与 `#wpTextbox1` 作为容错；配置 bridge 是 optional，不成为启动依赖。
- **插入边界**：仅在 wikitext content model 提供维基链接插入；优先 `jquery.textSelection`，原生 textarea 作为 fallback。
- **不采用**：灰机快速检索器、Mongo API、`mw.Rest`、服务端 search suggestion。

### P2 — 正文渐进补全

- **不变**：50 页一批的 `revisions + rvprop=content|contentmodel`，按 content model 本地提取。
- **证据强化**：官方 Revisions 文档明确 content 请求会收紧 revision limit；不应为 Mongo Data 子集另建同步通道。
- **提取补充**：对 wikitext 显式简繁/地区变体标记，保守抽取各分支可见文本，而不是整段丢弃。
- **可测试项**：Data JSON 提取结果与 Mongo 示例页字段可做交叉抽查，但 Mongo 返回不能成为断言所依赖的在线服务。

### P3 — 增量同步

- **不变且被官方文档强化**：RC 可能轻微乱序，应保留 overlap + rcid 去重。
- **不采用**：轮询 Mongo；其官方资料没有提供等价的 move/delete/restore 日志和 revision 单调性保证。

### P4 — 可靠性与对账

- **不变**：`generator=allpages + prop=info` 对 `lastrevid`，快照由本地 `pages` 重建。
- **原因**：Action API 同时给页面身份、revision 和日志；Mongo 只是一份由 Data 页面派生的服务端视图，不能反过来成为 wiki 事实源。

### P5 — 体验增强

- 可把站点转换表中的经过验证的一对一条目作为领域词典候选；仍需版本化和全量重建。
- 若将来用户明确需要结构化过滤，可新增“Data 字段筛选”模式；UI 与缓存状态要明确标为在线/实验性，不能和本地全文结果混成同一可靠性承诺。
- CodeMirror/VE 适配应使用 adapter registry + feature detection，出现真实编辑器后再接 `mw.loader`/相关 hooks。

## 最终采用清单

### 现在采用

- 保持 Action API 单一同步管线。
- 在 P1 增加一个只读、可失败的 `mw.config` bridge，用于 `wgAction`、`wgPageContentModel` 等环境信号。
- P1 插入封装为 adapter：`jquery.textSelection` 优先，原生 textarea fallback；非 wikitext 默认不插入维基语法。
- 把 RC 官方“可能乱序”说明写入 P3 测试理由，保留 60 秒重叠。
- 保持 OpenCC 双侧归一与 `analyzerVersion` 机制。

### 明确不采用

- 用 `/api/rest_v1/namespace/data` 替代 Data 页 revision 抓取（P1.5 只取中文名→代码名三字段投影，不抓正文或版本事实）。
- 用灰机快速检索器替代 MiniSearch。
- 用 `mw.Rest` 访问或包装灰机自定义 `/api/rest_v1`。
- 依赖服务端 parse/语言变体来生成本地索引 token。
- 为当前不存在的 CodeMirror/VE 预先引入编辑器框架依赖。

### 以后有证据再采用

- 站点 conversion table → 领域同义词词典。
- Mongo Data 字段筛选 → 独立在线增强。
- `mw.loader`/hooks → 动态编辑器 adapter。

## 来源

- 灰机 Wiki：[API](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:API)、[REST OpenAPI](https://www.huijiwiki.com/api/rest_v1/?spec)、[MongoDB 支持](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:MongoDB%E6%94%AF%E6%8C%81)、[搜索器与检索工具](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E6%90%9C%E7%B4%A2%E5%99%A8%E4%B8%8E%E6%A3%80%E7%B4%A2%E5%B7%A5%E5%85%B7)、[GlobalSearch manifest](https://templatemanager.huijiwiki.com/wiki/Manifest:GlobalSearch)、[简繁处理](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E7%AE%80%E7%B9%81%E5%A4%84%E7%90%86)、[使用 SPA](https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E4%BD%BF%E7%94%A8SPA)
- MediaWiki Action API：[Allpages](https://www.mediawiki.org/wiki/API:Allpages)、[Revisions](https://www.mediawiki.org/wiki/API:Revisions)、[RecentChanges](https://www.mediawiki.org/wiki/API:RecentChanges)、[REST API](https://www.mediawiki.org/wiki/API:REST_API)
- MediaWiki 前端/语言 API：[总览](https://doc.wikimedia.org/mediawiki-core/master/js/)、[`mw.Api`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Api.html)、[`mw.Rest`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Rest.html)、[`mw.loader`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.loader.html)、[`mw.Map`](https://doc.wikimedia.org/mediawiki-core/master/js/mw.Map.html)、[`jquery.textSelection`](https://doc.wikimedia.org/mediawiki-core/master/js/module-jquery.textSelection.html)、[`LanguageZh::normalizeForSearch`](https://doc.wikimedia.org/mediawiki-core/1.39.9/php/classLanguageZh.html)

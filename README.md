# CU Wiki Search Companion

在[未知伤亡中文维基](https://casualtiesunknown.huijiwiki.com/)编辑页面中，快速查找页面、正文、文件、Lua 模块和 Data 代码。搜索数据保存在当前浏览器；点击结果即可复制标题或代码名，也可以打开页面或插入维基链接。

脚本仅在本站的编辑／提交页面激活，不会替你保存或提交 Wiki 编辑。

## 安装与开始使用

1. 在桌面浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [Nightly 安装链接](https://github.com/Werewolf-Wu/cu-wiki-search-companion/releases/download/nightly/cu-wiki-local-search.user.js)，在 Tampermonkey 中确认安装。也可从 [Nightly 下载页](https://github.com/Werewolf-Wu/cu-wiki-search-companion/releases/tag/nightly)获取脚本和校验和。
3. 打开本站任意页面的编辑界面，点击右下角“本地搜索”或按 `Alt+K`。
4. 首次使用需要联网准备本地数据。输入关键词并选择搜索类型；准备进度及失败原因会显示在状态栏中。

Nightly 是自动化开发构建，不是独立稳定版发行。更新时重新打开安装链接；不要同时启用多份本脚本。发布源码推送后，下载产物还需等待自动构建完成。

## 搜索类型

| 类型 | 可以搜索什么 |
| --- | --- |
| 页面标题 | 中文标题、英文片段、前缀，可筛选命名空间 |
| 页面正文 | wikitext 与 BSON（JSON）正文、键和值，显示命中摘要 |
| Data 代码 | 中文名、英文代码片段或已配置字段，返回代码名及来源 |
| Lua 模块 | 函数名、返回表键、字符串和依赖目标 |
| 文件资源 | 文件名、片段及扩展名 |

五类结果各自检索，不混排。正文模式可分别开关标题／正文高亮并调整颜色，设置会保留。

## 结果怎么用

**点击结果主体，或在搜索框中按 `Enter`，默认复制纯内容。** 例如复制 `凝血糊剂`，而不是 `[[凝血糊剂]]`；Data 复制代码名。页面标题保留原始命名空间，Lua 复制完整模块标题。

普通标题、正文和文件结果右侧提供：

| 小按钮 | 行为 |
| --- | --- |
| 打开 | 在新标签页打开结果，保留当前搜索 |
| 复制插入内容 | 复制带 `[[ ]]` 的维基链接，供你自行粘贴 |
| 插入 | 将同样的维基链接插入编辑器，关闭面板并返回编辑器 |

标题和文件链接使用搜索词作为显示文字，正文结果使用页面标题。文件、分类使用普通链接语法，不会因此嵌入文件或添加分类。支持 CodeMirror 5 和普通文本编辑框。

Data 和 Lua 只提供复制主体与打开来源，不自动生成模板或模块调用。非 wikitext 编辑页不显示“插入”。复制不会关闭面板；复制插入内容也不会改动编辑器。

## 快捷键

| 按键 | 操作范围与行为 |
| --- | --- |
| `Alt+K` | 打开／关闭面板，关闭后回到原焦点 |
| `Tab` / `Shift+Tab` | 在面板内正向／反向切换焦点，并在首尾循环 |
| `↑` / `↓` | 在搜索框中选择上一条／下一条结果 |
| `Enter` | 在搜索框或结果主体上复制纯标题／代码名 |
| `Ctrl+Enter` / `Cmd+Enter` | 在搜索框或结果主体上打开对应页面 |
| `Shift+Enter` | 在搜索框或结果主体上插入；仅限支持插入的结果和编辑页 |
| `Enter` / `Space` | 焦点位于小按钮上时，执行该按钮自己的操作 |
| `Esc` | 关闭面板；正在拖动时先取消拖动 |

快捷键不会接管面板外的输入。鼠标点击编辑器或其他站点区域后，键盘操作交还站点。中文输入法组词期间不触发结果快捷键；原生复制、粘贴和文本选择保留。没有额外的首次使用弹窗或快捷键设置页。

## 面板与本地维护

- 面板随窗口宽度调整并限制在可见区域内，顶部搜索和关闭控件保持可用；设置、维护和结果共享内容滚动区。
- 长状态预览两行，可展开并复制全文。
- 宽屏可拖动标题区域，或聚焦标题后用方向键移动，`Shift+方向键` 微调；“恢复默认位置”回到右下角。位置仅在当前页面关闭重开时保留。
- 界面沿用本站主题色，高亮底色自动搭配可读的文字颜色。
- “本地数据与维护”可以查看诊断、重建索引、修复正文队列、清除派生快照或申请持久保存。
- “重新同步本地数据”和“立即全量对账”需要联网读取 Wiki，但不会清空镜像或修改 Wiki 页面；文件资源单独同步。
- “清空本地镜像”有二次确认，下次需要重新联网准备数据。不要把它当作普通刷新按钮。

## 隐私与常见问题

数据保存在本站来源下的专用 IndexedDB；Data 字段规则及高亮设置保存在 Tampermonkey preference。完整重置默认保留设置，仅在显式勾选时重置 Data 规则。脚本不收集遥测、不上传本地镜像，也不提供云同步或跨浏览器迁移。

**为什么阅读页面没有按钮？** 脚本仅在编辑／提交页面使用。

**网络或登录失效还能搜索吗？** 已保存的本地数据仍可搜索；新数据需要恢复网络或登录后同步。尚未缓存的内容无法离线检索。

**为什么切到后台后准备过程暂停？** 重型索引按需加载，并在页面可见时推进；切回前台会继续。后台暂停或浏览器卸载标签页不代表本地事实被清空。

**手机可以用吗？** 布局包含窄窗口适配，移动端按 Best-Effort 支持，根据实际使用反馈修复；不承诺完整设备或软键盘兼容矩阵。

## 开发与发布记录

当前源码版本为 **0.3.6**。本版包含 Vue 3 界面迁移、可配置的原生浏览器验收工具和安装确认页清理修复；变更、验收范围及运行开销见 [0.3.6 验收记录](docs/acceptance/0.3.6.md)。

此前的 Firefox 光标修复见 [2026-09-07 的 0.3.5 验收记录](docs/acceptance/0.3.5.md)；历史记录见 [0.3.4](docs/acceptance/0.3.4.md)、[0.3.3](docs/acceptance/0.3.3.md) 和 [0.3.1](docs/acceptance/0.3.1.md)。不同构建的结果不混作本次实测，也不据此声称其他部署成功。

单元／集成测试统一放在 `tests/` 并按模块分类；真实浏览器安装、诊断和验收工具保留在 `scripts/`。新增测试请遵循[测试目录规范](ARCHITECTURE.md#131-测试文件归属与执行边界)。

本地开发要求 Node.js `^20.19.0` 或 `>=22.12.0`，以及 npm：

```bash
npm ci
npm test
npm run typecheck
npm run build
```

界面采用 Vue 3 SFC，模板在构建时编译，运行时随脚本打包；样式注入开放的 Shadow DOM。`npm run typecheck` 使用 `vue-tsc` 同时检查 TS 与 Vue 模板，`build` 已包含此检查。当前类型工具链固定 TypeScript 6.0.3，因为已验证的 `vue-tsc` 尚不能加载 TypeScript 7 的编译器入口；升级时需一起验证。组件边界见[界面架构](ARCHITECTURE.md#11-ui编辑器与维护)。

`dist/` 中生成可安装的 `cu-wiki-local-search.user.js`、更新元数据和第三方许可清单；构建产物不进入 Git。

### 配置真实浏览器验收环境

以下供开发者复刻环境。常规验收选择有头 Chrome 或 Edge 即可；单元测试不依赖浏览器、账号或网络。操作脚本使用 Bash、curl 和 Node.js；Windows 可在支持这些工具的终端中运行，浏览器路径按实际系统配置。

1. 安装所选浏览器并核对版本；核对 `node --version`、`npm --version`、`bash --version`、`curl --version`。安装 CLI：`npm install --global @playwright/cli@0.1.19`，再检查 `playwright-cli --version`。这是已验证的工具版本，升级后应重新运行下方环境预检。
2. 设置 `CU_WIKI_BROWSER_PATH` 为浏览器可执行文件或 PATH 中的命令名，运行 `npm run browser:start`。默认命令为 `google-chrome`，profile 为已忽略的 `.local/browser-profile`，CDP 只监听 `127.0.0.1:9222`。macOS/Windows 或 Edge 用户设置自己的浏览器完整路径；含空格的路径作为一个环境变量值传入。需要更换时使用 `CU_WIKI_BROWSER_PROFILE`、`CU_WIKI_CDP_PORT`，启动和验收终端须使用一致的端口配置。不要使用日常 profile，也不要让两个进程同时占用同一 profile。
3. 在这个专用窗口中从官方商店安装 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/)，确认扩展启用、站点访问范围包含 Wiki。

   **开启浏览器的“允许用户脚本”权限。** 以 Edge 为例：点击浏览器右上角的 **“扩展”（拼图图标）** → 找到 **Tampermonkey／篡改猴** → 点击其右侧的 **“…”（更多操作）** → **“管理扩展”** → 在详情页向下找到并开启 **“允许用户脚本”**。扩展顶部的启用开关与“允许用户脚本”是两个独立开关，均需开启。这项设置位于浏览器的扩展管理页面；Chrome 等浏览器按对应版本的扩展详情页操作，参见 [Tampermonkey 说明](https://www.tampermonkey.net/faq.php?q=Q209)。

4. 在同一窗口内**自行登录具有编辑权限的 Wiki 账号**，可选择记住登录状态；打开编辑页确认可以编辑，无需保存测试编辑。站点账号权限与上一步的扩展权限是两回事，不把密码或 Cookie 写入配置、日志和 Git。
5. 在另一个终端依次运行下面的预检、安装和实际操作验收。安装器构建当前代码，比较服务返回字节与本地 dist，再核对实际注入的版本和唯一 build marker。安装后在 Tampermonkey 管理面板确认本项目脚本已启用；浏览器允许用户脚本执行、扩展启用和具体脚本启用需同时满足。

```bash
# 示例：两个终端使用相同端口；可执行文件和 profile 可另行配置。
export CU_WIKI_CDP_PORT=9222
# 终端一：保持运行，关闭专用浏览器窗口结束。
npm run browser:start

# 终端二：保持测试窗口在前台。
bash scripts/run-browser-playwright.sh scripts/test-browser-lifecycle.playwright.js
npm run install:userscript
bash scripts/run-browser-playwright.sh scripts/test-search-panel-actions.playwright.js
```

环境预检创建两个临时标签，核对同一窗口、切换后的可见性/焦点、后台动画帧暂停及短期定时器限速。它不替代长时间多标签压力测试。启动器使用普通浏览器参数；不要添加关闭后台限速的自动化选项。已有浏览器可通过 `CU_WIKI_CDP_ENDPOINT=http://127.0.0.1:<端口>` 接入，包装器结束只 detach；旧 `run-edge-playwright.sh` 保留为兼容入口。

关闭专用浏览器后，用相同配置重启，复查 Tampermonkey、允许用户脚本、Wiki 登录及脚本版本/build marker，再运行实际操作验收。profile 持久保存，`.local/` 不进入 Git。安装器默认创建短期 loopback 服务，退出时关闭；如果端口已有提供相同构建的服务，则复用并保留。`CU_WIKI_USERSCRIPT_URL` 可指向自行维护的当前构建服务。

常见排查：CDP 不可达时核对可执行文件、端口、图形窗口和专用 profile；[Chrome 不支持在默认用户目录上启用远程调试](https://developer.chrome.com/blog/remote-debugging-port)。端口占用时选择另一端口，不连接未知浏览器。安装确认页未出现时检查 Tampermonkey 和用户脚本权限；Wiki 无编辑框时检查站点登录与权限。页面加载或交互超时后停止该阶段，检查日志和前台状态，不连续重试。涉及离线验证时，先证明请求确实断网；Service Worker 可能使普通页级请求拦截不足以隔离网络。

GitHub Actions 在 push 后测试和构建，main 成功后更新唯一的滚动 Nightly；更新列表取自提交标题。开发者无需为每次提交手动建立 tag 或 Release。

数据模型、按需加载、同步和维护约束见 [架构文档](ARCHITECTURE.md)。[灰机平台能力研究](docs/research/huiji-platform-capabilities.md)是注明日期的历史研究，不替代当前架构或验收结论。

## License

本项目采用 [Mozilla Public License 2.0](LICENSE)。分发修改过的 MPL 文件时，应按许可证提供这些文件的源码；构建产物另附第三方依赖许可清单。

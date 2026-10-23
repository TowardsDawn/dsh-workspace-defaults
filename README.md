# Workspace Defaults

> 为每个工作区分别设置**新会话的默认预设**与**默认模型**——已有会话不受影响。

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Host%20Plugin-4B6BFB)
![Format](https://img.shields.io/badge/module-ESM-8A2BE2)
![Scope](https://img.shields.io/badge/scope-per--workspace-2EA043)

**Workspace Defaults** 是一个 DeepSeek Harness（DSH）Host 插件。它允许你按工作区目录保存「默认预设 + 默认模型」，该工作区下**新建**的会话会自动采用这些默认值；已有会话保持自己的选择，会话内切换预设/模型也完全不受影响。

---

## 目录

- [为什么需要它](#为什么需要它)
- [特性](#特性)
- [安装](#安装)
- [使用](#使用)
  - [设置面板](#设置面板)
- [配置](#配置)
- [工作原理](#工作原理)
- [目录结构](#目录结构)
- [兼容性与限制](#兼容性与限制)
- [FAQ](#faq)
- [License](#license)

---

## 为什么需要它

DSH 的默认预设和默认模型是**全局**的：所有工作区共享同一份默认值。但真实使用中，不同目录往往对应不同场景：

- `~/work/project-a` 需要完整的编码预设和强模型；
- `~/notes` 只想聊天，使用「聊天模式」和更轻的模型；
- `~/scripts` 想默认走命令行预设。

在 DSH 里每次新建会话都手动选一遍既繁琐又容易忘。Workspace Defaults 把这层选择沉淀到工作区上：**同一目录，新会话自动带上你想要的预设和模型。**

---

## 特性

- 🗂️ **按工作区隔离**：以工作区目录为键，Windows 路径大小写不敏感、末尾分隔符自动归一化。
- 🧩 **默认预设**：新建会话时，若调用方没有显式指定预设，自动使用该工作区的默认预设。
- 🤖 **默认模型**：新建会话时自动使用该工作区的默认 provider / model。
- 🛡️ **只影响新会话**：已有会话的预设、模型、后续请求都不变。
- 🔁 **不劫持用户操作**：会话内切换预设、切换模型的功能保持原样。
- 🧪 **设置时校验预设**：写入前确认预设 id 真实存在；若默认预设之后被删除，创建会话会安全回退到全局默认，不会阻断创建。
- 💾 **简单持久的存储**：单一 JSON 文件，原子写入，无数据库依赖。

---

## 安装

### 从 GitHub 安装

```bash
dsh plugin --profile web add "https://github.com/TowardsDawn/dsh-workspace-defaults"
```

### 卸载

```bash
dsh plugin --profile web remove "@TowardsDawn/dsh-workspace-defaults"
```

---

## 使用

### 设置面板

安装后，在 Web 界面打开 **Settings → 工作区默认**：

1. 在「工作区目录」中输入或选择目录（输入框带工作区下拉建议）；
2. 选择「默认预设」（预设来自 `agentPresets.list()`）；
3. 选择「默认模型」的 provider 与具体模型；
4. 点击「保存」。

页面下方列出所有已配置的工作区，可直接删除某一项。

- 设置只影响该工作区**之后新建**的会话；
- 已有会话保持自己的预设与模型；
- 会话内切换预设/模型不受影响。

面板数据来自本插件的两个端点：`GET /workspace-defaults/api/state` 与
`POST /workspace-defaults/api/set|unset`。

---

## 配置

默认值保存在：

```
$DSH_HOME/workspace-defaults.json
```

Windows 默认位置：`C:\Users\<user>\.dsh\workspace-defaults.json`

```json
{
  "version": 1,
  "workspaces": {
    "E:\\projects\\app": {
      "agentPreset": "standard",
      "model": { "provider": "llama", "model": ".\\models\\qwen3-8b-q4_k_m.gguf" }
    },
    "E:\\notes": {
      "agentPreset": "chat"
    }
  }
}
```

- 键为工作区目录；匹配时忽略大小写与末尾分隔符，并按绝对路径归一化。
- 字段均可独立存在：只设置预设、只设置模型，或两者都设置。
- 删除某个工作区的条目等同于恢复全局默认。
- 写入采用「临时文件 + rename」的原子替换；并发写串行化，避免半截文件。

---

## 工作原理

插件只在一个位置介入：**新会话的创建链路**。

```
Web UI / CLI
   │
   ▼
sessionController.createSession(request)      ◀── ① 预设：request.agentPreset 未指定时
   │                                              按 request.cwd 补全工作区默认预设
   ▼
composeAgent(request.agentPreset)             ── agentPresets.resolve + mount
   │
   ▼
sessionController.createAgent(sessionId, cwd) ◀── ② 模型：在本次调用的异步链内
   │                                              用 AsyncLocalStorage 覆盖
   │                                              agentDefaultModel.currentSelection()
   ▼
agents.create({ agentOptions, meta, setup })
```

**为什么已有会话不受影响**

- 预设注入只发生在 `createSession`（新建）入口；会话内换预设走 `agentPresets.select`，不经过这里。
- 模型覆盖只在 `createAgent` 的执行期间通过 `AsyncLocalStorage` 生效，并且只覆盖该次新建会话的 `agentOptions`；已有会话的请求头里记录的是它自己的模型。
- 若调用方显式指定了 `agentPreset`，插件完全让路，不读取工作区配置。

**为什么并发安全**

`AsyncLocalStorage` 让每个 `createAgent` 调用拥有独立的覆盖值，多个会话同时创建时互不串扰；其它调用 `currentSelection()` 的代码（如设置页）仍然拿到全局默认。

---

## 目录结构

```
dsh-workspace-defaults/
├── package.json          # bundle 清单：dsh.bundle.patch、dsh.client、包入口导出
├── cordis.patch.yml      # Host 层插入 workspace-defaults 行
├── lib/
│   ├── index.js          # Host：创建链路注入、HTTP 数据接口
│   └── client.js         # Client：Settings 面板「工作区默认」
└── README.md
```

`package.json` 把插件入口暴露在包根（`main` + `exports["."]`），因此散件补丁可以直接用裸包名引用，与 `dsh-noteboard` 等插件写法一致；`./client` 是浏览器侧入口，由 `dsh.client` 声明：

```json
{
  "name": "dsh-workspace-defaults",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./plugin": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

---

## 兼容性与限制

- 设计面向 DSH 的 Host 服务：`sessionController`、`agents`、`agentPresets`、`agentDefaultModel`、`llm`、`workspaceRegistry`、`webServer`、`tools`、`workingDirectory`。
- 工作区以**目录路径**为键：同一目录即同一工作区；移动目录后需要为新路径重新设置。
- 模型 id 不做联网校验，只按原样写入；请确保 provider / model 在你的 DSH 配置中存在。
- 预设 id 在设置时会通过 `agentPresets.resolve` 校验；创建时若该预设已消失，会**静默回退**到全局默认，保证会话创建不被阻断。
- 图形化入口是 **Web 设置面板**（`settings.section`）；TUI / ACP 没有该界面，也没有模型可调用的工具，配置仅通过 Web 面板完成。

---

## FAQ

**Q：会影响正在运行的会话吗？**
不会。插件只在新建会话时读取配置。

**Q：我在会话里手动换了模型，会被改回去吗？**
不会。默认值只在创建时注入一次；之后的选择走 `model/selection`，与本插件无关。

**Q：同一目录在不同盘符大小写写法下会重复吗？**
不会。匹配前会做绝对路径归一化并忽略大小写（Windows 语义）。

**Q：可以只清除其中一项吗？**
可以。把对应下拉框选成「（不设置）」再保存即可。

---

## License

[MIT](LICENSE)

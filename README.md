# dsh-basic-memory-bridge

把官方 Basic Memory 接入 DeepSeek Harness 的个人长期记忆流程。非官方插件；MIT。

- 回答前分别召回事实、索引导航和个人记录。
- 成功回合后自动整理；支持事实更新、纠正、历史保留与失败补写。
- 自动建立和调整主题索引，索引导航最终读回当前事实。
- 事实、想法与日记自然降权；有新交流依据时适度强化，自己读写不加权。
- `dafeiyu_records` 提供想法、日记、人物印象及本地图片收藏；自我档案固定上下文由独立人设插件提供。

## 前置与安装

适配基线：DSH 0.2.1-rc.2、Basic Memory 0.24.1、Node.js 22.19+ 或24+。

[Basic Memory 官方仓库](https://github.com/basicmachines-co/basic-memory)、[官方安装说明](https://docs.basicmemory.com/local/local-install)：

```powershell
uv tool install basic-memory==0.24.1
```

[Obsidian 官方发布仓库](https://github.com/obsidianmd/obsidian-releases)：

```powershell
winget install --exact --id Obsidian.Obsidian --source winget
```

不打包这两个软件、虚拟环境、个人 Vault 或数据库。Obsidian客户端不适用本仓库 MIT 许可。

在自己选定的独立 Harness profile 安装：

```powershell
dsh plugin --profile web add github:XRH66/dsh-basic-memory-bridge
dsh plugin --profile web add github:u9521/dsh-session-settings#237537bb11663fd02bb14e5b415c92ff1a4320cd
```

第二项为第三方 [dsh-session-settings](https://github.com/u9521/dsh-session-settings)，用于添加及按会话启用 MCP。固定提交对应 2026-10-25 的 dist；升级时先检查其与 Harness 的兼容性。

## 连接 Basic Memory

1. 在仓库外选择数据目录，创建其 `vault` 子目录。设置 `BASIC_MEMORY_CONFIG_DIR` 为同一数据目录下的 `basic-memory-state`，使项目登记与MCP使用相同配置。
2. 用官方CLI登记：`basic-memory project add personal <vault绝对路径> --local`。
3. 在 dsh-session-settings 导入 MCP JSON，server名称必须是 `basic_memory`：

```json
{
  "mcpServers": {
    "basic_memory": {
      "command": "basic-memory",
      "args": ["mcp", "--project", "personal"],
      "env": { "BASIC_MEMORY_CONFIG_DIR": "<与登记时相同的绝对路径>" }
    }
  }
}
```

4. 按实际环境替换尖括号内容；若服务进程找不到命令，使用 `Get-Command basic-memory` 返回的实际程序路径。探测工具后，只在需要个人记忆的聊天会话勾选此MCP，确认模型可见 `mcp__basic_memory__search_notes`、`read_note`、`write_note` 等。工程派工工作区保持关闭；若已有全局启用，先在工程工作区显式覆盖关闭，再创建worker会话，避免工程简报被自动保存。
5. 给 `id: basic-memory-bridge` 的 Cordis配置设置 `project: personal`、`vaultPath: <同一个vault绝对路径>`。该插件不会替你挂载MCP，也不会自动修改会话开关。

所有启用会话共享 `personal` 库。默认本地文件路径取 `DSH_MEMORY_VAULT`，未设置时为用户主目录 `codex-deepseek-data/vault`；显式 `vaultPath` 优先。管理状态及人工待审清单在Vault同级 `management/`，不进入记忆索引。

## 可选人设和状态面板

[dsh-global-settings](https://github.com/XRH66/dsh-global-settings)独立提供全局人设、自我档案与当前会话记忆状态显示。双方需要指向相同的自我档案及管理目录；没有它也能执行本插件的记忆流程。

## 参数与边界

默认事实召回3条/1200字符，个人记录2条/1600字符，索引1页/600字符，前台各有1.5秒预算。遗忘默认30天半衰期、普通召回门槛0.1、权重底值0.01；降低检索权重，不自动物理删除。强化沿用既有模型整理调用、24小时冷却和持久操作标识；语义判断仍可能漏记或误记。

自我档案不参加日常遗忘。日记每天最多3条，想法和日记按条目独立计算权重，主观内容不当作用户事实。索引目前不自动合并、拆分、删除或重命名主题。

代码限制该插件所在agent调用永久删除工具，但这不是Basic Memory服务端的访问控制；其他客户端仍由其自身权限决定。当前不提供多人或群聊的隐私隔离。全部参数以 [lib/config.js](lib/config.js) 为准。

## 开发与升级

```powershell
npm ci
npm test
npm run privacy
```

测试使用虚构工具、临时Vault和模拟模型，不读取正式库。部分状态互操作测试使用独立人设插件的已固定版本。

升级在会话空闲时更新选定profile的插件并重载；不要在补写队列未处理完时切换数据目录。配置、Vault与管理目录在仓库外。完整新系统安装及真实模型闭环尚未在本发布副本验证。

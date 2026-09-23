# Provider connections and model.yml

## 中文

模型设置新增“本地服务连接”。先添加连接，再批量粘贴模型 ID 或获取模型列表；地址与 Key 只填写一次。页面保存与 `model.yml` 读取使用同一份配置，云端下发模型、原有 Codex 账号及云端执行权限保持独立。

默认文件为应用用户数据目录下 `model-connections/model.yml`。可选择自定义 YAML 文件、打开文件编辑，保存后点击“重新加载”。当前版本不自动监听外部文件变化。页面保存采用文件版本检查及原子写入；外部编辑冲突不会被覆盖。无效文件保留上一份有效配置并报错。

```yaml
version: 1
providers:
  - id: relay
    name: 我的中转
    base_url: https://gateway.example/v1
    api_format: openai-responses
    # Key 可在页面填写，保存后改为本机安全凭据引用。
    models:
      - id: coding
        model_id: upstream-model-id
        display_name: 主力编程
```

支持 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。模型默认继承连接协议，也可以用 `api_format` / `request_path` 单独覆盖。模型 `id` 是稳定的本地身份，`model_id` 是发给上游的标识；改名称时不要更改 `id`。可用模型级 `catalog_entry` 保留高级能力配置。模型列表可设置 `models_path`，默认 `/models`；列表不可用时仍可手动添加，获取列表不代表已验证工具调用能力。

“迁移旧模型”先持久化 Provider 配置，再清除对应旧记录，并保留已有模型 ID 与能力配置。迁移按地址、Key、协议和路径分组，不按模型品牌合并。云端目录不会被迁移或写入文件。

页面不回显完整 Key，不把新 Key 写入 localStorage。页面保存时使用已有桌面安全存储，YAML 中记录 `api_key_ref`。文件也支持显式 `api_key`，但这是明文，不要提交或分享；下次页面保存会将它换为本机凭据引用。凭据引用不能在另一台机器直接使用，需要重新录入 Key。

更改自定义模型能力后，沿用现有 Codex catalog 写入与空闲重启/确认机制。不会因为加载文件就上传全部连接或强制中断正在运行的任务。删除正在引用的模型时保留历史任务身份，重新执行需要选择可用模型。

## English

Local Provider connections share one endpoint and credential across multiple models. The settings page and the bound YAML file use the same native configuration service. Cloud catalogs, Codex account sources and remote execution permissions remain separate.

Use **Choose YAML**, **Open file**, and **Reload** to maintain a file. External changes require an explicit reload in this version. Stale form saves are rejected; malformed files retain the encrypted last-known-good snapshot. Files are written atomically with owner-only permissions; model IDs survive migration and renames.

The UI stores keys in the existing native secure value store and writes `api_key_ref` into YAML. Explicit inline `api_key` is supported for local editing but must never be committed or shared. References are machine-local. Discovery lists candidates only; it does not verify inference or tool execution. Existing catalog synchronization and restart confirmation are retained.

---
sidebar_position: 90
---

# 本地 Provider 与 YAML 配置

## 使用

设置 → 模型 → 服务连接（Provider）。填写一次 Base URL 和 API Key，在同一连接下手动添加、批量粘贴模型 ID，或获取列表后多选添加。显示名称、启停和模型顺序都在连接编辑页管理。协议默认继承连接，单个模型可在高级设置覆盖；能力配置沿用原来的模型能力编辑器。

点击“打开文件编辑”会在首次使用时创建默认 `model.yml`。点击“选择配置文件”可以绑定已有 `.yml` 或 `.yaml`；修改后点击“重新加载”。页面编辑写回同一文件，保留注释；外部文件已变化时拒绝覆盖。暂不自动监听文件系统变化。文件损坏、被删除或不可读时保留上一份有效配置并显示错误，而不是清空整个模型目录。

“整理已有模型”按相同地址、Key、协议、请求路径分组，保留原内部模型 ID、显示名称、能力目录与视觉代理引用。文件保存并在内存中加载成功后才清理对应旧记录。不需要重新录入所有 Key。迁移完成后这些模型只在 Provider 区显示；尚未迁移的独立模型仍可使用原页面。

## 字段

参考 `model.example.yml`。`version: 1`；`providers` 为数组。每个 Provider 需要稳定的 `id`、`name`、`base_url`、`api_format` 和 `models` 数组（可为空）。可选 `request_path`、`models_path`、`enabled`、`api_key` 或 `api_key_ref`。

模型需要稳定的 `id` 与上游 `model_id`；修改显示名称用 `display_name`，不要为了改名更换 `id`。模型可设置 `enabled`、`group`、`api_format`、`request_path`、`context_window`、`tool_profile`（custom/function/shell）、`codex_tool_compatibility`（native/standard）、`web_search_mode`、`image_generation_enabled`、`vision_model_config_id`、`catalog`。迁移时保留兼容字段 `provider_profile_id` 和 `codex_catalog_model_id`。`catalog` 沿用原 Codex 能力条目；无需手写所有字段，未声明的自定义能力使用现有默认值。

支持 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。模型改用另一协议时，不继承原协议的请求路径。连接模型 ID 及生成的自定义目录标识必须无冲突；不同连接可以使用相同上游模型名。获取模型列表失败不影响手动录入；列表返回模型不等于工具能力通过，测试按钮会产生少量真实 API 请求。

## 凭据与云端边界

页面输入的 Key 使用 WeWork 原有本机加密凭据存储，文件只写 `api_key_ref`。它不是可跨设备直接搬迁的凭据：另一台设备上需要重新录入 Key。手写 `api_key` 也支持，但文件及其本机恢复副本都包含明文；不得提交到 Git、分享或随日志发送。变更通知不携带 Key；渲染端只在内存中持有运行所需凭据，不把 Provider 密钥写回 localStorage。

文件与 Provider 页面只管理本地自定义模型。云端目录、云端权限、Codex 账号和执行器路由未被替换。本地配置不会因保存而上传到云端；选择远程执行时仍使用原有授权、目录同步和执行准备流程。模型能力目录统一批量写入，沿用空闲重启流程，不强制终止正在运行的任务。

## 预览安装包与验证

预览版本 `0.5.4-provider.1` 使用原 WeWork 应用标识和数据目录，便于读取已有配置；安装前退出旧版本。构建配置为 `electron/electron-builder.provider-preview.cjs`，采用 ad-hoc 签名，没有 Apple Developer ID 或公证，不向官方更新频道发布，也不接入上游自动更新源。

新增测试覆盖配置校验、凭据共享/轮换、注释保留、并发冲突、错误恢复、迁移 ID、内存目录投影以及页面批量添加。实际执行结果以分支 Actions 日志与构建报告为准；单元测试不等于连接了用户的真实模型服务。

---

# Local provider and YAML configuration

Model settings now contain a Provider section. Store one connection and add many models through discovery, multiline paste or manual entry. The UI and the bound `model.yml` share one source. External edits require Reload; invalid files keep the last successful configuration, including after restart. Conflicting saves are rejected and YAML comments are preserved.

Use `model.example.yml` as a starting point. Keep internal model IDs stable while changing display names. Models inherit connection settings and may override protocol, path and capabilities. The legacy-model migration groups only identical connection settings and preserves IDs and advanced capabilities. Original independent models remain available until migrated.

UI-entered credentials use the existing encrypted local store and YAML keeps references. Handwritten plaintext keys are supported but the file and recovery copy must remain private. Never commit real credentials. A key reference moved to another computer requires re-entering the key there. Neither saving nor reloading uploads local configuration to the cloud. Cloud catalogs, permissions, Codex accounts and executor routing retain their original ownership.

The `0.5.4-provider.1` macOS preview reuses the existing application identity/data directory. It is ad-hoc signed, not Developer-ID signed or notarized, and does not publish to the official update channel. See Actions for actual test/build outcomes. Model service probes are explicit and may incur charges; no personal API credentials are required by CI.

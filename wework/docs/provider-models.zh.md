---
sidebar_position: 98
---
# Provider 与 model.yml

在模型设置中使用“本地 Provider 与配置文件”。创建一个连接后，它下面的模型共享地址、Key 和默认协议。原有独立本地模型可通过“整理旧模型”迁移，内部模型 ID、能力与引用保持不变。云端下发条目不迁移、不写入本地文件。

默认文件位于应用用户数据目录的 `model-config/model.yml`。也可以绑定自己选择的 `.yml` 或 `.yaml` 文件。页面保存直接写入同一文件。外部编辑后点击“重新加载”，无效 YAML 不会替换上一份有效配置；文件已被其他编辑器修改时，过期表单保存会被拒绝。

```yaml
version: 1
providers:
  - id: my-relay
    name: 我的服务
    base_url: https://gateway.example/v1
    api_format: openai-responses
    models:
      - id: primary
        model_id: upstream-model-a
        display_name: 主力模型
      - id: fast
        model_id: upstream-model-b
        enabled: true
```

`id` 是稳定身份，不要为了改显示名称修改它。`model_id` 是发给上游的名字。一个模型可以通过 `api_format` 和 `request_path` 覆盖连接默认值。协议支持 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。模型能力可在页面展开编辑，或使用 `context_window`、`tool_profile`、`codex_tool_compatibility`、`web_search_mode`、`image_generation_enabled` 和 `catalog_entry`。

页面输入的 Key 使用现有桌面加密凭据存储，YAML 保存 `api_key_ref` 引用。该引用只在同一设备有效；把 YAML 搬到另一台设备后，需要重新填写 Key。也支持直接写 `api_key`，但不要把带 Key 的文件提交到 Git、截图或共享。两种字段不可同时出现。默认不上传文件及凭据，只有执行已选择的模型时才会沿原有执行流程使用该模型的凭据。

批量添加支持换行或逗号分隔，已有同入口模型会跳过。获取模型列表只是发现模型 ID，不等于工具调用已经验证。列表获取失败时仍可以手动添加。新模型需要的 Codex catalog 会批量同步，执行器繁忙时不会强制重启。

删除模型可能使引用它的旧会话暂时无法继续，但不会静默切到其他付费线路。请先在会话中显式选择替代模型。若视觉侧模型被其他模型引用，需要先解除引用后才能删除。

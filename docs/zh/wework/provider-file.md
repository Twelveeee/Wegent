---
sidebar_position: 40
---

# 本地 Provider 与 model.yml

在 WeWork 的模型接口设置中创建服务连接，再批量粘贴模型 ID 或获取并勾选模型列表。连接地址与凭据共享，模型保留独立名称、稳定 ID、协议覆盖与能力参数。

## 配置来源

页面保存与“打开文件”编辑同一份 `model.yml`；外部保存后点击“重新加载”。默认位置为当前 Electron 用户数据目录下的 `model-providers/model.yml`，也可以绑定自己选择的 YAML 文件。绑定会替换本地文件管理的模型集合，不改写云端目录或原有账号配置。不会自动上传整个文件或所有凭据。

```yaml
version: 1
providers:
  - id: my-relay
    name: 我的中转
    base_url: https://gateway.example/v1
    api_format: openai-responses
    # 推荐先在页面录入 Key，自动生成本机 api_key_ref。
    # 也支持 api_key 明文；含 Key 的文件不得提交或分享。
    models:
      - id: main-model
        model_id: upstream-model-a
        display_name: 主力模型
      - id: fast-model
        model_id: upstream-model-b
        api_format: openai-chat-completions
        settings:
          contextWindow: 65536
          toolProfile: function
```

`id` 是稳定的本地标识；修改显示名称不应修改它。`model_id` 是实际请求上游的名称。URL 为 Base URL 与请求路径相接；默认路径分别为 `/responses`、`/chat/completions`、`/messages`，因此示例 Base URL 已包含 `/v1`。不同服务的前缀不同，可显式填写 `request_path`，模型发现路径为 `models_path`（默认 `/models`）。不按品牌猜测协议。

## 安全与恢复

页面录入的 Key 使用现有桌面端加密本地存储，YAML 仅写入本机凭据引用。该存储不是跨设备凭据同步，也不宣称防护已获得本机用户文件读取权限的攻击者。复制含 `api_key_ref` 的文件到另一台电脑后需重新录入 Key。普通模型列表事件不会携带 Key。

保存包含文件版本检查、临时文件写入与原子重命名。外部编辑冲突时拒绝覆盖；语法、字段或凭据引用错误时保留上一份有效配置，错误中不显示原始 YAML 或上游响应正文。手动加载，不在编辑器保存一半时自动应用。JSON 是 YAML 子集，但不支持 YAML 标签、别名或未知字段。

旧模型可显式迁移；按连接信息分组并保留模型 ID 与能力字段。迁移完成后移除对应旧存储记录。与另一个窗口并发修改旧数据时，先关闭旧编辑窗口并重新核对后操作。模型发现不是推理或工具能力验证；发现失败仍允许手工批量添加。

本地目录写入后，沿用现有 Codex catalog 同步及空闲重启机制，运行中任务不被强制重启。首次使用新模型前，应检查其工具配置与上游协议是否匹配。

## 预览构建验收

新增测试覆盖真实文件/加密存储、批量继承、Key 轮换、并发版本冲突、错误恢复、秘密脱敏、发现失败、稳定标识迁移、页面操作；同时运行现有云端合并/模型配置回归。安装包由独立 macOS arm64 CI 生成，不发布正式更新通道。具体执行结果以该提交的 CI 记录为准；未运行的真实上游调用不标记为通过。

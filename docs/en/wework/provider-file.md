---
sidebar_position: 40
---

# Local providers and model.yml

Model interface settings now support shared connections, discovered or pasted model IDs, per-model capabilities, and a bound YAML file. GUI edits and external edits use the same local file. Click Reload after editing externally. The default file is `model-providers/model.yml` within Electron user data; Bind selects another local YAML file.

Cloud-delivered models and existing account configuration remain separate. Binding replaces the file-managed local collection, not the combined cloud catalog. No automatic upload of the file or all its credentials is performed.

```yaml
version: 1
providers:
  - id: my-relay
    name: My relay
    base_url: https://gateway.example/v1
    api_format: openai-responses
    models:
      - id: coding-model
        model_id: upstream-model-a
        display_name: Coding
      - id: fast-model
        model_id: upstream-model-b
        api_format: openai-chat-completions
```

Use stable `id` values, with upstream names in `model_id`. Request paths default to `/responses`, `/chat/completions`, or `/messages`, appended to Base URL. Configure `request_path` for custom prefixes, and `models_path` for discovery (default `/models`). Model capabilities live in `settings` using the existing local model field names.

GUI-entered keys use the existing encrypted desktop store and a device-local `api_key_ref`. Plain `api_key` values in user-owned YAML are also accepted, but must not be committed or shared. References are not portable credentials or OS-keychain guarantees. Re-enter keys on a new device. Public catalog events redact secrets.

Writes check the revision and use atomic rename. Invalid reloads retain the last valid configuration, including an encrypted recovery copy. Errors do not expose YAML snippets or provider response bodies. Aliases, custom tags, duplicate keys and unknown fields are rejected. Discovery is not a model execution or tool-compatibility test; manual bulk entry remains available on discovery failures.

Explicit legacy migration preserves model IDs and capability settings; do not concurrently edit the old records in another window. Catalog synchronization continues through the existing idle-restart flow without forcing active tasks to stop. The preview CI runs focused host, UI, model and cloud-merge tests and builds an arm64 macOS package without publishing a production update. Consult the commit's CI results for completed verification; real upstream API calls are not claimed by the automated configuration tests.

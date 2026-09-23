---
sidebar_position: 99
---

# WeWork local providers and YAML

Settings > Models > Providers and YAML edits local custom connections. Cloud-provided models and Codex account catalogs retain their existing ownership and execution routes.

Create a provider once, then paste newline/comma-separated upstream model IDs or fetch its model list after saving. Listing a model is not a successful inference or tool-compatibility test. Model discovery never invokes paid inference.

The default file is `model-config/model.yml` under the application's user-data directory. Choose another YAML file to bind it, open it with the external editor, and reload after changes. The page writes the same file. A stale page revision is rejected rather than overwriting external edits. Invalid YAML preserves the last valid runtime snapshot and displays an error. `wework/model.example.yml` is a credential-free example.

Stable `id` values preserve task references; `model_id` is the literal upstream ID; `display_name` is editable. Models inherit provider protocol and paths, with model-specific overrides and existing capability fields under `settings`.

Legacy migration groups only identical URL/protocol/path/credential connections and preserves model IDs. Old copies are removed only after the new file is saved. Back up application data before migration.

Keys entered in the page use the existing encrypted Electron `SecureValueStore`. YAML stores an `api_key_ref`, not the key. Resolved execution credentials live in trusted workbench memory and are not persisted to localStorage or change events. This store is not macOS Keychain; protect the local user-data directory and encryption key. Inline `api_key` is supported for manual files but must not be committed or shared. Credential references are device-local.

Cloud catalog APIs, merge identities and execution-device routing are unchanged. Local entries retain `local-model:<id>` / `model-interface`. Editing local configuration does not publish it or upload all keys. Remote runs retain the existing execution preparation, catalog synchronization and confirmation flow. Catalog changes do not force-restart active tasks.

Focused tests cover storage, credentials, revision conflicts, invalid-file recovery, migration and UI batch editing. CI also checks existing hybrid cloud catalog behavior and types. Unit tests do not replace an install and real-model execution check.

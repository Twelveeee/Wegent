---
sidebar_position: 99
---
# Provider / YAML verification plan

This change is limited to locally owned custom model connections. Cloud model identities,
gateway authorization, runtime routing, and original Codex account management stay intact.

## Cases

1. Save one provider and twenty models. The file contains one credential reference; reloading preserves model IDs and list order.
2. Edit the provider's key and URL. All child models inherit the edit; a model-specific protocol override survives.
3. Save through the UI, edit externally, then attempt a stale UI save. Reject the stale revision without altering the file. Reload recovers.
4. Invalid YAML, duplicate IDs/keys, unknown fields, missing files and unsupported schema versions retain the last valid catalog and surface an error without secret values.
5. Migrate old configurations with equal and unequal keys. Preserve IDs, capability catalogs, disabled flags, vision references and old-model runtime identities. No guessing by model name.
6. Discover models from the configured provider, select several or paste IDs. Discovery failure does not delete existing models. No inference requests during discovery or import.
7. Cloud catalog refresh and same-name local/cloud entries survive local configuration edits. Never write cloud models/keys into YAML.
8. Resolve credentials only when an explicit connection test or execution needs them. Public snapshots/events omit credentials.
9. Write custom Codex catalog entries as one batch. Only restart an idle runtime, never force-stop work. Track catalog-ready state by version.
10. On macOS arm64, build the actual modified source, verify architecture, launch an isolated Electron instance and exercise provider/file settings. Record source SHA, tests and artifact checksum. Do not publish to the stable updater.

## Cleanup

Tests use temporary directories, synthetic credentials and isolated runtime homes only.
No personal user-data directory, model API account or cloud production settings may be modified.

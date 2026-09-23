/** Shared transport types; file credentials are never included in change events. */
export type ProviderApiFormat =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
export interface ProviderModelEntry {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  group?: string
  api_format?: ProviderApiFormat
  request_path?: string
  context_window?: number
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  web_search_mode?: 'disabled' | 'cached' | 'live'
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  provider_profile_id?: string
  codex_catalog_model_id?: string
  catalog?: Record<string, unknown>
}
export interface ProviderConnection {
  id: string
  name: string
  base_url: string
  api_format: ProviderApiFormat
  request_path?: string
  models_path?: string
  enabled?: boolean
  api_key?: string
  api_key_ref?: string
  models: ProviderModelEntry[]
}
export interface ProviderDocument {
  version: 1
  providers: ProviderConnection[]
}
export interface ProviderConfigSnapshot {
  path: string
  revision: string
  loadedAt: string
  document: ProviderDocument
  /** Only delivered to the trusted workbench, held in memory, never broadcast or persisted there. */
  credentials: Record<string, string>
  error?: string
  warnings?: string[]
}
export type ProviderConfigMutation =
  | { kind: 'upsert'; provider: ProviderConnection; clearKey?: boolean }
  | { kind: 'delete'; providerId: string }
  | { kind: 'import'; providers: ProviderConnection[] }

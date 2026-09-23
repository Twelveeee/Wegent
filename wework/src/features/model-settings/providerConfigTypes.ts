import type { LocalModelApiFormat, LocalModelCodexToolCompatibility, LocalModelToolProfile, LocalModelWebSearchMode } from './localModelSettings'
import type { LocalModelCatalogEntry } from './localModelCatalog'

export interface ProviderModelDefinition {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: LocalModelApiFormat
  request_path?: string
  context_window?: number
  tool_profile?: LocalModelToolProfile
  codex_tool_compatibility?: LocalModelCodexToolCompatibility
  web_search_mode?: LocalModelWebSearchMode
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  codex_catalog_model_id?: string
  catalog_entry?: LocalModelCatalogEntry
  group?: string
  provider_profile_id?: string
}
export interface ProviderDefinition {
  id: string
  name: string
  base_url: string
  api_format?: LocalModelApiFormat
  request_path?: string
  models_path?: string
  models_base_url?: string
  models_api_key_header?: 'Authorization' | 'X-Api-Key'
  api_key_ref?: string
  api_key_configured: boolean
  tool_profile?: LocalModelToolProfile
  codex_tool_compatibility?: LocalModelCodexToolCompatibility
  enabled?: boolean
  models: ProviderModelDefinition[]
}
export interface ProviderConfigSnapshot {
  path: string
  revision: string
  providers: ProviderDefinition[]
  migratedModelIds: string[]
  error: { code: string; message: string } | null
}
export interface ProviderConfigState {
  snapshot: ProviderConfigSnapshot | null
  loading: boolean
  error: string | null
}

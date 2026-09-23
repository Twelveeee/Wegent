/** The shared, secret-free model-provider file contract. */
export type ProviderApiFormat =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'

export interface ProviderFileModel {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: ProviderApiFormat
  request_path?: string
  /** Existing per-model capability settings, never connection credentials. */
  settings?: Record<string, unknown>
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
  models: ProviderFileModel[]
}

export interface ProviderDocument {
  version: 1
  providers: ProviderConnection[]
}

export type PublicProviderConnection = Omit<ProviderConnection, 'api_key'> & {
  api_key_configured: boolean
}

export interface ProviderFileSnapshot {
  path: string
  revision: string
  providers: PublicProviderConnection[]
  /** A failed reload retains the previous accepted document. */
  error?: string
}

export type ProviderFileMutation =
  | { kind: 'save-provider'; provider: Omit<ProviderConnection, 'models'> }
  | { kind: 'delete-provider'; providerId: string }
  | { kind: 'save-models'; providerId: string; models: ProviderFileModel[] }
  | { kind: 'delete-model'; providerId: string; modelId: string }
  | { kind: 'import-providers'; providers: ProviderConnection[] }

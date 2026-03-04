export type AppSection = 'wiki' | 'maps' | 'ask' | 'calendar' | 'notes' | 'drive' | 'admin'
export type AuthMode = 'login' | 'register'

export type HealthResponse = {
  status: string
  time: string
  embedding_backend?: string
  llm_backend?: string
}

export type AuthUser = {
  id: number
  username: string
  is_admin: boolean
}

export type AuthResponse = {
  token: string
  expires_at: string
  user: AuthUser
}

export type WikiArticle = {
  id: number
  title: string
  url: string
  downloaded_at: string
  image_count: number
}

export type WikiImage = {
  title: string
  url: string
  thumb_url?: string | null
  width?: number | null
  height?: number | null
}

export type WikiArticleDetail = {
  id: number
  title: string
  url: string
  content: string
  downloaded_at: string
  image_count: number
  images: WikiImage[]
}

export type WikiSegment = {
  kind: 'heading' | 'paragraph'
  text: string
  level?: number
}

export type SearchResult = {
  article_id: number
  title: string
  chunk_index: number
  text: string
  score: number
}

export type AskSampling = {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  presence_penalty: number
  repetition_penalty: number
  enable_thinking: boolean
}

export type AskThread = {
  id: number
  title: string
  created_at: string
  updated_at: string
  last_message_preview?: string | null
  message_count: number
}

export type AskThreadMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  contexts?: SearchResult[] | null
  sampling?: AskSampling | null
  thinking: boolean
}

export type AskThreadDetail = {
  id: number
  title: string
  created_at: string
  updated_at: string
  messages: AskThreadMessage[]
}

export type CalendarEvent = {
  id: number
  title: string
  start_ts: string
  end_ts: string
  details: string
}

export type NoteItem = {
  content: string
  updated_at: string
}

export type NoteFolder = {
  id: number
  name: string
  parent_id?: number | null
  created_at: string
  updated_at: string
}

export type NoteFileListItem = {
  id: number
  name: string
  folder_id?: number | null
  created_at: string
  updated_at: string
}

export type NoteFileDetail = {
  id: number
  name: string
  folder_id?: number | null
  content: string
  created_at: string
  updated_at: string
}

export type NotesTree = {
  folders: NoteFolder[]
  files: NoteFileListItem[]
}

export type DriveFile = {
  filename: string
  size: number
  modified_at: string
}

export type DriveFolder = {
  name: string
  path: string
  parent_path?: string | null
}

export type DriveTreeFile = {
  name: string
  path: string
  parent_path?: string | null
  size: number
  modified_at: string
}

export type DriveTree = {
  folders: DriveFolder[]
  files: DriveTreeFile[]
}

export type AdminUser = {
  id: number
  username: string
  is_admin: boolean
  created_at: string
}

export type WikiBulkJob = {
  id: number
  username: string
  lang: string
  include_images: boolean
  status: string
  continuation_token?: string | null
  processed_pages: number
  indexed_articles: number
  failed_pages: number
  max_pages?: number | null
  batch_size: number
  started_at: string
  updated_at: string
  finished_at?: string | null
  last_error?: string | null
}

export type MapDatasetPreset = {
  id: string
  source: 'kiwix' | 'osm'
  title: string
  description: string
  url: string
  approx_size: string
}

export type MapsCatalog = {
  kiwix: MapDatasetPreset[]
  osm: MapDatasetPreset[]
  kiwix_embed_url: string
}

export type MapDownloadJob = {
  id: number
  username: string
  source: 'kiwix' | 'osm'
  label: string
  url: string
  target_path: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  bytes_total?: number | null
  bytes_downloaded: number
  progress?: number | null
  cancel_requested: boolean
  created_at: string
  updated_at: string
  finished_at?: string | null
  error_message?: string | null
}

export type MapFileItem = {
  source: 'kiwix' | 'osm'
  name: string
  path: string
  size: number
  modified_at: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  contexts?: SearchResult[]
  sampling?: AskSampling
  thinking?: boolean
  loading?: boolean
}

export type SectionProps = {
  token: string
  currentUsername: string
  setError: (msg: string) => void
}

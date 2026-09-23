import type { FolderRoot, FolderListing, WorkspaceFileText } from './home-api'

export interface WorkspaceScopeFile {
  path: string
  name: string
  /** lowercased extension without the dot */
  ext: string
  sizeBytes: number
  mtimeMs: number
}

export interface WorkspaceScopeDirectory {
  path: string
  name: string
  depth: number
  /** supported documents directly inside (not recursive) */
  fileCount: number
  /** bytes of directly contained supported documents */
  totalBytes: number
}

export interface WorkspaceScope {
  /** Supported documents in this directory and its ordinary subdirectories. */
  paths: string[]
  /** The bounded directory walk stopped before all entries were visited. */
  truncated: boolean
  /** Same files as `paths`, with display metadata for scope pickers. */
  files?: WorkspaceScopeFile[]
  /** Every visited directory, including the selected folder itself. */
  directories?: WorkspaceScopeDirectory[]
}

/** Sidebar workspaces are independent of the default directory used when saving new files. */
export interface WorkspaceApi {
  workspaceRoots(): Promise<FolderRoot[]>
  /** Native directory picker. Canceling never adds a root or changes the active chat. */
  pickWorkspaceFolder(): Promise<FolderRoot | null>
  /** Detach only: neither documents nor chat history are deleted. */
  removeWorkspaceFolder(path: string): Promise<void>
  listWorkspaceFolder(dir: string): Promise<FolderListing>
  folderChatFiles(folder: string): Promise<WorkspaceScope>
  /** Dedicated directory tools for folder chat: inventory + filename search. */
  listWorkspaceDirectories(folder: string): Promise<WorkspaceScopeDirectory[]>
  searchWorkspaceFiles(folder: string, query: string, limit?: number): Promise<WorkspaceScopeFile[]>
  /** Validates both the registered root and the currently selected chat directory. */
  readFolderChatFile(folder: string, path: string, maxChars: number, offset?: number): Promise<WorkspaceFileText>
  onWorkspaceRootsChanged(handler: () => void): () => void
}

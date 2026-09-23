import type { FolderRoot, FolderListing, WorkspaceFileText } from './home-api'

export interface WorkspaceScope {
  /** Supported documents in this directory and its ordinary subdirectories. */
  paths: string[]
  /** The bounded directory walk stopped before all entries were visited. */
  truncated: boolean
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
  /** Validates both the registered root and the currently selected chat directory. */
  readFolderChatFile(folder: string, path: string, maxChars: number): Promise<WorkspaceFileText>
  onWorkspaceRootsChanged(handler: () => void): () => void
}

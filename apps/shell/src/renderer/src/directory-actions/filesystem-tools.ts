import type { AgentToolDef } from '@genoffice/agent-core'
import type { DirectoryProposal } from '../../../shared/directory-actions-api'
import { parentPath, pathKey } from '../explorer/model'
import { resolveSelectionPath, type DirectorySelection } from '../ai/directory-selection'

const path = { type: 'string', description: 'Exact selected source path.' }
const directory = { type: 'string', description: 'Opened or explicitly selected destination folder; . means the opened folder.' }
const name = { type: 'string', description: 'New plain name, with extension for files. Existing names are never overwritten.' }
const reason = { type: 'string', description: 'Explain the requested action for the user review.' }
export const filesystemTools: AgentToolDef[] = [
  { name: 'rename_file', description: 'Rename an individually selected file in its current folder after user approval. Preserves file bytes; changing the extension does not convert its format.', inputSchema: { type: 'object', properties: { path, name, reason }, required: ['path', 'name', 'reason'] } },
  { name: 'move_file', description: 'Move an individually selected file into an opened/selected destination folder after user approval. Optional new name. Never overwrites; partial failures explicitly retain the source.', inputSchema: { type: 'object', properties: { path, directory, name, reason }, required: ['path', 'directory', 'reason'] } },
  { name: 'copy_file', description: 'Copy/duplicate an individually selected file, preserving its bytes and original. Requires destination folder, a new filename, and user approval. No editor or conversion is involved.', inputSchema: { type: 'object', properties: { path, directory, name, reason }, required: ['path', 'directory', 'name', 'reason'] } },
  { name: 'create_folder', description: 'Create one empty folder directly inside an opened/selected directory after approval. Does not grant read access or select the new folder.', inputSchema: { type: 'object', properties: { directory, name, reason }, required: ['directory', 'name', 'reason'] } },
  { name: 'delete_folder', description: 'Propose deletion of an explicitly selected folder and its inventoried contents. Defaults to Recycle Bin. permanent=true bypasses it and requires the user to type the folder name. Workspace roots and the opened directory are protected. Folder selection does not grant child content reads.', inputSchema: { type: 'object', properties: { path, reason, permanent: { type: 'boolean', description: 'Only request true when the user explicitly asks for permanent deletion.' } }, required: ['path', 'reason'] } },
  { name: 'permanently_delete_file', description: 'Permanently delete an individually selected file only when explicitly requested by the user. No Recycle Bin or backup. Requires a separate typed-name user confirmation; use delete_file for ordinary deletion.', inputSchema: { type: 'object', properties: { path, reason }, required: ['path', 'reason'] } },
]
const joinName = (parent: string, value: unknown) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 200 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) throw new Error('Provide a valid plain filename or folder name.')
  return parent.replace(/[\\/]+$/, '') + (parent.includes('\\') ? '\\' : '/') + value
}
export function filesystemProposal(tool: string, args: Record<string, unknown>, scope: DirectorySelection): DirectoryProposal {
  if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('Explain the requested action for review.')
  const instruction = args.reason
  if (tool === 'create_folder') {
    const target = resolveSelectionPath(scope, args.directory, 'directory')
    if (!target) throw new Error('Open or select the destination folder first.')
    return { operation: 'create-folder', path: joinName(target, args.name), instruction }
  }
  const source = resolveSelectionPath(scope, args.path, tool === 'delete_folder' ? 'directory' : 'file')
  if (!source) throw new Error('Select the individual source first.')
  if (tool === 'delete_folder') {
    if (!scope.directories.some(p => pathKey(p) === pathKey(source))) throw new Error('Select the individual folder before deletion; opening it is not enough.')
    if (args.permanent !== undefined && typeof args.permanent !== 'boolean') throw new Error('permanent must be a boolean.')
    return { operation: 'delete-folder', path: source, instruction, permanent: args.permanent === true }
  }
  if (tool === 'permanently_delete_file') return { operation: 'delete-permanently', path: source, instruction }
  const target = tool === 'rename_file' ? parentPath(source) : resolveSelectionPath(scope, args.directory, 'directory')
  if (!target) throw new Error('Open or select the destination folder first.')
  return { operation: tool === 'rename_file' ? 'rename' : tool === 'move_file' ? 'move' : 'copy', path: source, instruction,
    destination: joinName(target, tool === 'move_file' && args.name === undefined ? source.replaceAll('\\', '/').split('/').pop() : args.name) }
}

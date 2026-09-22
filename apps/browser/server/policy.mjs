import path from 'node:path'
import channels from './channels.mjs'
import { requireValue } from './errors.mjs'
import { relativeParts } from './workspace.mjs'

const CHANNELS = new Set(channels)
const SCOPES = { docs: ['docs'], sheets: ['sheets', 'workbook'], slides: ['slides'], pdf: ['pdf'], markdown: ['markdown'], html: ['html'] }
const COMMON = new Set([
  'app:get-language', 'app:get-theme', 'app:get-auto-save-default', 'app:get-ai-panel-prefs',
  'app:set-ai-panel-prefs', 'ai:get-settings', 'ai:gsk-status', 'app:chrome-pressed',
  // AI chat history has no server persistence in browser mode; stubbed in NativeHost.
  'project:resolveChat', 'project:loadChat', 'project:appendChat', 'project:rebindChat',
])
// Browser mode is an editor, not a remote OS/AI/MCP control plane. New native
// capabilities must be reviewed and explicitly added, not inherited by prefix.
const BLOCKED = /(?:ai[-:]|cloud|gsk-login|zotero|mcp|attachment|files[-:]|screen|capture|font-download|font-install|private-font-data|open-external|clipboard|headless|respell|spell-diag|write-export|export-images|export-pdf|print-pdf|print|analyze-media|convert-office|create-document|present-new|present-full|audience|show-sync|show-open|show-close|show-ink|show-bleed|show-full|show-list|show-screen|save-picture|pick-export|take-export|save-merged|altchunk|apply-edit-script|generate|land-generated|presenter|auto-rename|export-|save-image|prepare-image-export|finish-image-export|insert-pdf|insert-blank-page|extract-pages|split-pdf|merge-pdf|merge-pages|replace-pages|set-page-size|split-pages|crop-pages|add-signature|remove-signature|request-redaction-copy|fetch-image|ocr-page)/i
// Known text/default-name slots in the native preloads. Names cannot contain
// directory syntax even where an old Electron handler trusted its UI.
const FILE_AT_ZERO = /^(?:docs:(?:open-path|open-decrypt|set-password|save|write-recovery)|slides:open-path|(?:markdown|html):read-file|pdf:(?:read-file|is-untitled|list-page-images|list-static-form-fills))$/
const NAME_AT_ZERO = /^(?:docs:save-as|docs:save-new|slides:save-as|slides:export-|markdown:save-image-as|html:save-image-as)/
const PATH_KEYS = /^(?:path|filePath|sourcePath|targetPath|outPath|outputPath|directory|dir|defaultPath|csvPath|inputPath)$/i
const NAME_KEYS = /^(?:defaultName|suggestedName|fileName|outputName)$/i
export const isDiskWrite = channel => /(?:^|:)(?:save(?:$|-)|write(?:$|-)|export(?:$|-)|auto-rename|rename|insert-pdf|insert-blank-page|extract-pages|split-pdf|merge-pdf|merge-pages|replace-pages|set-page-size|split-pages|crop-pages|add-signature|remove-signature)/.test(channel)

export async function validateRpc(workspace, tab, channel, args) {
  requireValue(typeof channel === 'string' && CHANNELS.has(channel), 403, 'This operation is not exposed by the browser service.', 'CHANNEL_BLOCKED')
  requireValue(channel !== 'docs:save-to', 403, 'Use Save As and the mounted-folder picker.')
  if (channel === 'workbook:save') requireValue(args?.[0]?.targetPath === undefined, 403, 'Use Save As and the mounted-folder picker.')
  requireValue(channel !== 'slides:new-blank', 403, 'Use the browser workspace New action.')
  requireValue(COMMON.has(channel) || (SCOPES[tab.kind]?.includes(channel.split(':')[0]) && (!BLOCKED.test(channel) || /:consume-headless-export$|^docs:consume-ai-doc-content$/.test(channel))), 403, 'This desktop-only capability is unavailable in browser mode.', 'DESKTOP_ONLY')
  requireValue(Array.isArray(args) && args.length <= 20, 400, 'Invalid editor arguments.')
  if (isDiskWrite(channel)) requireValue(!workspace.get(tab.mount).readOnly, 403, 'This folder is mounted read-only.')
  const checkPath = async value => {
    if (typeof value !== 'string' || !value) return
    if (path.isAbsolute(value)) await workspace.fromAbsolute(tab.mount, value, { missingLeaf: true })
    else requireValue(false, 400, 'Filesystem paths must be absolute and belong to this mount.')
  }
  if (FILE_AT_ZERO.test(channel)) {
    requireValue(typeof args[0] === 'string' && args[0].length > 0, 400, 'A mounted file path is required.')
    await checkPath(args[0])
  }
  if (channel === 'docs:save-as' && args[2] != null) await checkPath(args[2])
  if (channel === 'workbook:open-for-merge') {
    requireValue(Array.isArray(args[0]) && args[0].length <= 20, 400, 'Invalid merge file paths.')
    for (const value of args[0]) await checkPath(value)
  }
  async function walk(value, key = '', depth = 0) {
    requireValue(depth < 70, 400, 'The editor request is nested too deeply.')
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return
    if (typeof value === 'string') {
      if (PATH_KEYS.test(key)) {
        // Workbook path/cachePath are archive entries in snapshot-scoped reads.
        if (!(channel === 'workbook:read-pivot-definition' && key === 'path')) await checkPath(value)
      }
      if (NAME_KEYS.test(key)) {
        relativeParts(value, false)
        requireValue(!value.includes('/'), 400, 'Use a filename, not a path, for the suggested name.')
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (key === 'paths' || key === 'filePaths') await checkPath(item)
        else await walk(item, key, depth + 1)
      }
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) await walk(v, k, depth + 1)
    }
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    // Scalar absolute paths are used by open/read/save. Document source text
    // only travels in typed request objects, except the preview-update event.
    if (typeof arg === 'string' && path.isAbsolute(arg) && channel !== 'html:preview-update') await checkPath(arg)
    else await walk(arg)
  }
  if (NAME_AT_ZERO.test(channel) && typeof args[0] === 'string') {
    relativeParts(args[0], false)
    requireValue(!args[0].includes('/'), 400, 'Use a simple filename.')
  }
}

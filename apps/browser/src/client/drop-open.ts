/** A browser File does not carry a trusted absolute filesystem path. Existing
 * editor-local image drop handlers still work; opening documents goes through
 * the workspace's mounted-folder picker instead of Electron File.path. */
export function installDropOpenBridge(): void {
  window.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  })
  window.addEventListener('drop', event => {
    if (event.defaultPrevented || !event.dataTransfer?.files.length) return
    event.preventDefault()
    ;(parent as any).genofficeWorkspace?.notify('To open a document, mount its folder and choose it in Files. Browser drops do not grant access to local paths.', true)
  })
}

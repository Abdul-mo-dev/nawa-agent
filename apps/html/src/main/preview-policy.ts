/** Local HTML keeps its editing scripts, but remote content requires a per-view choice. */
export function previewContentSecurityPolicy(remote = false): string {
  const network = remote ? ' https: http:' : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' html-asset: blob:${network}`,
    `style-src 'unsafe-inline' html-asset:${network}`,
    `img-src html-asset: data: blob:${network}`,
    `font-src html-asset: data:${network}`,
    `media-src html-asset: data: blob:${network}`,
    `connect-src ${remote ? 'https: http: wss: ws:' : "'none'"}`,
    'worker-src blob: html-asset:',
    "frame-src 'none'",
    "object-src 'none'",
    `form-action ${remote ? 'https: http:' : "'none'"}`,
    'base-uri html-asset: https: http:',
  ].join('; ')
}

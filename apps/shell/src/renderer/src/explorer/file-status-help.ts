/** Recovery hints supplement the actual error; they never replace its reason. */
export function fileStatusHelp(reason: string, kind: 'search' | 'analysis'): string {
  if (
    kind === 'search' &&
    /HTTP (?:401|403)|unauthoriz|authentication|API key|credential/i.test(reason)
  )
    return 'Check the server address and API key in Knowledge settings, then retry indexing.'
  if (/password|encrypted/i.test(reason))
    return 'Unlock the file or save an unencrypted copy, then retry.'
  if (/EACCES|EPERM|permission denied|access denied|file.*locked|in use/i.test(reason))
    return 'Check file permissions and close any application locking the file, then retry.'
  if (
    kind === 'search' &&
    /embedding model|model.*(?:not found|unavailable|load|alias)|pooling|embedding server HTTP (?:400|404)/i.test(
      reason,
    )
  )
    return 'Load an embedding model and check its model name, server address and settings in Knowledge, then retry indexing.'
  if (
    kind === 'search' &&
    /fetch failed|ECONN|ENOTFOUND|network|timed? ?out|timeout|embedding server HTTP 5\d\d/i.test(
      reason,
    )
  )
    return 'Check that the embedding server is running and its address is correct in Knowledge settings, then retry indexing.'
  if (/ENOENT|no such file|file.*(?:missing|not found|unavailable)/i.test(reason))
    return 'Check that the file still exists and its drive or folder is accessible, then retry.'
  if (/unsupported|not supported|no validated.*adapter/i.test(reason))
    return 'Save a copy in a supported format, then index or prepare that copy.'
  if (/exceeds.*(?:MiB|limit)|file.*too large|file size.*limit/i.test(reason))
    return 'Use a smaller file or adjust the relevant limit in Knowledge settings, then retry.'
  return kind === 'search'
    ? 'Fix the reported issue, then right-click the file and choose Reindex / refresh for file chat.'
    : 'Fix the reported issue, then right-click the file and choose Prepare tables for analysis.'
}

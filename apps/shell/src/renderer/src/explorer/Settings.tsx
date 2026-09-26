import { useEffect, useState } from 'react'
import { SettingsModal } from '../SettingsModal'
import type { AccountStatus } from '../../../shared/home-api'
/** Keep the original provider, model, language, theme and integration settings. */
export function ExplorerSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [loginWaiting, setLoginWaiting] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.aiOffice.accountStatus().then(s => { if (alive) setStatus(s) }).catch(() => {})
    const off = window.aiOffice.onAccountLogin(event => {
      if (!alive) return
      if (event.url) setLoginUrl(event.url)
      if (event.phase === 'success' || event.phase === 'error') setLoginWaiting(false)
      if (event.phase === 'error') setNotice(event.error || 'Sign-in failed.')
      if (event.phase === 'success') void window.aiOffice.accountStatus().then(s => { if (alive) setStatus(s) }).catch(() => {})
    })
    return () => { alive = false; off() }
  }, [])
  const failure = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error))
  return <>
    <SettingsModal status={status} loggingOut={loggingOut} loginWaiting={loginWaiting} loginUrl={loginUrl} urlCopied={urlCopied}
      onClose={onClose} onOpenLoginUrl={() => { void window.aiOffice.openLoginUrl().catch(failure) }}
      onCopyLoginUrl={() => { if (loginUrl) void navigator.clipboard.writeText(loginUrl).then(() => setUrlCopied(true)).catch(failure) }}
      onLogin={() => { setLoginWaiting(true); setNotice(null); void window.aiOffice.accountLogin().then(ok => { if (!ok) { setLoginWaiting(false); setNotice('Sign-in could not be started.') } }).catch(error => { setLoginWaiting(false); failure(error) }) }}
      onLogout={() => { setLoggingOut(true); void window.aiOffice.accountLogout().then(() => window.aiOffice.accountStatus()).then(setStatus).catch(failure).finally(() => setLoggingOut(false)) }} />
    {notice && <div className="ex-settings-notice" role="alert">{notice}<button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
  </>
}

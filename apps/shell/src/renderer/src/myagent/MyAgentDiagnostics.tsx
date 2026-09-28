import { useSidebarText } from '../explorer/sidebar-i18n'
import type { MyAgentDiagnostics as Report } from '../../../shared/myagent-settings-api'

export function MyAgentDiagnostics({ report, onCopy, disabled }: { report: Report; onCopy(): void; disabled: boolean }) {
  const { s } = useSidebarText()
  const components = report.health?.components?.filter(c => c.name === 'native-provider' || c.name === 'document-tools' || c.name.startsWith('rag-')) ?? []
  return <div className="nawa-myagent-diagnostics" aria-label={s('Readiness diagnostics')}>
    <p><strong>{s('Checked at')}</strong> <bdi>{report.checkedAt}</bdi><br/><bdi>{report.serverUrl}</bdi></p>
    {report.readiness ? <>
      <p role="status"><strong>{s(report.readiness.startsOnDemand ? 'Chat model starts on demand' : report.readiness.ready ? 'Chat model ready' : 'Chat model needs attention')}</strong><br/>{report.readiness.status}</p>
      <p><bdi>{report.readiness.model}</bdi>{report.readiness.managedProfileState && ` · ${report.readiness.managedProfileState}`}</p>
      {!report.readiness.ready && <p>{s('Check the chat provider URL/model below, or inspect its managed runtime in MyAgent.Server.UI.')}</p>}
    </> : <p>{s('Provider readiness could not be checked. Verify the connection and server status.')}</p>}
    {components.map(component => <div className="nawa-myagent-runtime" key={component.name}>
      <strong>{component.name}</strong> · {component.status}{component.detail && <p>{component.detail}</p>}
      {component.available === false && component.enabled !== false && <p>{s(component.name === 'rag-office-pdf-conversion'
        ? 'Set the LibreOffice path in extraction settings, or install LibreOffice using MyAgent.Server.UI Setup.'
        : component.name === 'rag-vector-retrieval' ? 'Configure an embedding model below, then refresh the affected files.'
          : 'Check this component in MyAgent.Server.UI before retrying the affected operation.')}</p>}
    </div>)}
    <p>{s('This checks MyAgent’s provider and reported components. Embedding connectivity and OCR availability are checked when indexing or extraction runs.')}</p>
    {report.warnings.map((warning, index) => <p className="nawa-myagent-warning" key={index}>{warning}</p>)}
    <button type="button" className="set-btn" disabled={disabled} onClick={onCopy}>{s('Copy readiness diagnostics')}</button>
  </div>
}

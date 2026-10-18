import { useId, useState } from 'react'
import type {
  LocalEngineRelease,
  LocalModelsSnapshot,
  RemoteModelFile,
} from '../../../shared/local-models-api'
import type { ModelCopy } from './LocalProfileEditor'

export function ModelDownloads({
  snapshot,
  copy,
  busy,
  downloading,
  perform,
  download,
  assign,
  remove,
}: {
  snapshot: LocalModelsSnapshot | null
  copy: ModelCopy
  busy: boolean
  downloading: boolean
  perform(work: () => Promise<void>): Promise<void>
  download(work: () => Promise<void>): void
  assign(path: string, profileId: string): void
  remove(path: string): void
}) {
  const id = useId()
  const [query, setQuery] = useState(''),
    [repository, setRepository] = useState(''),
    [repositories, setRepositories] = useState<string[]>([])
  const [files, setFiles] = useState<RemoteModelFile[]>([]),
    [remoteFile, setRemoteFile] = useState('')
  const [libraryPath, setLibraryPath] = useState(''),
    [target, setTarget] = useState('')
  const [release, setRelease] = useState<LocalEngineRelease | null>(null),
    [asset, setAsset] = useState('')
  const selectedPath = snapshot?.models.some((model) => model.path === libraryPath)
    ? libraryPath
    : ''
  const selectedTarget = snapshot?.config.profiles.some((profile) => profile.id === target)
    ? target
    : ''
  const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return (
    <div className="lm-download-tools">
      <section aria-label={copy.downloadModels}>
        <h4>{copy.downloadModels}</h4>
        <p className="lm-hint">{copy.downloadHelp}</p>
        <label className="lm-field">
          <span>{copy.query}</span>
          <div className="lm-input-action">
            <input
              className="set-input"
              aria-label={copy.query}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="set-btn"
              disabled={busy || !query.trim()}
              onClick={() =>
                void perform(async () => {
                  const values = await window.nawaLocalModels.searchModels(query)
                  setRepositories(values)
                  if (values[0]) {
                    setRepository(values[0])
                    setFiles([])
                    setRemoteFile('')
                  }
                })
              }
            >
              {copy.search}
            </button>
          </div>
        </label>
        <label className="lm-field">
          <span>{copy.repository}</span>
          <div className="lm-input-action">
            <input
              className="set-input"
              aria-label={copy.repository}
              dir="ltr"
              list={`${id}-repos`}
              value={repository}
              onChange={(e) => {
                setRepository(e.target.value)
                setFiles([])
                setRemoteFile('')
              }}
            />
            <datalist id={`${id}-repos`}>
              {repositories.map((repo) => (
                <option key={repo}>{repo}</option>
              ))}
            </datalist>
            <button
              type="button"
              className="set-btn"
              disabled={busy || !repository.trim()}
              onClick={() =>
                void perform(async () => {
                  const values = await window.nawaLocalModels.modelFiles(repository)
                  setFiles(values)
                  setRemoteFile(values[0]?.name ?? '')
                })
              }
            >
              {copy.listFiles}
            </button>
          </div>
        </label>
        {!!files.length && (
          <label className="lm-field">
            <span>{copy.file}</span>
            <div className="lm-input-action">
              <select
                className="set-input"
                value={remoteFile}
                aria-label={copy.file}
                onChange={(e) => setRemoteFile(e.target.value)}
              >
                {files.map((file) => (
                  <option key={file.name} value={file.name}>
                    {file.name} · {size(file.bytes)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="set-btn"
                disabled={busy || downloading || !remoteFile}
                onClick={() => {
                  const file = files.find((f) => f.name === remoteFile)
                  if (file)
                    download(() =>
                      window.nawaLocalModels.downloadModel(
                        file.repository,
                        file.revision,
                        file.name,
                      ),
                    )
                }}
              >
                {copy.download}
              </button>
            </div>
          </label>
        )}
        {!!snapshot?.models.length && (
          <div className="lm-library-block">
            <h5>{copy.library}</h5>
            <select
              className="set-input lm-library"
              aria-label={copy.library}
              value={selectedPath}
              onChange={(e) => setLibraryPath(e.target.value)}
            >
              <option value="">{copy.model}</option>
              {snapshot.models.map((model) => (
                <option key={model.path} value={model.path}>
                  {model.name} · {size(model.bytes)}
                </option>
              ))}
            </select>
            <label className="lm-field">
              <span>{copy.assignTo}</span>
              <select
                className="set-input"
                value={selectedTarget}
                aria-label={copy.assignTo}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">{copy.newLocalModel}</option>
                {snapshot.config.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="lm-actions">
              <button
                type="button"
                className="set-btn"
                disabled={
                  busy ||
                  !selectedPath ||
                  snapshot.runtimes.some(
                    (r) =>
                      r.id === selectedTarget &&
                      ['starting', 'running', 'stopping'].includes(r.state),
                  )
                }
                onClick={() => assign(selectedPath, selectedTarget)}
              >
                {copy.useModelFile}
              </button>
              <button
                type="button"
                className="set-btn danger"
                disabled={busy || downloading || !selectedPath}
                onClick={() => remove(selectedPath)}
              >
                {copy.deleteModel}
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="lm-engine-download" aria-label={copy.downloadEngine}>
        <h4>{copy.downloadEngine}</h4>
        <p className="lm-hint">{copy.engineHelp}</p>
        <button
          type="button"
          className="set-btn"
          disabled={busy || downloading}
          onClick={() =>
            void perform(async () => {
              const next = await window.nawaLocalModels.releases()
              setRelease(next)
              setAsset(String(next.assets[0]?.id ?? ''))
            })
          }
        >
          {copy.releases}
        </button>
        {release && (
          <>
            <p>
              {release.tag}
              {release.prerelease ? ` · ${copy.prerelease}` : ''}
            </p>
            {release.assets.length ? (
              <div className="lm-input-action">
                <select
                  className="set-input"
                  aria-label={copy.engine}
                  value={asset}
                  disabled={downloading}
                  onChange={(e) => setAsset(e.target.value)}
                >
                  {release.assets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {size(item.bytes)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy || downloading || !asset}
                  onClick={() =>
                    download(() => window.nawaLocalModels.installEngine(Number(asset)))
                  }
                >
                  {copy.install}
                </button>
              </div>
            ) : (
              <p>{copy.noAssets}</p>
            )}
          </>
        )}
      </section>
      {snapshot && (
        <div className="lm-storage">
          <span>
            {copy.storage}: <bdi>{snapshot.directory}</bdi>
          </span>
          <button
            type="button"
            className="set-btn"
            onClick={() => void perform(() => window.nawaLocalModels.revealDirectory())}
          >
            {copy.openFolder}
          </button>
        </div>
      )}
      <p className="lm-hint">{copy.localOnly}</p>
    </div>
  )
}

import type { MyAgentConfiguration, MyAgentConfigPatch, MyAgentSnapshot } from '../../src/shared/myagent-settings-api'
export const configuration: MyAgentConfiguration = {
  configFileName: 'appsettings.json', apiKeyConfigured: true, remoteUpdatesEnabled: false,
  allowUnauthenticatedLoopback: false, workspacesRoot: 'C:\\MyAgent\\workspaces', skillsRoot: 'C:\\MyAgent\\skills',
  provider: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-chat', apiKeyConfigured: true, managedLlamaProfileId: '', contextWindowTokens: 0, maximumOutputTokens: 0, requestTimeoutSeconds: 600, maximumConcurrentRequests: 1 },
  llama: { executablePath: 'C:\\Models\\llama-server.exe', profilesPath: 'C:\\Models\\profiles.json' },
  rag: {
    roots: [{ id: 'documents', displayName: 'Documents', path: 'C:\\Documents' }],
    databasePath: 'Data/knowledge.sqlite3', managedAssetsPath: 'Data/assets',
    embeddingBaseUrl: 'http://127.0.0.1:8081/v1', embeddingModel: 'local-embedding', embeddingApiKeyConfigured: true,
    allowRemoteEmbeddings: false, managedLlamaProfileId: '', embeddingBatchSize: 8, embeddingRequestTimeoutSeconds: 600,
    maxBrowseEntries: 1000, maxFilesPerJob: 100, maxFileSizeMb: 64, maxPages: 500,
    chunkMaxChars: 1800, chunkOverlapChars: 200, minChunkChars: 20, maxChunksPerFile: 10000,
    allowedExtensions: ['.pdf', '.docx', '.xlsx'], visualMode: 'OcrOnly', visualModel: '', allowRemoteVisualExtraction: false,
    extractEmbeddedImages: true, renderVisualPages: true, maxImagesPerFile: 50,
    visualExtractionTimeoutSeconds: 120, visualExtractionRetryCount: 1,
    tesseractPath: 'C:\\Tools\\tesseract.exe', libreOfficePath: 'C:\\Tools\\soffice.exe',
  }, runtime: { mode: 'maf-harness', harness: { maximumIterationsPerRequest: 20, enableTodo: true } },
}
export const snapshot: MyAgentSnapshot = {
  serverUrl: 'http://127.0.0.1:5187', health: { status: 'ok', version: '1.0.0', providerConfigured: true, capabilities: ['configuration', 'rag'], components: [{ name: 'RAG', status: 'ready', available: true }] },
  configuration, revision: 'fixture-revision', warnings: [],
  profiles: [{ id: 'chat', kind: 'Chat', displayName: 'Local chat model', model: 'fixture.gguf', host: '127.0.0.1', port: 8080, enabled: true, modelConfigured: true }, { id: 'embedding', kind: 'Embedding', displayName: 'Local embedding model', model: 'embedding.gguf', host: '127.0.0.1', port: 8081, enabled: true, modelConfigured: true }],
  runtimes: [{ profileId: 'chat', displayName: 'Local chat model', state: 'Running' }, { profileId: 'embedding', displayName: 'Local embedding model', state: 'Stopped' }],
}
export function patch(): MyAgentConfigPatch {
  const { apiKeyConfigured: _ignored, ...provider } = configuration.provider
  return { provider: { ...provider }, rag: structuredClone(configuration.rag) }
}

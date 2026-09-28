# MyAgent server settings in Nawa

Reviewed the native MyAgent.Server.UI settings flow in `MainSettingsViewModel`, `JsonServerConfigStore`, and `ServerProcessManager`, together with MyAgent's configuration, lifecycle, and llama HTTP endpoints. The native UI edits local configuration and manages either the `MyAgentServer` Windows service or a server executable. Nawa uses the administrator HTTP API for a connected server and retains local launch preferences separately.

The new page is available at **Settings → MyAgent** and **Knowledge → MyAgent settings**. It includes:

- The existing protected MyAgent connection and service key, with connection testing and a new-key generator.
- Health/component status and start/stop/restart controls for an installed Windows service or a selected server executable/DLL.
- Chat/classification and embedding provider URLs, model aliases, credentials, runtime selection, and request limits.
- Shared RAG folders, supported formats, ingestion limits, and visual extraction policy.
- Advertised managed model runtimes and start/stop actions.

Provider credentials stay on MyAgent; blank fields retain stored keys and explicit removal clears them. The shared Nawa service key is decrypted only in the main process. Settings endpoints and local controls are not assistant tools. Responses are bounded, redirects are rejected, and existing keys and unused runtime logs are excluded from settings responses.

Saving configuration rechecks the connection and current configuration revision. It preserves unedited runtime/storage/extraction fields and retains a rejected draft for review. Live changes call the reload endpoint. Changes requiring a restart show that requirement without restarting automatically. Refreshing status or switching settings sections retains a server draft.

Process launch preserves an existing `appsettings.json`. For a missing configuration, it creates an authenticated configuration with legacy migration disabled and requires a saved service key. It uses fixed arguments and a hidden process. A Nawa-managed server keeps running when Nawa exits. Restarts wait for the old process to exit or for Windows to report the service stopped before starting it again. Stop/restart requires an explicit UI confirmation because other clients may be using the server.

Model downloads, GGUF profile creation/editing, dependency installation, user accounts, and Windows service installation remain in MyAgent.Server.UI. Runtime IDs select startup behavior; the provider API URL and served model alias must be entered separately. Nawa's selected chat provider is unchanged by MyAgent provider settings.

Verification on 2026-09-28:

- Six targeted MyAgent/settings/RAG test files: 63 tests passed. Two existing preload/AI settings test files: 6 tests passed. Tests include secret handling, configuration preservation, stale drafts, partial status failures, launch arguments, existing configuration preservation, service/process restart ordering, workspace IPC restrictions, and settings navigation/draft retention.
- `node tools/myagent-settings-review/test.mjs`: 11 checks passed, including rejected-save draft retention, refresh, folder selection, restart confirmation, unsaved connection guards, and 300px English/Arabic layouts without renderer errors. Screenshots are written under `.task/myagent-settings-review/`.
- `node tools/sidebar-review/test.mjs`: existing sidebar scenarios passed with the added MyAgent entry.
- `node tools/rag/myagent-integration.mjs` with a built server DLL: isolated real HTTP configuration saves, live reload, stale-draft rejection, preservation, and restart requirements passed, alongside the existing RAG integration scenarios.
- Shell type check, production build, and `git diff --check`: passed.

The HTTP integration uses a temporary data directory and test providers. Windows service/process control tests use mocked launchers. Validation does not change the user's live MyAgent configuration, index, installed service, or running server.

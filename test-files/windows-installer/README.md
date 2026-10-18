# Windows installer validation

1. Run `npm run build:all`.
2. Run `node test-files/windows-installer/prepare.mjs`. It prints an owned directory under `.task` containing a manifest and electron-builder configuration.
3. From `apps/shell`, run `npx electron-builder --win --x64 --publish never --config <printed-directory>/config.cjs`.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File test-files/windows-installer/validate.ps1 -RunDirectory <printed-directory>`.

Pass `-Reliability` to also run the native save/conflict, Word-tab disposal, HTML network, preview-chat recovery and Arabic keyboard-resize tests against the installed executable. The Windows desktop CI runs this option after the same tests pass against the source build. E2E launchers accept `NAWA_TEST_EXECUTABLE` to select an installed or unpacked build while retaining isolated user data.

The test package uses a unique application ID, installer GUID, executable name and ProgIDs. It installs into its own directory, exercises the packaged application, reinstalls it to cover the upgrade path, and uninstalls it. Existing Nawa/GenOffice installations are preserved. The driver saves registry evidence before installation and restores affected per-user extension defaults and PATH in its cleanup block. Windows UserChoice values are only read and compared.

The payload uses the production packaging configuration, editor modules, native sidecar and NSIS hooks. File classes and ShellNew registrations derive from the application ID, so the validation identity stays isolated automatically. It does not validate signing or replace the installed production app.

If an interrupted run needs recovery, repeat the PowerShell command with `-CleanupOnly`. It uses the saved registry snapshot and the owned uninstaller. Keep the run directory until cleanup succeeds.

The OpenDocument desktop drivers also accept `NAWA_TEST_EXECUTABLE` to test an unpacked or installed package. They set separate user-data and authentication directories.

# Directory assistant file operations

Directory chat exposes filesystem tools when an editing/organizing request needs them, or through `discover_file_tools` with `capability: editing`.

| Tool | Operation | Approval |
| --- | --- | --- |
| `rename_file` | Rename a selected file within its current folder, preserving its bytes. | One action review showing both paths. |
| `move_file` | Move a selected file into an opened/selected destination directory; optionally change its name. | One action review showing both paths. |
| `copy_file` | Duplicate a selected file into an opened/selected directory under a new name. | One action review showing both paths. |
| `create_folder` | Create one empty folder inside an opened/selected directory. | One action review. |
| `delete_folder` | Move an explicitly selected folder and its inventoried children to the Recycle Bin. | One review of the folder, child names, counts and size. |
| `permanently_delete_file` | Remove a selected file without the Recycle Bin or a backup. | Explicit review plus typing the exact filename. |
| `delete_folder` with `permanent: true` | Permanently remove the selected folder and its reviewed contents. | Explicit review plus typing the exact folder name. |

Ordinary file deletion continues to use `delete_file` and the Recycle Bin. Permanent deletion must be explicitly requested; it is not an automatic fallback when recycling fails. The typed confirmation is checked by both the approval controller and main process. These operations do not start a native editor or another model call. Document creation/editing/conversion retain their separate preparation and save approvals.

The source file or folder must be individually selected when the message is sent. This request snapshot stays fixed through approvals and Explorer refreshes; selection changes affect the next message. Merely opening a folder does not authorize deletion. Deleting a folder permits a local integrity inventory of its descendants for review; it does not grant the assistant permission to read their content. Creating/copying/moving an item does not automatically select it or grant new content access. Rename may use the selected source's current parent without separately selecting that parent. Other destinations must be opened or selected in that request snapshot.

Main-process checks reject existing destination names, invalid names, workspace escapes, symlinks/junctions, hardlinked files, open editor targets, stale runs and changed source bytes. Workspace roots, folders containing registered roots, and folders containing the currently opened directory cannot be deleted. Case-only renames are currently rejected. Rename changes the name only; conversion remains a separate operation.

The local inventory is bounded to 2,000 entries, 512 MiB total and 30 seconds, with the existing 64 MiB per-file limit. Larger operations fail before approval/commit and should be split. Folder inventory is rechecked before committing. Filesystem actions preserve file bytes; they do not promise preservation of all operating-system metadata.

Transfers publish a new destination without overwriting, then remove the source for rename/move after verification. If the source cannot be removed, the result is explicitly partial and identifies the existing destination copy. No rollback deletes either user path. Permanent folder deletion removes only individually verified inventory entries, using non-recursive directory removal. A new child or a failure stops deletion and reports partial progress if any entry was already removed. It is not a transaction or secure disk erasure.

Committed and partial outcomes appear in chat receipts and activity. Partial outcomes cannot support a claim that the whole operation succeeded. Source receipts and inspections affected by removal or relocation are invalidated, and source/destination listings are refreshed. Denied actions do not retry within the same request.

Validation uses temporary filesystem fixtures and synthetic browser responses; it does not delete real user documents:

```powershell
npm run test -w @genoffice/shell -- tests/directory-filesystem.test.ts tests/directory-review-fixes.test.ts tests/directory-routing.test.ts tests/directory-activity.test.ts tests/directory-inspection-evidence.test.ts
node tools/sidebar-review/activity-test.mjs
npm run typecheck -w @genoffice/shell
npm run build -w @genoffice/shell
```

Verified on 2026-09-28: 107 tests passed across eight focused shell suites, including 21 filesystem tests. The activity browser harness passed all new action/approval scenarios and existing directory-chat scenarios. Shell type checking, the production build and `git diff --check` passed. The browser used synthetic provider/IPC responses; filesystem behavior was exercised separately against real temporary files. No real user documents were changed.

Restart Nawa to load the updated main process, preload and renderer. No MyAgent server update is required. Case-only renames, folder rename/move/copy, and unbounded batch operations are outside this implementation.

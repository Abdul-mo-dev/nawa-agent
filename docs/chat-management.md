# Conversation management

The workspace and six editor panels share message actions, turn boundaries, export helpers, and queue controls. Editor panels use `useEditorConversations` with adapters for their existing send functions and agent loops. The workspace retains its evidence-aware SQLite history adapter.

## Behavior

- Send appends a question and its response. A turn includes the question, response segments, and tool receipts.
- Questions keep their actions below the bubble. Only the final visible assistant segment in each exchange shows answer actions, after the reply finishes; intermediate text and tool segments do not add action rows.
- Directory and file editors use the shared Nawa header, conversation selector above the transcript, typography, message geometry, and composer styling. Model controls stay in the composer; directory indexing and knowledge tools remain separate context controls.
- Chat backgrounds follow the main Nawa application background in light, dark, and system themes. Every editor and image/email preview has a draggable inner edge; widths are remembered and constrained to leave room for the file.
- Answered questions show Copy and Edit. Branch and Delete stay with the final answer; unanswered questions retain these recovery actions.
- Edit and resend saves the original continuation and starts a new version before the edited question. Abandoned replies never enter the new model context.
- Retry preserves the failed attempt as a version and displays one copy of the retried question. Attachments and recorded scope travel with the question.
- Regenerate creates an alternative explanation. The agent core advertises no tools and rejects unsolicited tool calls during regeneration. Retrying an editor turn with tool activity also uses explanation mode to avoid repeating completed edits.
- Branch copies history through the selected exchange into an independent chat, with a link to its source. Keeping answer segments and tool receipts together prevents incomplete turns. Branches use the current files; they do not rewind document contents.
- Delete from here removes the selected exchange and its continuation from the active path. Undo chat change and the version selector recover it. File undo controls remain separate.
- Committed file changes have a separate receipt ledger. Editing or deleting chat turns preserves these factual outcomes without restoring abandoned replies into model context. The File changes disclosure lets users inspect them.
- New chat preserves the previous chat and its draft. History supports search, rename, archive, Trash, restore, and export. Permanent deletion is available from Trash and requires confirmation.
- Markdown exports the active path. JSON also includes saved conversation versions.
- Enter sends; Shift+Enter inserts a line. During a response, Enter queues a question. Queued questions can be edited, reordered, removed, paused, and resumed. Stop, errors, and incomplete responses pause the queue. A conversation switch clears its unsent queue; queues remain in memory.

## Persistence and recovery

Workspace history migrates existing databases to schema 4. Saved versions retain their parent version and source question. Conversation deletion moves records into Trash; permanent deletion removes messages, saved versions, and source fingerprints while retaining a tombstone against stale saves.

Desktop editors store the conversation library beside the existing project chat as `<chat-id>.jsonl.session.json`. Writes are atomic and revision-checked. The JSONL file mirrors the active path for existing project timelines; the managed library owns alternative paths and chats. Unsaved chat libraries follow their first save to a file. Existing JSONL transcripts are imported when no managed history exists.

An immediate local browser journal protects drafts and partial replies if a native save is interrupted. Native checkpoints run serially, and newer durable history can restore a missing journal. Save failures remain visible with a retry control. Browser-hosted editors use the journal without desktop storage.

Storage is bounded: up to 100 chats or versions per managed library, 4 Mi characters in an editor journal, 8 MiB in an editor's durable library, and 32 Mi characters of workspace version snapshots. Capacity errors preserve the visible conversation and offer export rather than silently discarding older versions.

## Verification

Regression coverage exercises earlier-message edits, model-context boundaries, answer-only regeneration including unsolicited tool calls, branch independence, recoverable deletion, Trash and archive, stale writers, native recovery, save-as migration, inline editing, and Stop during asynchronous request preparation.

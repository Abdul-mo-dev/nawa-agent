# Nawa directory sidebar: design and layout review

Implementation follow-up: [fixes and verification](nawa-directory-sidebar-fixes.md). The findings below describe the original state before those fixes.

Reviewed 2026-09-27. Scope: the opened-directory sidebar's **Nawa assistant**, **RAG & Analytics**, and **AI Provider** tabs, including their shared navigation, forms, history, approvals, settings, and responsive behavior.

This is a source-based review of the current React components and CSS. Browser discovery returned no available browser, so rendered screenshots, actual overflow measurements, contrast, zoom, and screen-reader behavior were not verified. Findings distinguish definite implementation behavior from layout risks and design recommendations. No application code was changed for this review.

The sidebar has useful foundations: semantic tabs, keyboard navigation, a keyboard-resizable divider, explicit file scope, and preservation of visited tab contents. Its main weakness is that several large workflows occupy the same narrow surface without a consistent hierarchy. Correctness defects should be addressed before visual polish.

## Findings in priority order

### 1. High — a broad CSS selector hides unrelated recovery and history actions

**Source-confirmed.** `.ex-inspector .ws-chat-close:last-child { display: none; }` applies throughout the inspector, not just to the header's redundant Hide chat button. It also matches Check again, Retry saving, Close history, Delete in each history row, Cancel in the rename form, and Show database.

This makes actions disappear based on sibling position. In particular, a failed save offers a retry in JSX that the sidebar CSS hides. Narrow the rule to the specific duplicate header action, or omit that action explicitly when rendering inside the sidebar. Avoid giving unrelated secondary actions a class named `ws-chat-close`.

Evidence: [explorer.css](../../apps/shell/src/renderer/src/explorer/explorer.css), line 234; [ChangeNotice.tsx](../../apps/shell/src/renderer/src/history/ChangeNotice.tsx); [HistoryPanel.tsx](../../apps/shell/src/renderer/src/history/HistoryPanel.tsx); [WorkspaceChat.tsx](../../apps/shell/src/renderer/src/WorkspaceChat.tsx), save-error block.

### 2. High — provider form rows have incompatible width rules

**Source-confirmed constraint conflict; rendered extent unverified.** Settings rows retain `display: flex` in a horizontal direction. The sidebar makes their inputs and dropdown wrappers `width: 100%`, while the underlying settings CSS makes those controls non-shrinking. The labels remain beside them. The control consumes the row's available width before the label and gap are accounted for, forcing label compression and overflow/overlap.

Use vertically stacked label, control, and help text for text/select fields inside the sidebar. Keep switches as a deliberately separate row pattern. Do not apply one global width override to every settings control.

Evidence: [workspace-control-panel.css](../../apps/shell/src/renderer/src/explorer/workspace-control-panel.css), lines 41–42; [settings.css](../../apps/shell/src/renderer/src/settings.css), `.set-field`, `.set-dd`, and `.set-input`.

### 3. High — narrow windows remove the entire sidebar and its local state

**Source-confirmed.** `inspectorVisible` requires `windowWidth >= 900`; the whole tab host is conditionally mounted. Below that width, the sidebar disappears and its toolbar/menu entry points are disabled. There is no drawer or expanded alternative. Chat cleanup cancels the current run; provider and embedding settings drafts are component state and are discarded when their components unmount. Closing the sidebar also unmounts those drafts.

Use an overlay/drawer at narrow window widths, preserve active work and unsaved settings outside the presentation component, and make closing behavior explicit. A responsive layout change should not function as an implicit cancel/discard operation.

Evidence: [ExplorerHome.tsx](../../apps/shell/src/renderer/src/explorer/ExplorerHome.tsx), lines 80, 290–291, 409 and 439; [WorkspaceChat.tsx](../../apps/shell/src/renderer/src/WorkspaceChat.tsx), effect cleanup; [SettingsModal.tsx](../../apps/shell/src/renderer/src/SettingsModal.tsx), `AiModelPane` state.

### 4. Medium — saved-model fields never enter their compact layout while this sidebar is visible

**Source-confirmed.** Saved profiles use two equal columns. Their one-column media query activates only below a 650px window width, but this sidebar is removed below 900px. Thus a 300px sidebar on a wide window still uses the two-column profile form. With nested card padding, very little width remains for endpoint URLs, model IDs, and keys.

Make saved-profile forms one column in the sidebar, or use a container query based on the actual panel width. Collapsed profile summaries should show name, model, connection status, and a clear Edit action; expand only the profile being edited.

Evidence: [chat-models-settings.css](../../apps/shell/src/renderer/src/chat-models-settings.css), lines 10 and 13; [ChatModelsEditor.tsx](../../apps/shell/src/renderer/src/ChatModelsEditor.tsx), every profile rendered with `open`.

### 5. Medium — the assistant devotes too much structure to context and administration

**Design assessment grounded in the component structure.** Before the transcript come the conversation heading, New chat/Manage history actions, a separate conversation dropdown, approval/workflow cards, fingerprint status, and a selection block. After it come model selection, composition, save status, and a long privacy note. The current title is effectively repeated in the heading and conversation selector.

Selection and fingerprint regions have their own scrolling; the selection list adds another scroll container inside its region. The transcript has a 100px minimum and the outer assistant panel hides overflow. With long selections, errors, or approval cards, the composer/transcript compete with multiple bounded regions. The exact height at which clipping occurs needs a visual check.

Use a single conversation switcher/title row with New chat and an overflow menu; show scope as a compact expandable row; show detailed change notices only when action is needed. Give the transcript the flexible space and the composer a persistent footer. Put detailed approval review in a dedicated expanded view when it needs substantial space. Keep consent relevant to a decision, and put general storage explanations in an accessible disclosure.

Evidence: [WorkspaceChat.tsx](../../apps/shell/src/renderer/src/WorkspaceChat.tsx), rendered structure beginning at line 338; [explorer.css](../../apps/shell/src/renderer/src/explorer/explorer.css), lines 235 and 251; [history.css](../../apps/shell/src/renderer/src/history/history.css); [workspace-selection.css](../../apps/shell/src/renderer/src/workspace-selection.css), line 1.

### 6. Medium — RAG and analytics are stacked as full workflows without an overview

The second tab places Directory RAG, consent, indexing actions, and embedding settings ahead of the full Structured Data Analysis workflow and its settings. Opening embedding settings pushes analytics even farther down. Settings each have both a prominent button and a disclosure summary leading to the same content.

Use two compact capability cards, **File search** and **Table analysis**, with readiness, last update, and one primary action each. Expand only the current task; keep configuration secondary. A small Search/Tables sub-navigation is also viable, provided it preserves scope and progress visibility. Avoid another permanently expanded stack.

Evidence: [RagAnalyticsPanel.tsx](../../apps/shell/src/renderer/src/explorer/RagAnalyticsPanel.tsx), lines 33–54; [RagSettings.tsx](../../apps/shell/src/renderer/src/rag/RagSettings.tsx); [AnalyticsSettings.tsx](../../apps/shell/src/renderer/src/analytics/AnalyticsSettings.tsx).

### 7. Medium — readiness and running-work status need a persistent place

**Source-confirmed omissions.** The RAG toolbar's summary contains its selected model or “not configured” status, but the sidebar hides that summary. The indexing button can therefore be disabled with no adjacent explanation of the configuration requirement. Analytics' imported-table list is populated after an explicit load, rather than presenting an initial readiness overview.

Visited tabs keep running while hidden, which is useful, but the tab labels contain no running, needs-approval, failure, or unsaved indicators. A user on AI Provider can miss an assistant approval waiting in the hidden first tab.

Add persistent, text-labelled status: “Needs setup”, “Ready”, “Indexing…”, “3 tables need review”, or “Approval needed”. Surface active jobs across tabs. Include the job's actual directory: running state is global, while the visible directory can change.

Evidence: [RagToolbar.tsx](../../apps/shell/src/renderer/src/rag/RagToolbar.tsx), lines 37–45; [workspace-control-panel.css](../../apps/shell/src/renderer/src/explorer/workspace-control-panel.css), lines 29–30; [AnalyticsToolbar.tsx](../../apps/shell/src/renderer/src/analytics/AnalyticsToolbar.tsx), catalog loading and progress; [WorkspaceControlPanel.tsx](../../apps/shell/src/renderer/src/explorer/WorkspaceControlPanel.tsx), preserved panels and tab labels.

### 8. Medium — detailed table review needs more room than a sidebar

The table review contains a source preview of up to 16 columns, a five-column editable policy table, multiple range/type/unit controls, warnings, a possible 20-row JSON editor, and approval controls. There are scrolling tables inside the scrolling tab. Long hashes and paths appear before the main review fields.

Keep catalog summaries and review status in the sidebar. Open “Review table” in a wide dialog or workspace view with a persistent dataset title, clear steps, and pinned approval actions. Put source hashes and raw policy JSON under Advanced/source details.

Evidence: [AnalyticsToolbar.tsx](../../apps/shell/src/renderer/src/analytics/AnalyticsToolbar.tsx), `ReviewTable`, lines 5–29; [analytics.css](../../apps/shell/src/renderer/src/analytics/analytics.css), table and warning scroll regions.

### 9. Medium — provider setup is ordered backwards and mixes distinct scopes

Saved profiles and Add current model appear before the provider configuration that users are told to complete first. Every saved profile starts expanded. Users encounter three model concepts: the provider's current model, the default for new chats, and the selected model in the current conversation. The AI Provider tab also shares global settings with the full Settings modal, despite appearing inside a directory-scoped sidebar.

Present the active/default model first, then a clear Configure connection flow and a compact saved-model list. Label scope explicitly: “Global connection settings”, “Default for new chats”, and “This conversation”. Explain that changing a default does not necessarily change the existing conversation's selected model.

Evidence: [SettingsModal.tsx](../../apps/shell/src/renderer/src/SettingsModal.tsx), line 381 and the following provider form; [ChatModelsEditor.tsx](../../apps/shell/src/renderer/src/ChatModelsEditor.tsx), lines 24–31; [ChatModelPicker.tsx](../../packages/ui/src/ChatModelPicker.tsx).

### 10. Medium — saving, loading, and errors use inconsistent interaction patterns

The provider form renders no body while settings are loading; the initial settings request has no displayed failure/retry state. Save/test actions live at the end of all profile and provider controls, with no persistent unsaved indicator or discard action. Provider validation/save errors use `window.alert`, while RAG and analytics show inline messages.

Use a visible loading state, contextual retry state, field-level validation, and a consistent footer with Unsaved changes, Discard, Test connection, and Save where appropriate. Mark successful tests separately from successfully persisted settings. Preserve unsaved input across presentation changes without silently saving it.

Evidence: [SettingsModal.tsx](../../apps/shell/src/renderer/src/SettingsModal.tsx), lines 284, 305, 349–358 and 541; [RagSettings.tsx](../../apps/shell/src/renderer/src/rag/RagSettings.tsx); [AnalyticsSettings.tsx](../../apps/shell/src/renderer/src/analytics/AnalyticsSettings.tsx).

### 11. Medium — typography and responsiveness are based on the window, not the panel

Tab text is 11px and drops to 10px below a 1120px window width. Context explanations are 10px; the assistant privacy note is 9px; several history controls are 10px. The three labels must also share the width with a separate close button. Arbitrary word wrapping can make technical labels harder to scan.

Shorter labels such as **Chat / Knowledge / Models** would leave room for a more readable type scale. Keep a stable tab height, use panel-width breakpoints, and reserve smaller text for secondary metadata. Proposed design targets, not compliance claims: 12–13px tabs and controls, 13–14px body text, 16px section titles, 36px regular controls, and 12–16px panel padding using shared spacing tokens.

Evidence: [workspace-control-panel.css](../../apps/shell/src/renderer/src/explorer/workspace-control-panel.css), lines 4, 18–19 and 45–47; [explorer.css](../../apps/shell/src/renderer/src/explorer/explorer.css), lines 233, 237 and 310.

### 12. Medium — theme, localization, and keyboard focus need a shared treatment

The shell uses `--ex-*` tokens, embedded settings use modal tokens such as `--surface` and `--text-primary`, and saved-model controls use another group such as `--bg`/`--text` plus fallback colors. This creates independent sources for colors, radii, and input styling. Actual color mismatch and contrast still require visual verification.

Only the assistant tab label is localized by the host. RAG & Analytics, AI Provider, much of their content, and saved-model text are hard-coded English. Some shared controls retain physical left/right alignment. Tab arrow navigation does account for RTL, which is worth retaining.

The chat textarea explicitly removes its outline, while the local focus rule covers buttons and inputs but not textareas. Add a visible textarea or composer focus state. Audit field associations: the custom-provider Model ID text input has an ID but its adjacent label does not reference it.

Evidence: [WorkspaceControlPanel.tsx](../../apps/shell/src/renderer/src/explorer/WorkspaceControlPanel.tsx), labels and keyboard handler; [chat-models-settings.css](../../apps/shell/src/renderer/src/chat-models-settings.css); [settings.css](../../apps/shell/src/renderer/src/settings.css); [explorer.css](../../apps/shell/src/renderer/src/explorer/explorer.css), line 308; [history.css](../../apps/shell/src/renderer/src/history/history.css), line 32; [SettingsModal.tsx](../../apps/shell/src/renderer/src/SettingsModal.tsx), Model ID field.

## Recommended arrangement

| Shared region | Chat | Knowledge | Models |
| --- | --- | --- | --- |
| Header | Same three tabs, close/expand controls, and activity indicators across the sidebar | Same | Same |
| Context | Directory name; selected-file count | Directory name; search/table readiness | Explicit global-settings scope |
| Primary content | Conversation switcher, transcript, contextual approvals | File search card; table analysis card; current job | Current/default model; compact profiles; one connection editor |
| Secondary content | Expandable scope, history management, storage/change details | Configuration disclosures, source details, clear-data menu | Advanced parameters, credential help |
| Footer | Model selector, message composer, save/error status | Current operation with progress and Stop when running | Unsaved status, Discard, Test, Save |
| Expanded workflow | Large approval previews/history management when necessary | Table preview, column policy, validation and approval | Optional full settings view |

Retain the three-tab structure while making each tab's purpose distinct. Keep one primary vertical scroll area per tab; horizontally scrolling data tables belong in the expanded review surface. Preserve user consent near indexing/import actions and keep destructive clear actions in a secondary menu with their existing confirmation step.

## What to retain

- Proper tab/tabpanel associations, roving tab focus, manual activation, Home/End and directional navigation.
- Lazy first mounting and preservation of visited tabs while switching among them.
- The keyboard-operable splitter and its 300–560px permitted sidebar range.
- Explicit distinction between an opened directory and files authorized for model access.
- Separate model connection testing, local history status, and confirmation before destructive clear actions.
- Source and freshness information, presented at the point where it helps a decision.

## Suggested delivery order and acceptance checks

1. **Restore reliability:** narrow the hidden-button selector, fix provider row sizing and saved-profile columns, preserve work at the responsive breakpoint, and restore composer focus visibility.
2. **Simplify each workflow:** condense chat context/history, introduce a search/table overview, move full table review to a wider surface, and reorder model configuration.
3. **Unify the design:** shared type/spacing/control tokens, localization and RTL treatment, consistent loading/error/save states, and cross-tab job/approval indicators.

Visual/interaction verification still needed:

| Dimension | Cases | Acceptance |
| --- | --- | --- |
| Sidebar width | 300, default 360, expanded 560px | No control overlaps or unintended horizontal panel scrolling; readable labels |
| Window size | 899/900px boundary; 1120px boundary; short laptop-height window | No lost drafts or cancelled work caused solely by resizing; composer and actions remain reachable |
| Zoom and language | 100%, 150%, 200%; English, Arabic/RTL, long translated labels | Usable reflow and navigation; no hidden functionality |
| Assistant | Empty chat, long title, 0/1/many selected files, changed files, failed history save, long conversation, pending approval | Recovery actions visible; transcript remains useful; approvals remain discoverable across tabs |
| Knowledge | Unconfigured model, idle ready state, indexing another directory, failure, imported tables needing review, wide dataset | Next action explained; correct job scope; progress/Stop visible; full review usable |
| Models | Zero/one/many profiles, long model ID/URL, slow/failed loading, failed test/save, unsaved edits | Clear connection/default/current-chat scopes; persistent save feedback; no silent draft loss |
| Input | Mouse, keyboard-only, keyboard resizing, screen reader | Visible focus, meaningful labels, correct tab order and announcements |
| Themes | Light and dark | Consistent surfaces, controls, statuses, and verified contrast |

The existing workspace-tab structural checks verify wiring and source structure; they do not demonstrate that controls fit, remain visible, or preserve work through responsive changes. Treat rendered and interaction checks above as necessary follow-up before approving a redesign.

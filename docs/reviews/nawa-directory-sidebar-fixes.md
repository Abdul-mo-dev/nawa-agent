# Directory sidebar fixes and verification

Implemented 2026-09-27 against the [12-finding design review](nawa-directory-sidebar-design-review.md).

| Finding | Implemented change |
| --- | --- |
| 1. Hidden recovery/history controls | The hiding rule targets only the redundant header Hide chat action. Retry, check, delete, rename-cancel and database actions remain available. History has the dialog's visible Close control. |
| 2. Provider form overflow | Text/select fields stack their labels above full-width controls; switches retain a separate row layout. |
| 3. Lost state on resize/close | The sidebar stays mounted when hidden. Smaller windows use a drawer; visited tabs retain their components, drafts and running work. |
| 4. Cramped profile forms | Profiles start collapsed, expand individually, and use one-column forms based on the panel. |
| 5. Crowded Chat layout | One conversation switcher, expandable scope/storage details, one primary scroll area and a composer footer. History and assistant action review have larger dialogs. |
| 6. Stacked Knowledge workflows | File search and Table analysis have compact overview cards with status; only the selected task expands. Settings and data clearing are secondary disclosures. |
| 7. Hidden activity | Tab indicators, a toolbar indicator, and cross-tab status links expose running work, approvals, errors and unsaved settings. Jobs identify their actual directory. The table catalog loads automatically. |
| 8. Narrow table review | A wide modal provides readable horizontally scrolling tables, source details, advanced JSON and pinned confirmation/approval controls. Unsaved close requires an explicit discard. Catalog refresh preserves an open draft; the original source generation remains attached to approval. |
| 9. Model setup order/scope | Connection settings come before saved profiles. Global settings, the default model and conversation model selection are explained separately. Default-following behavior is labelled accurately. |
| 10. Loading/saving feedback | Models has visible loading/retry, inline save/test results, an unsaved indicator, discard and persistent actions. Search/analysis settings also offer retry/discard and unsaved indicators. |
| 11. Typography/responsiveness | Short Chat / Knowledge / Models labels, panel container queries, shared spacing/control sizes, readable body/metadata text and a drawer for narrow windows. |
| 12. Theme/localization/accessibility | Shared Explorer theme aliases, localization for sidebar copy, Arabic translations and RTL layout, visible focus, uniquely associated model-input labels, labelled table controls, modal focus return and drawer keyboard containment. |

The localization catalog falls back to English for untranslated copy. Existing provider translations are retained; this is not a claim that all advanced text has been translated into every application language.

## Verification

- **39 browser assertions** passed with the real React components and synthetic desktop APIs: 300/360/560px panel widths; an 800px-wide drawer; a 720×450 short viewport; English/light and Arabic/dark; retained chat/model/search drafts; load/save failure recovery; discard; visible history actions; table review, stale-source rejection, keyboard focus and hidden-job scope.
- **24 shell tests** passed across settings, history cancellation and analytics service tests.
- **32 shared UI tests** passed.
- Shell TypeScript check and production build passed.
- Workspace-tab structural/syntax checks and theme-token check passed.
- Focused lint passed with two existing ref-cleanup warnings in ExplorerHome. No lint errors.

The [browser fixture and runner](../../tools/sidebar-review/README.md) are reproducible. Generated screenshots live under `.task/sidebar-review/`; they are intentionally excluded from Git. The in-app browser was unavailable, so an isolated local Chromium instance was used. These renderer checks do not exercise live providers or replace manual screen-reader testing, measured contrast auditing, or desktop browser-zoom testing.

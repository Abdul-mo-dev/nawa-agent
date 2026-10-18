# Editor file formats

Windows installers register each format under a product-specific ProgID and add
it to Open With. Installation preserves existing extension defaults and Windows
UserChoice settings. Open commands quote both the executable and file path.
Uninstall removes Nawa's own registrations and Explorer New templates.

| Editor        | Opens                                                                                | Saves                                                |
| ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Docs          | `.docx`, `.docm`, `.dotx`, `.dotm`, `.doc`, `.dot`, `.odt`, `.rtf`                   | `.docx`, `.docm`, `.dotx`, `.dotm`                   |
| Sheets        | `.xlsx`, `.xltx`, `.xlsm`, `.xltm`, `.xls`, `.csv`, `.tsv`, `.ods`, `.xlsb`          | `.xlsx`, `.xltx`, `.xlsm`, `.xltm`, `.csv`           |
| Slides        | `.pptx`, `.ppsx`, `.potx`, `.pptm`, `.ppsm`, `.potm`, `.ppt`, `.pps`, `.pot`, `.odp` | `.pptx`, `.ppsx`, `.potx`, `.pptm`, `.ppsm`, `.potm` |
| PDF           | `.pdf`                                                                               | `.pdf`                                               |
| Markdown/text | Markdown, text, configuration and source files listed below                          | Same extensions                                      |
| HTML          | `.html`, `.htm`                                                                      | `.html`, `.htm`                                      |

Template files open for direct editing. Save retains the template or slideshow
package type. Save As can produce a regular `.docx`, `.xlsx` or `.pptx` copy, or
save a regular document as a template/show. Changing the extension through Save
As also updates the main-part declaration inside the Office package.

Legacy Word `.doc`/`.dot` and PowerPoint `.ppt`/`.pps`/`.pot` files are imported
as editable `.docx`/`.pptx` copies through an installed LibreOffice. The app
detects LibreOffice on PATH and in common installation locations. For a custom
installation, set `NAWA_LIBREOFFICE_PATH` to its executable and restart Nawa.
LibreOffice is an optional external dependency; it is not bundled with Nawa.

OpenDocument Text `.odt` and Presentation `.odp` use the same isolated importer
and save as new `.docx` and `.pptx` copies. Open dialogs, drops, OS launch routing,
folder browsing and folder chat support both extensions. Chat inspection reads a
converted snapshot; edits pass through the normal before/after review and create
a modern sibling without changing the source. Native ODT/ODP export is not supported.
Attachments and search extract saved paragraphs and slide notes without running
LibreOffice. Their text extraction validates MIME and manifest metadata, rejects
encrypted packages and XML DTDs, and bounds ZIP inflation and XML text expansion.
Visual media, table relationships and exact layout need native inspection.

The importer accepts sources and converted packages up to 64 MiB. Each conversion
uses a private source copy and an isolated profile, disables macro execution and
Windows OLE automation, and removes its temporary files. Internal chart objects
remain readable; globally disabling active content would drop legacy charts.
A conversion taking longer than
90 seconds is terminated. Missing converters, corrupt files and encrypted Office
packages produce localized errors. Password-protected legacy documents are not
supported.

The source file remains the tab's identity until the first explicit save chooses
a modern Office file. Save As suggests the sibling `.docx`/`.pptx`, never
overwrites that sibling during import, and refuses legacy suffixes. Background
AutoSave retains crash recovery copies until a modern save destination is chosen.
Conversion notices explain that layout/animations may change and macros are not
retained. These imports do not promise a lossless round trip back to binary Office.

Sheets imports `.xls`, `.tsv`, `.ods` and `.xlsb` as converted copies, saved as
`.xlsx`. Original files remain untouched. ODS/XLSB imports accept files up to
64 MiB and display a dismissible notice: formatting, charts/chart sheets, images,
macros and named ranges are not imported. Cell data and basic date formats are
retained, including conversion of the Excel 1904 date system. Conversion runs
in a disposable sidecar process under conversion budgets: 1 GiB total uncompressed size,
64 MiB per uncompressed part, 256 MiB total generated XML,
10,000,000 cells per sheet bounding box, 30,000,000 cells total, and a
120-second deadline. Imports run one at a time across clients. Timeout terminates this process without affecting open
workbooks. A file whose declared sheet dimensions cover a near-full
grid is refused even when its stored cells are few — clear formatting far
outside the data (reset the used range) and retry. Budget refusals surface as
an import-size error and are distinct from corrupt-file failures.

ODS formulas using supported functions, local A1 references and references to
other imported sheets are translated to Excel syntax. Unsupported expressions
retain their cached values. If the reader cannot decode a sheet's formulas, its
cached cell values are retained. The notice reports both kinds of formula loss.
Existing `.xlsm` and `.xltm` files retain their macro-enabled package type on
Save. Save As can switch between macro-enabled workbook and template while
preserving VBA parts. OpenDocument document/presentation imports remain outside
this implementation.

The text editor opens `.md` and `.markdown` in its Markdown block editor.
`.txt`, `.json`, `.jsonl`, `.ndjson`, `.yaml`, `.yml`, `.toml`, `.ini`, `.xml`,
`.log`, `.py`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.cs`, `.rs`, `.go`, `.java`, `.c`,
`.cpp`, `.h`, `.hpp`, `.sql`, `.sh`, `.ps1` and `.css` use the source editor.
JSON retains its existing highlighting; the other source formats use plain text
editing. Source saves preserve BOM and line-ending style and do not interpret
Markdown image references as assets.

The open-file assistant reads the live source buffer, including unsaved changes
and the current selection. Its source edits are undoable in the visible editor
and follow the normal Save/AutoSave flow. The shell's open-document reader uses
that same buffer. Source scrolling stays inside the editor viewport.

The browser-safe catalog lives in
[`packages/file-formats/src/extensions.json`](../packages/file-formats/src/extensions.json).
It drives editor routing, open dialogs, drag-and-drop, OS launch handling, folder
listings, sidebar families and the editor capability report. Packaged file
associations declare the same extensions; an existing installation needs a new
installer to receive the additional OS associations.

MCP session generation and explicit-path saves still use `.docx`, `.xlsx` and
`.pptx`. Editor support and directory-agent inspection/editing capabilities are
separate catalogs; widening one does not advertise unsupported agent operations.

## Source editing, images and saved emails

Directory chat can inspect, create and edit the supported source-text extensions
through `read_text`, `replace_text` and `write_text`. Edits use an isolated private
copy and the existing preparation approval, before/after review, save approval and
backup. Replacement requires a current SHA-256 revision and one exact match.
Source edits preserve UTF-8/UTF-16 BOMs and existing line endings. Unsupported or
malformed encodings and binary NULs are rejected rather than rewritten lossily.
Source editing is bounded to 8 MiB; JSON edits must parse. Other languages receive
an encoding check, not syntax validation or execution. CSV/TSV continue to use
Sheets and save reviewed XLSX copies.

RTF uses the same installed LibreOffice importer as legacy Word documents. It
opens in Docs and directory inspection as a converted model; reviewed edits save
a new DOCX sibling. Reading RTF also requires LibreOffice. RTF export is not
supported, and the source remains unchanged.

PNG, JPEG, WebP, GIF, BMP and TIFF open in file tabs in the central pane with zoom,
fit and pan. The image runtime normalizes the first frame/page to PNG;
preview accepts files up to 64 MiB and images up to 20 million pixels. Directory
`read_file` can recognize image text through the installed local OCR helper,
without indexing first. OCR is labeled as recognized text and cannot establish
visual meaning or exact wording. The file assistant receives a bounded view of
the displayed frame when the selected model supports vision; text-only models
use local OCR. Images remain ineligible for content editing.

EML and MSG open in central file tabs with headers, body text, attachment
inventory and extraction warnings. HTML bodies are reduced to text; remote
resources are never loaded. The directory assistant can read messages, summarize
them or draft a separate reply. It cannot save changes to the original email or
send mail. MSG search indexes Unicode/ANSI MAPI properties and readable HTML;
compressed-RTF-only and encrypted bodies are reported as unavailable. MSG
attachment contents and embedded messages are not extracted. EML retains its
existing searchable text-attachment/OCR support. Message previews accept 64 MiB
inputs, list at most 100 attachments, and bound body text to two million characters.

Each preview has a file assistant and separate saved chat history, including for
files opened outside registered workspace folders. Email tools read the displayed
snapshot, not another selected file. Closing a tab revokes its preview read access;
OCR rejects a file that changed since the displayed snapshot. Refresh reloads the
preview. Tab switching and closing cancel any active file chat request.

Preview extensions live in `packages/file-formats/src/preview-extensions.json`.
Both catalogs drive open dialogs, OS launch handling, drag-and-drop, folder lists
and installer associations. Preview-only formats do not advertise editing.

Folder chat can inspect and edit individually selected `.doc`, `.dot`, `.ppt`,
`.pps` and `.pot` files through the same LibreOffice importer. `update_file`
opens a private modern snapshot in the native editor and creates an edited
sibling `.docx`/`.pptx` after the existing preparation and save approvals. If
that sibling exists, an `-edited` filename is chosen; existing files are never
replaced. Both reviews show the legacy source and modern output. The change
review compares the converted snapshot before and after chat edits, and reports
conversion limitations separately. Commit receipts identify a created modern
file and its preserved source. Source hashes are checked throughout the workflow,
including the final save. This support does not write binary Office files.

Folder chat also inspects and edits individually selected `.xls`, `.ods`,
`.xlsb`, `.csv` and `.tsv` files. They follow the same reviewed-copy workflow,
using the Sheets Rust sidecar for binary/OpenDocument workbooks and the existing
CSV decoder/parser for delimited text. TSV always uses tabs. Delimited imports
accept up to 32 MiB; binary/OpenDocument imports accept up to 64 MiB. Saves create
new `.xlsx` files even for CSV, with original hashes checked through commit.
The review compares the converted workbook before and after the edits and reports
feature loss and formula fallback counts. Native inspection and validation also
use private modern snapshots. This does not widen analytical ingestion or
retrieval support for the binary/OpenDocument formats.

Folder chat also supports individually selected `.dotx`, `.xltx`, `.ppsx` and
`.potx` files. A bounded private package copy changes only the OOXML main-part
content type to the regular `.docx`, `.xlsx` or `.pptx` type; document parts,
workbook data and slide assets are passed to the native editor. Inspection and
validation use the private regular-format copy. Editing uses the same two
approvals, before/after review, source-hash checks and collision-safe new
sibling filename. The template or slide-show original is never overwritten,
and the new file has regular document, workbook or presentation semantics.
These package imports accept files up to 64 MiB.

Folder chat can inspect, validate and edit an individually selected existing
`.xlsm` workbook through the native Sheets bridge. It stages a private `.xlsm`
copy, reviews the worksheet change and saves in place only after the two
approvals. The commit includes a backup of the original. The saved workbook
keeps its macro-enabled content type, VBA relationship and untouched
`vbaProject.bin` bytes; Nawa does not run macros. Creating a blank `.xlsm`
through folder chat is not supported.

The Docs editor opens and saves existing `.docm` files while retaining their
macro-enabled content type and untouched VBA parts. Its Save As dialog keeps
macro-enabled documents in `.docm` and macro templates in `.dotm`, so a
bare-name save cannot silently convert a macro template to `.docx`. Folder chat can inspect, validate and edit
an individually selected `.docm` through a private native Docs stage. The
reviewed save replaces the existing file only after both approvals and creates
a backup. Nawa does not run macros or create blank `.docm` files through folder
chat.

Folder chat inspects `.xltm` templates through a private `.xlsm` copy. Editing
also creates a new reviewed `.xlsm` sibling and leaves the `.xltm` original
unchanged. It changes only the workbook main-part content type while retaining
the VBA relationship and project bytes. The same two approvals and source-hash
checks apply. Blank `.xltm` creation is not supported.

Existing `.docm`, `.dotm`, `.pptm`, `.ppsm` and `.potm` files are inspected,
validated and edited in place through the native editor, with the same two
approvals, source-hash checks and commit backup as other in-place edits.
Macro code is preserved untouched and never executed. Blank
`.docm`/`.dotm`/`.pptm`/`.ppsm`/`.potm` creation is not supported; none of
these formats accepts a converted-copy workflow.

The XLS reader can misdecode relative range flags as column numbers. References
outside the XLS limit of 256 columns and 65,536 rows retain their cached values
and contribute to the formula-fallback count; invalid references are never saved
as formulas in the new XLSX copy.

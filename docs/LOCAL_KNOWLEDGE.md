# On-device file knowledge and analysis

Nawa extracts, OCRs and indexes selected local files itself. New embedding settings use **llama.cpp**, with the model served by your local embedding server. MyAgent.Server is optional. Existing saved profiles are preserved; the built-in model remains available under advanced settings.

## Use it

For the complete question-to-answer process, see [Selected files chat flow](SELECTED_FILES_CHAT_FLOW.md).

For local chat configuration and a 4 GB GPU starting profile, see [Local llama.cpp setup](LOCAL_LLAMA_CPP.md). Its chat server and the embedding server below have separate models and settings.

1. Open a workspace directory and select the individual files the chat may use.
2. Open **Settings → AI & Models → Configure embeddings**, or follow the model-settings link from **Knowledge**. Enable file search, enter the llama.cpp server address, and click **Load models**. Select the loaded embedding model, test the connection, and save. Nawa verifies actual embeddings; a loaded chat model alone is insufficient. Credentials, prefixes and chunking are under **Advanced embedding settings**.
3. Click **Index** at the top of chat. It starts embeddings for the selected files and prepares supported tables for native analysis, using the approval mode saved in Knowledge settings. The two operations run independently; an embedding connection error does not block table preparation. Search and analysis status appear in the main file table. Hover or focus each icon for errors, warnings, processing stages and measured embedding passage progress where available. Click Index again after changing a source file or the embedding profile. The main file panel’s **More actions** retains indexing and table-review tools.
4. Ask the directory chat to search those selected files. Search returns candidate passages with file and page, section, sheet, slide, message part or ZIP-entry locations where available. It does not prove a whole-file count or absence of a term.

For a location or topic question, the chat can use indexed passages as context. For an exact quote, saved cell value or formula, it must then read the selected source with a native file tool. An inspection inventory alone does not verify the content. The chat also checks presented verbatim passages against that direct read. If only OCR recognition is available, the answer must identify it as recognized text and avoid claiming visually verified wording. Unsupported formats or inaccessible content are reported as limits.

The native index handles text and code, CSV/TSV, JSON/JSONL, XML/HTML, PDF, DOCX/DOCM/DOTX/DOTM, XLSX/XLSM/XLTX/XLTM, PPTX/PPTM/PPSX/PPSM, legacy DOC/PPT text, EML, ZIP, and PNG/JPEG/WebP/GIF/BMP/TIFF images. A ZIP entry is processed within bounded entry and expanded-size limits. Email text and supported text/image attachments are indexed; unsupported attachment content and nested ZIP files are reported as incomplete. OCR uses the packaged system helper on Windows and macOS; recognition quality and installed languages vary. The index marks OCR text and incomplete extraction so the original can be checked before relying on exact wording.

Successful standalone image OCR shows a checkmark labelled **Image text indexed (OCR)**. Its tooltip keeps the passage count and explains that visual meaning and layout are not embedded. This informational text-only notice does not indicate an indexing failure. Additional extraction warnings still show a warning indicator; an image with no readable OCR text shows an indexing failure and creates no content vectors.

Other successfully indexed files with extraction limitations show **Text indexed with limitations**. This includes PDF text or OCR, legacy DOC/PPT text, ODT/ODP extraction, and Office, HTML, email or ZIP files with incomplete coverage. The warning tooltip confirms that extracted text was embedded and retains the specific limitations, such as unreadable pages, missing worksheets, skipped attachments or unprocessed visual content. A warning does not mean the entire file failed; an indexing failure remains a separate error status.

The index stores extracted text and vectors in Nawa's user-data folder without encryption. With llama.cpp, model files and inference are managed by your embedding server. The optional built-in model downloads and caches its files in Nawa's user-data folder. The original source files are not edited. Selecting a directory for indexing does not give the chat access to every child; it can use only individually selected files.

## Tables and SQL

For calculations, select CSV, TSV, JSON, JSONL/NDJSON, XLSX or XLSM files and ask the chat directly. It uses Ready local SQLite tables, preparing them when the saved preparation settings allow it. If preparation is disabled or a table needs a population or formula decision, it reports that blocker. **More → Prepare & export** explicitly reviews eligible selected tables and exports a SQLite database. Neither path needs the file-search index or MyAgent. Numerical conclusions require a native `query_data`, `analyze_data` or `query_sql` result with source coverage and a visible receipt ID; RAG hits and previews cannot establish totals. When the reviewed grain is only “One source data record,” Nawa reports the mechanical record/nonblank/distinct count and makes a requested business-entity interpretation conditional. `query_sql` accepts parameterized read-only SELECT/WITH queries and enforces the selected-dataset scope. See [Data analysis](DATA_ANALYSIS.md) for review rules, numeric precision and population coverage.

Grouped calculations can compute more groups than should be printed in chat. Nawa reports the complete input/group coverage, shows a concise bounded preview, and states “showing X of Y” when rows are omitted. It does not reconstruct a typed aggregate with raw SQL pagination or imply that a displayed subset is the complete result. Narrow the group/filter or explicitly request a full result export when every high-cardinality row is needed.

## Current boundaries

| Capability                                                                            | Nawa native file engine                    | Optional MyAgent backend               |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| Extraction, OCR, embeddings and hybrid search                                         | Yes, for supported selected files          | Yes                                    |
| Saved-file Office/PDF inspection                                                      | Native read tools                          | Server readers also available          |
| Reviewed tables, read-only SQL and statistics                                         | Native tools; no MyAgent connection needed | Separate exploratory spreadsheet tools |
| Image scene interpretation and server visual readers                                  | No; OCR recognizes text only               | Available when configured              |
| Saved server text classification, retained result paging and the full 46-tool catalog | No                                         | Available when configured              |

Native ingestion does not currently parse XLS, XLSB, ODS, RTF, DOT, PPS or POT files; convert them to XLSX, DOCX, PPTX or PDF before indexing. ODT and ODP text extraction is supported. On Linux, image and scanned-page OCR is unavailable until a local OCR helper is supplied.

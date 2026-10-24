# AI & Models

Open **Settings → AI & Models**. This page manages local llama.cpp runtimes and [saved remote API profiles](remote-models.md) for chat and embeddings. The optional MyAgent integration continues to administer the separate MyAgent service.

New Windows installations offer a guided download and configuration of the default chat/embedding models, chat template and missing runtime dependencies. Existing users can open **Default models and dependencies** on this page. See [Windows installation and runtime setup](runtime-setup.md).

## Set up a local model

The page shows the selected **Chat model** and **Embedding model** first, followed by one **Local models** list. There are no internal settings tabs. Connection editors, runtime setup, downloads and advanced launch options expand in place when needed. Closing an editor or switching settings sections preserves its unsaved draft.

1. Expand **llama.cpp runtime** and browse to an existing `llama-server.exe`. This executable is shared by the local profiles. Alternatively, expand **Download models or install llama.cpp** to download an official Windows engine ZIP. The newest published release containing server binaries is shown, including its development-build status. The matching CPU architecture is preferred in the list. Choose a CPU, Vulkan, or CUDA build suitable for your hardware; CUDA builds may need the corresponding CUDA runtime installed separately. Select the installed executable in runtime setup before use.
2. Select **Add local model**, choose its chat or embedding role, give it a name, and select an existing GGUF. To get new weights, expand the download section, search public Hugging Face repositories or enter an `owner/repository` ID, list its GGUF files, and download a quantization. Select a downloaded model and **Use model file** to assign it to an existing profile or open a new profile. Restricted repositories requiring authentication are not supported by the downloader.
3. Expand **Advanced launch options** if you need to change the served alias, context size, GPU layers, CPU threads or command arguments. Each profile needs a unique port. Select **Save profiles** before starting. Model and engine paths must be absolute. Chat profiles used by Nawa need at least 4,096 context tokens.
4. Select **Start** in the model row. The status remains **Loading model** until `/health` reports ready. **Edit** opens the profile and its logs, which show missing runtime libraries, invalid arguments, unsupported models and memory failures. Startup times out after three minutes; the failed process is stopped.
5. Select **Use for chat** or **Use for embeddings** after the runtime is running. Saving or starting a profile alone does not change the active connection. The **Default** badge identifies the configured connection; the runtime status describes only the server owned by Nawa. Stop a profile before changing or deleting its configuration. Servers started by MyAgent remain externally managed.

Each profile has editable enabled/disabled argument rows and a command preview. Nawa passes arguments directly to the executable without a shell. The profile owns the model, alias, loopback address, port, context size, GPU layers and embedding pooling switches; extra arguments cannot override these fields. A checkbox optionally starts a saved profile when Nawa opens. Separate profiles run in separate processes and may be started or stopped independently. Closing settings keeps the runtimes alive; quitting Nawa terminates processes it started, leaving other servers alone.

The served model alias is editable independently of the profile ID. GPU layers support `auto` as well as an explicit count (`-1` offloads all layers). **Model default** pooling leaves the pooling switch out of the command. Template files, multimodal projectors and sampling options can be supplied through additional arguments.

## Chat and embeddings

**Configure chat** opens the existing provider, credential, saved-model, context-budget and capability-test controls beneath the model cards. **Use for chat** adds or updates a saved local chat connection and selects it as the default without discarding other providers or saved chat models. Existing conversations with an explicitly selected model keep their selection. Model/template support determines whether tools and vision work; test capabilities in the chat settings. The command preview is a display of the exact executable and argument vector, rather than a shell script to paste.

The chat connection uses the served alias. With explicit parallel slots (`-np` / `--parallel`), Nawa budgets the configured context per slot: `-c 65536 -np 2` gives each chat 32,768 tokens. A positive `--n-predict` / `--predict` / `-n` sets the output policy within Nawa's supported bounds. Local requests inherit the server's sampling defaults, including its configured temperature.

**Configure embeddings** opens the embedding connection controls in the same place. The **Knowledge** page links to this single editor and keeps its data-analysis settings. Use a dedicated embedding model and its documented pooling method. **Use for embeddings** selects the local endpoint, clears its previous endpoint credential and model-specific prefixes, resets dimension detection, and changes the embedding revision so incompatible vectors are not reused. Configure the model's documented input limit and document/query prefixes in the embedding editor, then re-index the affected files from the workspace. Reapplying an embedding profile conservatively changes the revision again. For models other than the recognized EmbeddingGemma 2 profile, configure task prefixes and input limits from the model's documentation.

EmbeddingGemma 2 profiles use its documented retrieval prefixes (`task: search result | query: ` for queries and `title: none | text: ` for document passages) and an input limit of up to 8,192 tokens, bounded by the profile context size. The prefixes remain editable under **Configure embeddings**. See [Google's EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2?hl=en).

## Downloads and storage

Engines and weights are stored under `userData/local-models`, separately from Nawa's installer. Open that directory from the settings panel. `settings-v1.json` holds saved profiles; `engines` and `models` hold downloaded packages. Existing external model files remain in their original locations.

- Engine assets come from the official `ggml-org/llama.cpp` GitHub release API and require published SHA-256 digests. ZIP paths, links and decompression limits are checked before publication.
- GGUF downloads use a pinned Hugging Face commit and LFS SHA-256 metadata. Split models download and verify every shard before the package appears in the library. Only the first shard is listed for selection.
- Downloads stream to staging files, check byte counts, verify hashes and validate GGUF headers. Canceling or failing removes the partial staging directory. Completed packages are published by renaming their staging directory. A download continues if settings close while Nawa remains open; reopening settings shows its status.
- Deleting a profile keeps model files. Deleting a downloaded model removes its downloaded package, including split shards, and is blocked while a saved profile references the package. External GGUF files cannot be deleted through this control.

The downloader contacts GitHub and Hugging Face only for explicitly requested catalogs and downloads. It does not send document content to those services. Managed inference servers bind to `127.0.0.1`; Nawa's existing chat and RAG privacy settings still govern which content is used in model requests.

## Verification

Unit tests cover configuration conflicts, process ownership, loading/ready/failed states, busy ports, shutdown, literal argument handling, connection wiring, protected model deletion, checksum failures, cancellation, split models and safe archive extraction. `e2e/local-models.spec.ts` covers the single-page overview, collapsed editors, persistence, the shared embedding editor, Arabic and Japanese layouts, and light/dark themes.

The optional inference scenario uses `NAWA_TEST_LLAMA_SERVER` and `NAWA_TEST_EMBEDDING_MODEL` pointing to an existing executable and embedding GGUF. It verifies normalized vectors through `/v1/embeddings`, RAG connection application, Stop, Restart and process cleanup on exit. It does not download test weights or modify MyAgent's configuration.

Protocol references: [llama-server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [GitHub release assets API](https://docs.github.com/en/rest/releases/assets), [Hugging Face Hub API](https://huggingface.co/docs/hub/api).

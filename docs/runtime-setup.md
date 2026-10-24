# Windows installation and default runtime setup

The Windows installer launches Nawa after installation. After the welcome tour, a new installation offers **Set up Nawa**. The same controls are available under **Settings → AI & Models → Default models and dependencies**, without additional settings tabs. Existing installations with saved local profiles are not prompted to replace them.

The CUDA update has its own installer version, **0.11.1**. If **Local model runtime** only offers CPU and Vulkan, close Nawa and install version 0.11.1 or later, then reopen settings. The updated dropdown contains CUDA, CPU and Vulkan, with CUDA selected by default.

Choose **Install and set up** to download the default chat and embedding models, create their profiles and launch commands, and install missing conversion tools. This is an online setup: model weights are downloaded on first launch rather than embedded in the NSIS executable. Models require approximately 6 GB of downloads; allow 12 GiB of disk space and preferably 16 GB of RAM. The installed local services work offline. **CUDA is the default**, using the requested b11541 CUDA 12.4 build on Windows x64; ARM64 uses the available CUDA 13.4 build. Setup downloads the matching CUDA redistributable DLLs beside llama-server, so a separate CUDA toolkit is not needed. A compatible NVIDIA GPU and NVIDIA driver are required. Setup verifies that the CUDA backend detects a GPU before configuring the models. CPU and Vulkan remain selectable alternatives. Nawa does not install graphics drivers.

## Installed components

| Component          | Installation and configuration                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat               | Google's Gemma 4 E4B QAT Q4_0 GGUF, its official `chat_template.jinja`, and a saved `gemma-4-e4b` chat profile                                                                                                |
| Embeddings         | EmbeddingGemma 2 Q8_0 GGUF and its matching Q8_0 multimodal projector, with a saved `embeddinggemma-2` profile                                                                                                |
| llama.cpp          | Pinned b11541 Windows x64 or ARM64 CUDA/CPU/Vulkan binaries and matching CUDA libraries when selected; an existing external executable is reused                                                              |
| Microsoft runtime  | Checked for the required Windows runtime DLLs; the official Microsoft redistributable is downloaded when missing. Windows requests administrator permission for this shared system component                  |
| Office conversion  | Existing LibreOffice is reused. Otherwise the verified official MSI is extracted as an administrative image into Nawa's private dependency directory. It does not register another default Office application |
| OCR                | Nawa's Windows OCR helper is already bundled. Windows supplies the recognition languages; **Manage OCR languages** opens Windows Settings to install additional supported language features                   |
| Other native tools | PDFium, image codecs, the spreadsheet sidecar, SQLite and editor runtimes are already included. End users do not need Node.js, npm, Rust, Python, Microsoft Office or the Windows SDK                         |

The selected chat command follows the configured Gemma profile: total context 65,536, two parallel slots, batch 512, microbatch 128, automatic GPU layers, Q8_0 KV caches, Jinja, reasoning disabled, temperature 0.2, top-p 0.85, top-k 20, min-p 0.05 and an output cap of 1,024. It includes an absolute `--chat-template-file` path generated on the user's machine. Nawa budgets 32,768 context tokens per chat slot.

The embedding command uses context 8,192, batch 2,048, microbatch 512, one parallel slot, automatic GPU layers, F32 KV caches, `--embedding` and its absolute `--mmproj` path. The connection uses the EmbeddingGemma 2 retrieval prefixes. Actual request embeddings are text extracted by Nawa; downloading the projector does not add image/video ingestion to Nawa's RAG pipeline.

Profiles prefer ports 8083 and 8086 on `127.0.0.1`. Occupied or already-assigned ports are skipped. **Start models now and when Nawa opens** controls starting and autostart; **Use these models as Nawa defaults** controls selecting the chat and embedding connections. Existing profiles and other providers remain available. A changed embedding connection requires re-indexing affected source files.

## Storage and recovery

Files live under Nawa's per-user data directory:

- `local-models/defaults-v1`: the model weights, embedding projector and chat template.
- `local-models/engines/default-b11541-*`: managed llama.cpp executable and libraries.
- `local-models/settings-v1.json`: saved model profiles, including all command arguments.
- `dependencies/libreoffice-26.8.1`: app-managed Office conversion, including its upstream licenses.
- `setup`: download cache, setup state, `third-party-sources.json`, `chat.command.json`, `embedding.command.json`, and `Start-chat.ps1` / `Start-embedding.ps1` launchers. These PowerShell launchers read their argument arrays as data and preserve paths containing spaces.

Use the in-app Start/Stop controls while Nawa is running; the standalone launchers use the same ports and cannot run simultaneously with the corresponding managed servers. Nawa stops only model processes it starts. Closing settings keeps running model servers alive.

Downloads stream to `.part` files, support HTTP Range resumption and check their pinned size and SHA-256 before publication. Canceling preserves resumable bytes. Retrying reuses verified files and preserves customized saved profiles. A connection activation failure can be retried with **Use installed models** without downloading the weights again. Model and converter files are stored outside the application installation directory so an application update does not replace them.

The downloadable assets are pinned in [assets.ts](../apps/shell/src/main/runtime-setup/assets.ts). Update their URL, size and digest together when upgrading. Template downloads use an immutable Hugging Face commit; model downloads use immutable commits and published LFS hashes. LibreOffice uses its archived 26.8.1.1 MSI, with SHA-256 published by The Document Foundation. No third-party installers or model files are embedded in Nawa's executable.

## Sources and licenses

- [Google Gemma 4 E4B GGUF](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf) and [official chat template](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-unquantized): Apache 2.0.
- [EmbeddingGemma 2 GGUF and projector](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF): Apache 2.0.
- [llama.cpp b11541](https://github.com/ggml-org/llama.cpp/releases/tag/b11541): MIT; the downloaded distribution retains its included notices.
- CUDA runtime libraries are downloaded from that same pinned release, retain included notices, and are subject to [NVIDIA's CUDA license](https://docs.nvidia.com/cuda/eula/index.html).
- [LibreOffice licenses](https://www.libreoffice.org/about-us/licenses/): upstream licensing applies to the separately downloaded converter. It is not added to Nawa's shipped npm runtime; the permissive-only npm dependency gate is unchanged.
- [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist): distributed and installed under Microsoft's terms.

Automatic dependency installation currently targets Windows x64 and ARM64. macOS and Linux retain their existing model connections and platform installation workflows. MyAgent remains optional and separately managed; this setup does not install or modify MyAgent.Server.

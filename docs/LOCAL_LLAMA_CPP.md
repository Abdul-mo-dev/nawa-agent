# Local chat with llama.cpp on a 4 GB GPU

Nawa can use a local OpenAI-compatible chat server to choose tools and write answers. Its native file readers, OCR, retrieval index and SQLite analysis supply evidence. The model receives selected-file context and bounded tool results; table calculations run in the native analysis engine.

See [Tools and local/cloud compatibility review](TOOLS_AND_MODEL_COMPATIBILITY_REVIEW.md) for current limitations, recommended task policies, and switching between saved Local and Cloud profiles.

## Connect Nawa

In **Settings → AI Model**, configure the chat provider:

| Field                 | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| Provider              | Custom                                                   |
| Base URL              | `http://127.0.0.1:8082/v1`                               |
| Model                 | `Agent-A1-4B` — the server alias, including its spelling |
| API key               | Leave empty for a server without authentication          |
| Maximum output tokens | `4096`                                                   |

Add the connection under **Saved chat models**, name it **Local**, and open that profile's **Advanced model settings**. Set its context limit to the server's actual window (`16384` for the starting command below) and output limit to `4096`. **Test model** checks a synthetic function call and its result before saving. The Custom API key is optional when the server does not require authentication.

Save a cloud connection as another profile, then switch through Chat's **Model** picker between completed requests. Each profile retains its own limits. Keep image understanding off for this text-only GGUF. The Knowledge gear opens embedding settings; chat connections remain in the main AI Model settings section.

## Recommended starting command

This is a conservative starting profile for the supplied Q4_K_M model and llama.cpp **b10107**, rather than a measured guarantee of fitting every 4 GB GPU. It targets a 16,384-token context. Automatic GPU fitting may leave some layers on the CPU, which needs system RAM and can reduce speed.

Run this in PowerShell when starting your server. An existing server on port 8082 must first be stopped through the application or terminal that owns it.

```powershell
$llamaServer = 'C:\Users\abdul\AppData\Roaming\MyAgent\llamabinaries\b10107_llama-b10107-bin-win-cuda-12.4-x64\llama-server.exe'
$chatModel = 'C:\Users\abdul\AppData\Roaming\MyAgent\server\models\InternScience\Agents-A1-4B-Q4_K_M-GGUF\Agents-A1-4B-Q4_K_M.gguf'
$llamaArgs = @(
    '--host', '127.0.0.1', '--port', '8082',
    '--alias', 'Agent-A1-4B', '-m', $chatModel,
    '-c', '16384', '-np', '1',
    '-ngl', 'auto', '--fit', 'on', '--fit-target', '768',
    '-b', '512', '-ub', '128', '-fa', 'on',
    '-ctk', 'q8_0', '-ctv', 'q8_0',
    '--jinja', '--reasoning', 'on',
    '--reasoning-format', 'deepseek', '--reasoning-budget', '512',
    '--n-predict', '4096',
    '--temp', '0.85', '--top-p', '0.95', '--top-k', '20', '--min-p', '0',
    '--presence-penalty', '1.1', '--repeat-penalty', '1.0'
)
& $llamaServer @llamaArgs
```

The sampling values follow the [Agents-A1-4B model card](https://huggingface.co/InternScience/Agents-A1-4B). Keep Nawa's file-scoped system instructions; they define which sources and tools the model may use.

### Why these settings

| Setting                                     | Purpose                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `-c 16384`, `-np 1`                         | Start with a moderate context and one active generation slot.                                        |
| `-ngl auto`, `--fit on`, `--fit-target 768` | Allow fitting with a target GPU memory margin. Explicit context and batch values remain constraints. |
| `-b 512`, `-ub 128`                         | Use smaller prompt batches as a starting memory tradeoff.                                            |
| `-fa on`, Q8 K/V cache                      | Enable Flash Attention and quantized cache.                                                          |
| `--jinja`                                   | Use the model's chat template for tool messages.                                                     |
| `--reasoning-budget 512`                    | Bound thinking; it is a starting latency/quality tradeoff.                                           |
| `--reasoning-format deepseek`               | Return parsed thoughts separately through `reasoning_content`, which Nawa handles.                   |

Flag behavior is documented in the [b10107 server README](https://github.com/ggml-org/llama.cpp/blob/b10107/tools/server/README.md) and was checked against the installed binary's `--help`. Hardware choices above are recommendations, not benchmark results. A model template may affect reasoning behavior; verify both tool calls and answers when changing the budget.

If loading or generation runs out of memory, reduce `-c` to `8192` and set Nawa's output limit to `2048`. Keep questions focused and start a new chat for a separate task. Check the startup log for the actual context and GPU/CPU allocation. Reduce batches further if prompt processing fails. Increase context or offloading only after a representative file question completes with enough memory headroom.

## What Nawa adapts automatically

For a **Custom** provider at `localhost`, an IPv4 loopback address or `[::1]`, or a profile explicitly marked **Local server**:

- Chat requests omit the hardcoded temperature, preserving the server's sampling defaults.
- New local profiles default to **16,384 context tokens** and **4,096 output tokens**; new cloud profiles start at **65,536 / 8,192**. Configure the actual model/server ceiling in Settings. Output cannot consume more than half that configured context; lower task-specific caps remain possible. A reasoning model's completion allowance includes whatever reasoning its API counts toward output.
- Streaming, staged edits, and one-shot helpers share the selected connection's output policy. Explicit saved profile limits are independent of the old global limit.
- Directory chat and staged editing use the local loop policy: at most 24 model turns, 20 history messages, and mechanical compaction around 24 KiB with an 8 KiB recent-history target. A larger task can continue from its saved per-file checkpoints.
- Every dispatch budgets system instructions, schemas, history, opaque provider state and output capacity. When the conservative estimate exceeds the input allowance, llama.cpp's full chat `input_tokens` endpoint can count the rendered request, with `/apply-template` plus `/tokenize` as a fallback. Those checks include the tool schemas. Generic servers retain conservative estimates; oversized active requests fail with guidance to narrow the task or choose a larger context.
- Tool previews preserve receipt IDs and explicitly mark omitted content. Active tool pairs remain together. A saved action receipt is retained even if later work is interrupted; explicit continuation skips completed file actions.
- The chosen provider remains selected if configuration or connectivity fails. Custom image input requires an explicit capability or a successful optional image test. Local chat does not silently switch to a cloud provider.

History byte thresholds remain soft compaction triggers. Dispatch budgeting is a separate guard; conservative estimates and image reserves are not a universal tokenizer guarantee. Set the correct server ceiling and keep native source checks. A LAN model can use **Local server** explicitly; a loopback proxy forwarding to cloud can use **Cloud API**. Recognized hosted GPT/Claude/Gemini families default to cloud even behind localhost; explicit mode/limits take precedence. OpenAI/GPT cloud requests use local tokenizer-based estimates with reserves, while unknown tokenizers keep conservative estimates. Mode labels cannot prove where an upstream service runs.

## Embeddings and analysis

The chat model and embedding model are separate. Configure a suitable embedding model under **Settings → Knowledge**, normally at `http://127.0.0.1:8081/v1`, then select files and click **Index**. The chat GGUF alone does not establish a working embedding service.

On a 4 GB GPU, prefer running the embedding server on the CPU (`-ngl 0`) to avoid having two models compete for GPU memory. Test embedding requests in Knowledge settings; the embedding model's pooling and query/document prefixes must match that model. See [Local knowledge](LOCAL_KNOWLEDGE.md) for setup and format coverage.

Native table preparation and analytical queries can work without embeddings or MyAgent.Server. Retrieval locates relevant passages; direct readers verify exact saved content; native analytical queries establish numerical results. See the [selected-files question-to-answer flow](SELECTED_FILES_CHAT_FLOW.md).

## Verification in this workspace

Earlier on **2026-10-10**, the server at port 8082 reported healthy with alias `Agent-A1-4B`. A live test of the earlier adapter snapshot completed a function call with JSON arguments, accepted its tool result and returned an answer. During final implementation verification the endpoint was offline, so the revised adapter was verified with controlled protocol fixtures rather than another live model run. Provider regression tests cover local sampling, per-profile limits, keyless requests, full prompt budgeting, signatures and fragmented tool arguments.

That running server reported **128,000 context tokens on a 6 GB GPU**. The live test establishes transport/tool-message compatibility with that server. It does not establish memory fit or answer quality for the recommended 4 GB/16K profile. The existing process was not restarted or reconfigured.

The repeatable live transport test is opt-in:

```powershell
$env:NAWA_LLAMA_TEST_URL = 'http://127.0.0.1:8082/v1'
$env:NAWA_LLAMA_TEST_MODEL = 'Agent-A1-4B'
npm exec --workspace @genoffice/ai-provider -- vitest run tests/local-llama.integration.test.ts
```

## Implementation references

- [Local endpoint detection](../packages/ai-provider/src/local-endpoint.ts)
- [Provider request shaping](../packages/ai-provider/src/registry.ts)
- [Output limits](../packages/ai-provider/src/providers.ts)
- [OpenAI-compatible streaming and tool messages](../packages/ai-provider/src/protocols/openai-compatible.ts)
- [Directory chat history policy](../apps/shell/src/renderer/src/WorkspaceChat.tsx)

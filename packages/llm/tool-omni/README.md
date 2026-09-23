# @deepseek-ai/dsh-tool-omni

English | [中文](README.zh.md)

The model-facing `omni_image`, `omni_audio`, and `omni_video` tools that understand media files on the host through a LOCAL Ollama multimodal model. This package owns the model-facing schemas, prompt guidance, media preprocessing, and the Ollama HTTP calls; it never talks to a cloud provider. Each tool reads its media bytes from the host, base64-encodes them, and posts them to one Ollama chat request, then returns the model's text as the canonical string output. Image bytes ride the `images` field of the native `/api/chat` endpoint; audio bytes ride an `input_audio` content block of the OpenAI-compatible `/v1/chat/completions` endpoint, because the native endpoint silently drops `audios` on audio-capable models (Ollama issue #17730). `omni_video` samples evenly-spaced frames first and finishes with a plain-text Ollama call that synthesizes one cohesive summary from the per-frame descriptions.

All subprocess work uses async, promisified `spawn` — never a blocking `execSync`/`execFileSync` — and every tool honors `exec.signal`: an abort kills in-flight ffmpeg/ffprobe children and aborts the in-flight fetch. The model and base URL come from config with launch-environment fallbacks: `OLLAMA_URL` and `OMNI_MODEL` (resolved through `launchEnvironmentOf` from `@deepseek-ai/dsh-launch-environment`) override the configured `ollamaUrl` and `model`, which default to `http://localhost:11434` and `nemotron3:33b`. A per-call `model` argument overrides both for that one call.

Each tool is registered independently; a product that wants only some disables the others via config (`{ image: false }` / `{ audio: false }` / `{ video: false }`). Tool descriptions are strong must-call guidance so the model routes uploaded or referenced media to them instead of guessing at content.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `omni_image` | `path` (required string), `prompt` (string), `model` (string) | Reads a local image file (PNG/JPEG/WebP/GIF), base64s it, and asks the local vision model to describe or answer about it. Returns the model's text. |
| `omni_audio` | `path` (required string), `prompt` (string), `model` (string) | Converts the audio file to 16kHz mono WAV with `ffmpeg` in a private temp dir, base64s it, and sends it through the OpenAI-compatible audio input (`/v1/chat/completions`). Requires `ffmpeg` on PATH. |
| `omni_video` | `path` (required string), `prompt` (string), `frames` (integer, default 8), `model` (string) | Probes duration with `ffprobe`, samples `frames` evenly-spaced downscaled JPEGs with `ffmpeg`, describes each with the vision model, then makes one plain-text Ollama call that synthesizes one cohesive summary. Requires `ffmpeg` and `ffprobe` on PATH. |

All three tools are read-only with respect to parent-agent state: they sample the file system and a local server and never mutate the agent, so they opt into concurrent sibling scheduling. The tool-call timeout budget is deployment policy; each tool's calls carry the configured `httpTimeoutMs`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `ollamaUrl` | `http://localhost:11434` | Ollama base URL. The `OLLAMA_URL` launch-environment entry overrides it. |
| `model` | `nemotron3:33b` | Ollama multimodal model. The `OMNI_MODEL` launch-environment entry overrides it. |
| `httpTimeoutMs` | `270000` | Per-call HTTP timeout (ms) for every Ollama request, per frame and per summary. |
| `image` | `true` | Register `omni_image`. |
| `audio` | `true` | Register `omni_audio`. |
| `video` | `true` | Register `omni_video`. |
| `whisperPython` | – | Absolute path of the faster-whisper venv python (e.g. `~/.dsh/whisper/.venv/bin/python`). When set, `omni_audio` transcribes through the local faster-whisper project instead of the Ollama audio path. |
| `whisperDir` | `~/.dsh/whisper` | Directory holding the whisper project's `transcribe.py`. |
| `whisperModel` | `large-v3` | faster-whisper model id used by `omni_audio`. |
| `whisperLanguage` | – | Optional source-language code (e.g. `ja`, `zh`); omitted = auto-detect. |

`httpTimeoutMs` must be a positive integer, and `ollamaUrl`/`model` must be non-empty; misconfiguration fails loud at plugin load. The deployment endpoint, model, and timeout are deployment settings, not model arguments — the model-facing schemas expose only `path`, `prompt`, `frames`, and an optional per-call `model` override. `whisperPython` is also a deployment setting: setting it switches `omni_audio`'s backend to the local faster-whisper transcription project (accurate verbatim transcription), and its schema is unchanged.

```yaml
- id: tool-omni
  name: '@deepseek-ai/dsh-tool-omni'
  config:
    model: nemotron3:33b
    video: true
    whisperPython: /home/you/.dsh/whisper/.venv/bin/python
```

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`omni_image`, `omni_audio`, and `omni_video` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-omni). Each tool's description is strong must-call guidance for uploaded or referenced media on the host; `omni_video` documents the `frames` default and its vision-call cost. The deployment endpoint and timeout never appear in the schemas.

#### Token effect

Fixed schema cost per request for each config-enabled tool. Config disablement removes a tool's schema entirely; a scoped restriction removes only the schema.

#### KV Cache effect

Prefix-stable while enabled tools, schema text, and the resolved model are unchanged. Config enablement, plugin lifecycle, or scoped restrictions may invalidate reuse from the first changed schema token.

### Image result

#### What the model sees

A successful `omni_image` call returns exactly the model's text for the prompt applied to the image bytes. The default prompt is `Describe this image in detail, including subjects, actions, text, and visual context.`; a call-supplied `prompt` replaces it, and a call-supplied `model` replaces the configured model for that call. The base64 image payload itself never enters the agent's model history — only the returned text does.

#### Token effect

Data-dependent model output is resent until compaction. The image bytes cost no agent tokens.

#### KV Cache effect

Append-only for the agent request prefix; the returned text follows the reusable prefix and does not invalidate existing entries. The Ollama-side image understanding is an independent model request on the local server, outside the agent prefix.

### Audio result

#### What the model sees

`omni_audio` converts the file to 16kHz mono WAV with `ffmpeg` and returns text for it. With `whisperPython` configured, it spawns the local faster-whisper project's `transcribe.py` and returns the verbatim transcription (accurate speech transcription, uncensored by nature). Without it, it sends the WAV through the Ollama OpenAI-compatible `/v1/chat/completions` endpoint's `input_audio` block (the native `/api/chat` endpoint silently drops audio on audio-capable models). The default prompt is `Transcribe or describe the audio content in detail, including speech, speakers, and non-speech sounds.` — with whisper enabled the transcription is returned as-is and the prompt is not applied to it.

#### Token effect

Only the returned text enters agent history; the WAV bytes cost no agent tokens.

#### KV Cache effect

Append-only for the agent request prefix; the local transcription (whisper process or Ollama request) is independent and does not touch agent-prefix cache entries.

### Video result

#### What the model sees

`omni_video` samples `frames` evenly-spaced JPEGs (default 8, each downscaled to at most 960px wide), describes each with the vision model using the per-frame prompt (`Describe this video frame in detail, including subjects, actions, text, scene, and motion cues.` by default), then makes one plain-text Ollama call that synthesizes the per-frame descriptions into one cohesive summary. The model sees only that final summary text; the per-frame descriptions and frame bytes stay inside the tool call.

#### Token effect

Only the final summary enters agent history. Each sampled frame costs one independent Ollama vision request, and the summary costs one more, so a call's local-server load grows with `frames`.

#### KV Cache effect

Append-only for the agent request prefix. The video produces `frames + 1` independent Ollama requests whose cache behavior belongs to the local server.

### Tool errors

#### What the model sees

HTTP failures, the Ollama in-band `error` field, empty model content, unreadable or missing media files, failed or cancelled ffmpeg/ffprobe commands, and request timeouts surface as `Error: <message>` tool results with the failing cause in the message. Caller cancellation is reported by the registry as `Error: tool call aborted`.

#### Token effect

Only the retained error result adds tokens; discarded partial results do not enter model history.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing entries.

### Argument errors

#### What the model sees

Schema validation rejects an absent or non-string `path` and non-string `prompt`/`model`/`frames` before execution, and the registry reports `Error: invalid arguments: ...`.

#### Token effect

Only the failing call adds these retained tokens.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

- **Audio and video require host `ffmpeg`/`ffprobe`** — the tools fail with a clear error when the binaries are missing from PATH, and there is no fallback transcoder or in-process decoder. Deployments must provision the binaries; the package does not bundle or install them.
- **The whisper backend needs a separately provisioned uv project** — when `whisperPython` is set, the deployment must have installed faster-whisper (e.g. `~/.dsh/whisper` via `uv`) and have network or cached access to the model on first use; the package does not install or download it. On failure the tool reports the child process error.
- **Audio rides the OpenAI-compatible endpoint without whisper** — the native `/api/chat` endpoint silently drops `audios` on audio-capable models (Ollama issue #17730), so `omni_audio` posts through `/v1/chat/completions` with an `input_audio` block. Whether the configured model can actually understand audio is a model capability, not something this package can detect or guarantee; the endpoint split is invisible to the model and to callers.
- **`omni_video` summarizes a bounded sample, not the whole clip** — at most `frames` stills (default 8) downscaled to 960px wide. Fast motion, quick cuts, small text, and very long clips can be missed; there is no audio track, motion, or temporal-difference analysis.
- **A single local Ollama endpoint** — all three tools target the one resolved `OLLAMA_URL`; there is no retry across endpoints, no queue awareness, and no fallback when the server is busy or unloaded, beyond the per-call `httpTimeoutMs` error.
- **Host-path access only** — the tools read paths on the host directly; media held in the attachment seam must be materialized to a host path before an omni tool can read it.

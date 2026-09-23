# @deepseek-ai/dsh-tool-omni

[English](README.md) | 中文

模型侧 `omni_image`、`omni_audio` 与 `omni_video` 工具，通过本地 Ollama 多模态模型理解主机上的媒体文件。本包拥有模型侧 schema、prompt 引导、媒体预处理与 Ollama HTTP 调用；它绝不与云端 provider 通信。每个工具从主机读取媒体字节、base64 编码，并在一次 Ollama chat 请求中发送，然后把模型的文本作为规范字符串输出返回。图像字节走原生 `/api/chat` 端点的 `images` 字段；音频在配置 `whisperPython` 时通过本地 faster-whisper 项目转写（准确的逐字转写），否则走 OpenAI 兼容 `/v1/chat/completions` 端点的 `input_audio` 内容块（原生端点在支持音频的模型上会静默丢弃 `audios`，Ollama issue #17730）。`omni_video` 先采样均匀分布的帧，最后用一次纯文本 Ollama 调用把逐帧描述综合成一个连贯摘要。

所有子进程工作都使用 async 的 promisified `spawn` —— 绝不使用阻塞的 `execSync`/`execFileSync` —— 并且每个工具都遵循 `exec.signal`：中止会杀死进行中的 ffmpeg/ffprobe 子进程并中止进行中的 fetch。模型与 base URL 来自 config，带 launch-environment 回退：`OLLAMA_URL` 与 `OMNI_MODEL`（通过 `@deepseek-ai/dsh-launch-environment` 的 `launchEnvironmentOf` 解析）覆盖已配置的 `ollamaUrl` 与 `model`，后者默认 `http://localhost:11434` 与 `nemotron3:33b`。每次调用可选的 `model` 参数只为该次调用覆盖两者。

每个工具独立注册；只想用其中一部分的产品通过 config 禁用其余工具（`{ image: false }` / `{ audio: false }` / `{ video: false }`）。工具描述是强 must-call 引导，让模型把上传或引用的媒体路由到这些工具，而不是猜测内容。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `omni_image` | `path`（必填 string）、`prompt`（string）、`model`（string） | 读取本地图像文件（PNG/JPEG/WebP/GIF），base64 编码，并请本地 vision model 描述或回答。返回模型的文本。 |
| `omni_audio` | `path`（必填 string）、`prompt`（string）、`model`（string） | 用 `ffmpeg` 在私有临时目录把音频文件转成 16kHz 单声道 WAV，base64 编码，并通过 OpenAI 兼容音频输入（`/v1/chat/completions`）发送。需要 PATH 上有 `ffmpeg`。 |
| `omni_video` | `path`（必填 string）、`prompt`（string）、`frames`（integer，默认 8）、`model`（string） | 用 `ffprobe` 探测时长，用 `ffmpeg` 采样 `frames` 张均匀分布、降采样到至多 960px 宽的 JPEG，用 vision model 逐张描述，再做一次纯文本 Ollama 调用综合成一个连贯摘要。需要 PATH 上有 `ffmpeg` 与 `ffprobe`。 |

三个工具对 parent-agent 状态都是只读的：它们采样文件系统与本地 server，绝不改变 agent，因此它们选择并发兄弟调度。tool-call 超时预算是部署策略；每个工具的调用携带配置的 `httpTimeoutMs`。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `ollamaUrl` | `http://localhost:11434` | Ollama base URL。`OLLAMA_URL` launch-environment 条目覆盖它。 |
| `model` | `nemotron3:33b` | Ollama 多模态模型。`OMNI_MODEL` launch-environment 条目覆盖它。 |
| `httpTimeoutMs` | `270000` | 每次 Ollama 请求（每帧与每次摘要）的每调用 HTTP 超时（ms）。 |
| `image` | `true` | 注册 `omni_image`。 |
| `audio` | `true` | 注册 `omni_audio`。 |
| `video` | `true` | 注册 `omni_video`。 |
| `whisperPython` | – | faster-whisper venv python 的绝对路径（例如 `~/.dsh/whisper/.venv/bin/python`）。设置后 `omni_audio` 通过本地 faster-whisper 项目转写，而非 Ollama 音频路径。 |
| `whisperDir` | `~/.dsh/whisper` | 存放 whisper 项目 `transcribe.py` 的目录。 |
| `whisperModel` | `large-v3` | `omni_audio` 使用的 faster-whisper 模型 id。 |
| `whisperLanguage` | – | 可选的源语言代码（例如 `ja`、`zh`）；省略则自动检测。 |

`httpTimeoutMs` 必须是正整数，`ollamaUrl`/`model` 必须非空；配置错误会在插件加载时 loud fail。部署端点、模型与超时是部署设置，不是模型参数 —— 模型侧 schema 只暴露 `path`、`prompt`、`frames` 与可选的一次性 `model` 覆盖。`whisperPython` 也是部署设置：设置后 `omni_audio` 的后端切换为本地 faster-whisper 转写项目（准确的逐字转写），schema 不变。

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

模型会看到生成的 [`omni_image`、`omni_audio` 与 `omni_video` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-omni)。每个工具的描述都是针对主机上上传或引用媒体的强 must-call 引导；`omni_video` 说明了 `frames` 默认值及其 vision 调用成本。部署端点与超时绝不出现于 schema。

#### Token effect

每个 config 启用的工具每请求产生固定的 schema token 开销。config 禁用会整体移除工具的 schema；作用域限制只移除 schema。

#### KV Cache effect

启用的工具、schema 文本与解析后的模型不变时前缀稳定。config 启用、插件生命周期或作用域限制可能使从此 schema 起的缓存复用失效。

### Image result

#### What the model sees

一次成功的 `omni_image` 调用恰好返回模型针对应用于图像字节的 prompt 输出的文本。默认 prompt 是 `Describe this image in detail, including subjects, actions, text, and visual context.`；调用提供的 `prompt` 会替换它，调用提供的 `model` 会为该次调用替换配置的模型。base64 图像载荷本身从不进入 agent 的模型历史 —— 只有返回的文本进入。

#### Token effect

数据相关的模型输出在 compaction 前会被重发。图像字节不消耗 agent token。

#### KV Cache effect

对 agent 请求前缀是 append-only；返回的文本跟在可复用前缀之后，不会使既有条目失效。Ollama 侧的图像理解是本地 server 上的一次独立模型请求，在 agent 前缀之外。

### Audio result

#### What the model sees

`omni_audio` 用 `ffmpeg` 把文件转成 16kHz 单声道 WAV，并返回其文本。配置了 `whisperPython` 时，它启动本地 faster-whisper 项目的 `transcribe.py` 并返回逐字转写（准确的语音转写，天然无审查）。未配置时，它通过 OpenAI 兼容 `/v1/chat/completions` 端点的 `input_audio` 块把 WAV 发送给 Ollama（原生 `/api/chat` 端点在支持音频的模型上会静默丢弃音频）。默认 prompt 是 `Transcribe or describe the audio content in detail, including speech, speakers, and non-speech sounds.` —— 启用 whisper 时直接返回转写文本，prompt 不应用于它。

#### Token effect

只有返回的文本进入 agent 历史；WAV 字节不消耗 agent token。

#### KV Cache effect

对 agent 请求前缀是 append-only；本地转写（whisper 进程或 Ollama 请求）独立，不触及 agent 前缀缓存条目。

### Video result

#### What the model sees

`omni_video` 采样 `frames` 张均匀分布的 JPEG（默认 8，每张降采样到至多 960px 宽），用每帧 prompt（默认 `Describe this video frame in detail, including subjects, actions, text, scene, and motion cues.`）让 vision model 逐张描述，再做一次纯文本 Ollama 调用把逐帧描述综合成一个连贯摘要。模型只看到最终摘要文本；逐帧描述与帧字节留在工具调用内部。

#### Token effect

只有最终摘要进入 agent 历史。每张采样帧消耗一次独立的 Ollama vision 请求，摘要再消耗一次，因此一次调用的本地 server 负载随 `frames` 增长。

#### KV Cache effect

对 agent 请求前缀是 append-only。视频产生 `frames + 1` 次独立 Ollama 请求，其缓存行为属于本地 server。

### Tool errors

#### What the model sees

HTTP 失败、Ollama 带内 `error` 字段、空模型内容、不可读或缺失的媒体文件、失败或被取消的 ffmpeg/ffprobe 命令以及请求超时，都以 `Error: <message>` 工具结果呈现，消息中带有失败原因。调用方取消由 registry 报告为 `Error: tool call aborted`。

#### Token effect

只有保留的错误结果增加 token；被丢弃的部分结果不进入模型历史。

#### KV Cache effect

Append-only；错误跟在可复用请求前缀之后，不会使既有条目失效。

### Argument errors

#### What the model sees

Schema 校验会在执行前拒绝缺失或非 string 的 `path`，以及非 string 的 `prompt`/`model`/`frames`，registry 报告 `Error: invalid arguments: ...`。

#### Token effect

只有失败的调用增加这些保留 token。

#### KV Cache effect

Append-only；错误跟在可复用请求前缀之后，不会使既有条目失效。

## Known Limitations and Deferred Work

- **音频与视频需要主机 `ffmpeg`/`ffprobe`** —— PATH 上缺少二进制时工具会以清晰的错误失败，且没有备选转码器或进程内解码器。部署必须提供这些二进制；本包不捆绑也不安装它们。
- **whisper 后端需要单独部署的 uv 项目** —— 设置 `whisperPython` 时，部署必须已安装 faster-whisper（例如通过 `uv` 装到 `~/.dsh/whisper`），并且首次使用时有网络或缓存的模型可用；本包不安装也不下载。失败时工具报告子进程错误。
- **未配置 whisper 时音频走 OpenAI 兼容端点** —— 原生 `/api/chat` 端点在支持音频的模型上会静默丢弃 `audios`（Ollama issue #17730），因此 `omni_audio` 通过带 `input_audio` 块的 `/v1/chat/completions` 发送。配置的模型能否真正理解音频是模型能力问题，不是本包能检测或保证的；端点拆分对模型与调用方都不可见。
- **`omni_video` 总结的是有界采样，不是整段视频** —— 至多 `frames` 张静帧（默认 8），降采样到 960px 宽。快速运动、快速切换、小文字与很长的片段可能被漏掉；没有音轨、运动或时间差分分析。
- **单一本地 Ollama 端点** —— 三个工具都指向解析出的同一个 `OLLAMA_URL`；没有跨端点重试、没有队列感知，也没有 server 忙或卸载时的回退，只有每次调用的 `httpTimeoutMs` 错误。
- **仅主机路径访问** —— 工具直接读取主机上的路径；attachment seam 中的媒体必须先物化到主机路径，omni 工具才能读取。

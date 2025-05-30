# Medusa-Bridge

This software enables you to join multiple local LLM API servers to the [KoboldAI Horde](https://github.com/db0/AI-Horde) as a Scribe worker performing distributed text generation.  Obtain an [API Key here](https://stablehorde.net/register) to accumulate kudos, the virtual currency of the Horde whicah can be used for multiple tasks such as image generation and interrogation.

It is the sucessor to [LlamaCpp-Horde-Bridge](https://github.com/the-crypt-keeper/LlamaCpp-Horde-Bridge), rewritten in NodeJS. If upgrading, note that the names of some configuration arguments have changed.

# Features

* Multi-threaded processing: generate multiple jobs in parallel when the backend supports it
* Asyncronous job submission: pop a new job as soon as the previous one has finished generating, submit in the background
* Context-length enforcement: incoming requests with prompts larger then context size are automatically shrunk to fit

Supported inference REST API servers:

* [llama.cpp](https://github.com/ggerganov/llama.cpp) server
* [koboldcpp](https://github.com/LostRuins/koboldcpp)
  * While [native support exists in KoboldCpp](https://github.com/LostRuins/koboldcpp/wiki#what-is-horde-how-do-i-use-it-how-do-i-share-my-model-with-horde) exists, it does not support the throughput-enhancing features of this bridge.
* [vllm](https://github.com/vllm-project/vllm)
* [sglang](https://github.com/sgl-project/sglang) backend
* [tabbyAPI](https://github.com/theroyallab/tabbyAPI)
  * Supported both natively and via [KoboldAI-compatible endpoint](https://github.com/theroyallab/tabbyAPI/wiki/07.-AI-Horde)
  * While native Horde support exists, it does not support the throughput-enhancing features of this bridge.
* [aphrodite](https://github.com/aphrodite-engine/aphrodite-engine) 
  * Supported via the [KoboldAI-compatible endpoint](https://github.com/aphrodite-engine/aphrodite-engine/wiki/2.-Usage#koboldai)

See below for example configurations for each engine.

# Installation

Medusa-Bridge requires NodeJS v22, installation via [nvm](https://github.com/nvm-sh/nvm) is recommended.

Execute `npm ci` to install dependencies

# Configuration

Run `node index.js` to see the default configuration:

```
┌───────────────────┬────────────────────────────────┐
│      (index)      │             Values             │
├───────────────────┼────────────────────────────────┤
│    clusterUrl     │   'https://stablehorde.net'    │
│    workerName     │ 'Automated Instance #73671757' │
│      apiKey       │          '0000000000'          │
│ priorityUsernames │                                │
│     serverUrl     │    'http://localhost:8000'     │
│   serverEngine    │              null              │
│       model       │              null              │
│        ctx        │              null              │
│     maxLength     │             '512'              │
│      threads      │              '1'               │
└───────────────────┴────────────────────────────────┘
```

Run `node index.js --help` to see command line equivillents and descriptions for each option:

```
Usage: index [options]

Options:
  -f, --config-file <file>              Load config from .json file
  -c, --cluster-url <url>               Set the Horde cluster URL (default: "https://stablehorde.net")
  -w, --worker-name <name>              Set the Horde worker name (default: "Automated Instance #37508138")
  -a, --api-key <key>                   Set the Horde API key (default: "0000000000")
  -p, --priority-usernames <usernames>  Set priority usernames, comma-separated (default: [])
  -s, --server-url <url>                Set the REST Server URL (default: "http://localhost:8000")
  -e, --server-engine <engine>          Set the REST Server API type (default: null)
  -sm, --server-model <server-model>    Set the model requested from API server (default: null)
  -m, --model <model>                   Set the model name offered to Horde (default: null)
  -x, --ctx <ctx>                       Set the context length (default: null)
  -l, --max-length <length>             Set the max generation length (default: "512")
  -t, --threads <threads>               Number of parallel threads (default: "1")
  --timeout <timeout>                   How long to wait for generation to complete (sec) (default: "60")
  -h, --help                            display help for command
```

The `-f` / `--config-file` option allows you to group configuration into a named json file, while still allowing command-line overrides.

# Server Engine Sample

## llama.cpp server

### Why llama.cpp and not koboldcpp?

See [this reddit post](https://www.reddit.com/r/LocalLLaMA/comments/18helbs/how_to_run_mixtral_8x7b_gguf_on_tesla_p40_without/), using this trick older Pascal GPUs (GTX 10x0, P40, K80) are almost twice as fast, particulary at long contexts.

Compile [llama.cpp](https://github.com/ggerganov/llama.cpp) with `make LLAMA_CUBLAS=1 LLAMA_CUDA_FORCE_MMQ=1` to get a Pascal-optimized `server` binary.

### Example usage

Example server command: `./server ~/models/openhermes-2.5-mistral-7b.Q5_0.gguf -ngl 99 -c 4096`

Example configuration file:

```
{
    "apiKey": "<your api key>",
    "workerName": "<your worker name>",
    "serverEngine": "llamacpp",
    "serverUrl": "http://localhost:8000",
    "model": "llamacpp/openhermes-2.5-mistral-7b.Q5_0",
    "ctx": 4096
}
```

## koboldcpp

Example server command: `./koboldcpp-linux-x64 ~/models/openhermes-2.5-mistral-7b.Q5_0.gguf --usecublas 0 mmq --gpulayers 99 --context-size 4096 --quiet`

Example configuration file:

```
{
    "apiKey": "<your api key>",
    "workerName": "<your worker name>",
    "serverEngine": "koboldcpp",
    "serverUrl": "http://localhost:5001",
    "model": "koboldcpp/openhermes-2.5-mistral-7b.Q5_0",
    "ctx": 4096
}
```

## tabbyAPI

TODO

## vllm

TODO

## sglang

TODO

## aphrodite

python3 -m aphrodite.endpoints.kobold.api_server --model TheBloke/OpenHermes-2.5-Mistral-7B-GPTQ --max-length 512 --max-model-len 8192
# @mariozechner/pi-viking-memory

A [pi-mono](https://github.com/badlogic/pi-mono) extension that gives the coding agent persistent long-term memory via [OpenViking](https://github.com/volcengine/openviking).

Memory persists **across sessions**. The agent can recall preferences, past decisions, and project context from any previous conversation.

## How it works

OpenViking is exposed as **four LLM-callable tools** — the agent decides when to use them. Two passive hooks handle transparent background sync.

```
Pi-mono Agent
     │
     ├── Active tools (LLM decides when to call)
     │     ├── recall_memory(query, scope?)  → semantic search over past sessions
     │     ├── save_memory(content)          → explicitly persist a note
     │     ├── explore_memory(uri)           → browse the memory filesystem
     │     └── add_knowledge(path)           → index a local file/directory
     │
     └── Passive hooks (transparent, no LLM involvement)
           ├── before_agent_start  → create OV session, inject memory prompt
           ├── session_compact     → sync messages + commit (extract memories)
           └── session_shutdown    → sync messages + commit (extract memories)
                                           │
                                   OpenViking HTTP API (localhost:1933)
                                   Independent Python process
```

**Three-layer memory model:**

| Layer | Who decides | When |
|-------|-------------|------|
| Message sync | Automatic hook | On compact / shutdown — conversation appended to OV session |
| Memory extraction | OV internal LLM pipeline | On commit — extracts preferences, entities, cases from conversation |
| Explicit recall/save | Agent LLM | When `recall_memory` / `save_memory` tools are called |

## Setup

### 1. Install and start OpenViking

OpenViking must be built from source. Requires **Go** and **CMake** (e.g. `brew install go cmake` on macOS).

```bash
git clone https://github.com/volcengine/openviking
cd openviking

uv venv .venv
uv pip install setuptools pybind11 cmake
uv pip install -e "."
```

The build step compiles an AGFS server binary (Go) and a C++ vector index extension (CMake). Both are built automatically by `pip install`.

Create a config file at `~/.openviking/ov.conf`. Example using Gemini (fully tested):

```json
{
  "storage": {
    "vectordb": { "backend": "local", "path": "~/.openviking/data" },
    "agfs":     { "backend": "local", "path": "~/.openviking/data", "port": 1833 }
  },
  "embedding": {
    "dense": {
      "provider": "openai",
      "model": "models/gemini-embedding-001",
      "api_key": "<your-gemini-api-key>",
      "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "dimension": 3072
    }
  },
  "vlm": {
    "model": "gemini-2.0-flash",
    "provider": "gemini",
    "providers": {
      "gemini": { "api_key": "<your-gemini-api-key>" }
    }
  }
}
```

Start the server:

```bash
.venv/bin/openviking serve --config ~/.openviking/ov.conf &
```

### 2. Configure the extension

```bash
mkdir -p ~/.pi
cp packages/pi-viking-memory/config-templates/viking-memory.json ~/.pi/viking-memory.json
```

`~/.pi/viking-memory.json` defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `openviking.baseUrl` | `http://localhost:1933` | OpenViking server URL |
| `openviking.apiKey` | `null` | API key (if OV auth is enabled) |
| `openviking.timeout` | `10000` | HTTP timeout in ms |
| `behavior.autoSyncMessages` | `true` | Sync messages on session_compact |
| `behavior.autoCommitOnShutdown` | `true` | Commit on session_shutdown |
| `prompts.injectMemorySystemPrompt` | `true` | Append memory capabilities to system prompt |

### 3. Install the extension

The extension spans multiple files, so symlink the whole package directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn /path/to/pi-mono/packages/pi-viking-memory \
        ~/.pi/agent/extensions/viking-memory
```

pi's extension loader reads the `pi.extensions` field in `package.json` and loads `src/index.ts` via jiti (no compilation needed).

To verify the extension loaded, run:

```bash
pi --print "list all available tools"
# Should show: recall_memory, save_memory, explore_memory, add_knowledge
```

## Tools

### `recall_memory`

```
recall_memory(query: string, scope?: "preferences"|"entities"|"cases"|"all", limit?: number)
```

Semantically searches long-term memory. The agent should call this proactively when historical context may be relevant.

Scopes map to Viking URI prefixes:

| scope | searches in |
|-------|-------------|
| `preferences` | `viking://user/memories/preferences/` |
| `entities` | `viking://user/memories/entities/` |
| `cases` | `viking://user/memories/cases/` |
| `all` (default) | `viking://user/memories/` |

### `save_memory`

```
save_memory(content: string)
```

Appends a note to the current OV session as an assistant message. On session commit, OV's LLM pipeline extracts it into the appropriate memory category.

### `explore_memory`

```
explore_memory(uri: string)
```

Lists a Viking URI directory. Start with `viking://user/memories/` to see all memory categories.

### `add_knowledge`

```
add_knowledge(path: string, reason?: string, instruction?: string)
```

Indexes a local file or directory into OV's knowledge base for future semantic search. Useful for project docs, README files, API specs, etc.

## Verification

```
# Session 1
> I prefer 4-space indentation and TypeScript strict mode.
  Please save this to memory.
→ Agent calls save_memory(...)
→ Close pi  (triggers session_shutdown → commit → memory extracted)

# Session 2 (fresh process, no context)
> recall_memory("code style preferences")
→ Returns: "4-space indentation, TypeScript strict mode"
```

## Graceful degradation

If OpenViking is not running, **pi-mono is completely unaffected**:

- `health()` fails → `before_agent_start` silently skips session creation and prompt injection
- Tool calls fail → return a descriptive error string, no exceptions thrown
- Lifecycle hooks → all errors are swallowed silently

## Development

```bash
# From pi-mono root
npm install

# Run tests
npm test --workspace packages/pi-viking-memory

# Lint + type check (monorepo-wide)
npm run check
```

Tests use vitest with mocked fetch. 42 tests covering OVClient, SessionManager, and all four tools.

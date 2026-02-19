# pi-viking-memory

A [pi-mono](https://github.com/badlogic/pi-mono) extension that gives the coding agent persistent long-term memory via [OpenViking](https://github.com/OpenViking).

## Architecture

```
Pi-mono Agent
     │
     ├── Active tools (LLM decides when to call)
     │     ├── recall_memory(query, scope?)  → POST /api/v1/search/find
     │     ├── save_memory(content)          → POST /api/v1/sessions/{id}/messages
     │     ├── explore_memory(uri)           → GET  /api/v1/fs/ls
     │     └── add_knowledge(path)           → POST /api/v1/resources
     │
     └── Passive hooks (transparent, automatic)
           ├── before_agent_start  → ensureSession + inject system prompt
           ├── session_compact     → syncMessages + commitSession
           └── session_shutdown    → syncMessages + commitSession
                                          │
                               OpenViking HTTP API (localhost:1933)
                               Independent process, always running
```

## Setup

### 1. Start OpenViking

```bash
pip install openviking
mkdir -p ~/.openviking
cp config-templates/ov.conf ~/.openviking/ov.conf
# Edit ~/.openviking/ov.conf — add your API keys

openviking serve --config ~/.openviking/ov.conf &
```

### 2. Configure the extension

```bash
mkdir -p ~/.pi
cp config-templates/viking-memory.json ~/.pi/viking-memory.json
```

### 3. Install the extension

```bash
# Option A: point pi directly at the source (jiti handles TypeScript)
pi -e /path/to/pi-viking-memory/src/index.ts

# Option B: copy to the global extensions directory
cp src/index.ts ~/.pi/agent/extensions/viking-memory.ts
# and also copy the other source files next to it:
cp -r src/* ~/.pi/agent/extensions/viking-memory/
```

> **Note on Option B**: Because this extension spans multiple files, you need all
> files available. The easiest approach is to use `pi -e` with the full path.

## Tools

### `recall_memory`
```
recall_memory(query: string, scope?: "preferences"|"entities"|"cases"|"all", limit?: number)
```
Searches long-term memory semantically. Use proactively when prior context may be relevant.

### `save_memory`
```
save_memory(content: string)
```
Explicitly saves a note to memory. Gets extracted by OV's memory pipeline on session commit.

### `explore_memory`
```
explore_memory(uri: string)
```
Lists a Viking URI directory. Start with `viking://user/memories/`.

### `add_knowledge`
```
add_knowledge(path: string, reason?: string, instruction?: string)
```
Indexes a local file or directory for semantic search.

## Verification

1. **Session 1**: Tell the agent "I prefer 4-space indentation". Close pi (triggers commit).
2. **Session 2**: Run `recall_memory("code style preferences")` → should find the preference.

## Configuration

`~/.pi/viking-memory.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `openviking.baseUrl` | `http://localhost:1933` | OpenViking server URL |
| `openviking.apiKey` | `null` | API key (if OV is configured with auth) |
| `openviking.timeout` | `10000` | HTTP timeout in ms |
| `behavior.autoSyncMessages` | `true` | Sync messages on session_compact |
| `behavior.autoCommitOnShutdown` | `true` | Commit on session_shutdown |
| `prompts.injectMemorySystemPrompt` | `true` | Append memory capabilities to system prompt |

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:coverage  # requires >=80% coverage
```

# LocalDrop Agent Orchestration

> Skill for AI agents to operate LocalDrop — share files, send messages, and run commands on remote machines over a local network.

## What is LocalDrop?

LocalDrop is a room-based local network sharing tool. Devices join password-protected rooms and can share files, text messages, and execute shell commands on connected listener machines. Everything stays on the local network — no internet, no cloud.

## Prerequisites

Before using the API, you need:

- **Host URL**: The LocalDrop server address (e.g. `http://<ip>:7431`)
- **Room ID**: The room to operate in
- **Room password**: The room's password
- **Cookie jar**: All API calls after joining require the session cookie

## Step 1: Join a Room

```bash
curl -c cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/join \
  -H "Content-Type: application/json" \
  -d '{"password":"<room-password>","nickname":"agent"}'
```

All subsequent requests must include `-b cookies.txt` for authentication.

## Step 2: Send a Text Message

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/messages/text \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from the agent"}'
```

## Step 3: Upload a File

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/messages/file \
  -F "file=@/path/to/file.txt"
```

## Step 4: Run a Command on a Listener

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/system/command \
  -H "Content-Type: application/json" \
  -d '{"run":"<command>","target":"<listener-name>"}'
```

### Check Command Results

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/system
```

Results include `status` (pending / running / done / error), `stdout`, `stderr`, and `exitCode`.

### List Connected Listeners

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/system/listeners
```

## Step 5: Sync a Project Directory

If the host was started with `--sync <path>`, listeners receive the project files before command execution. Use this to build, test, or lint on remote machines with the latest code.

```bash
curl -b cookies.txt \
  http://<host>:7431/api/rooms/<room-id>/system/command \
  -H "Content-Type: application/json" \
  -d '{"run":"npm test","target":"<listener-name>","sync":true}'
```

## Security Model

### Sandbox is ON by Default

Every listener runs in a **sandbox** unless explicitly started with `--full-access`. The sandbox has three layers:

#### 1. Blocklist
Dangerous patterns are blocked before execution:
- Destructive commands: `rm -rf /`, `mkfs`, `format`, `:(){:|:&};:`
- Remote code execution: `curl|bash`, `wget|sh`, pipe-to-shell patterns
- Credential access: `.ssh/`, `.gnupg/`, `.aws/`, `.npmrc`
- System modification: `crontab`, `shutdown`, `reboot`
- Network listeners: `nc -l`, `python -m http.server`

#### 2. Jail Detection
Commands are checked for attempts to escape the sandbox directory:
- Home directory references: `~/`, `$HOME`
- Directory traversal: `../`
- System paths: `/etc/`, `/var/`, `/Users/`, `/home/`
- Absolute paths outside the jail (except `/bin`, `/usr`, `/sbin`, `/dev/null`)

#### 3. Restricted Environment
- `HOME` is set to the jail directory
- `PATH` is limited to system binaries only
- The real home directory is inaccessible

### When to Use `--full-access`

Only use `--full-access` when the command **genuinely requires** access outside the sandbox:
- Installing system packages (`brew install`, `apt install`)
- Accessing project files in their real location
- Running Docker or other tools that need full system access
- Trusted environments where the agent is the sole operator

**Never default to `--full-access`.** Start with sandbox mode and escalate only if a command fails due to sandbox restrictions.

### Interactive Allowlist

When a listener receives a command not in its allowlist, the operator is prompted:
```
Command received: npm install
Not in allowlist. Allow?
  [d]eny  [o]nce  [a]lways
```

Choosing **always** persists the command to `~/.localdrop/listener.json`.

### Agent Best Practices

1. **Always check listener status** before sending commands — verify the target is connected.
2. **Use specific commands** — `ls src/` is better than `ls` with no path, because sandbox restricts directory access.
3. **Check command results** — poll the system endpoint for `status: "done"` before sending the next command.
4. **Do not chain destructive commands** — the blocklist catches most, but avoid `rm`, `mv /`, or `chmod 777` patterns.
5. **Prefer sandbox mode** — only request `--full-access` listeners when a task is impossible without it, and document why.
6. **Respect the allowlist** — if a command is denied, do not retry it. Inform the user or try an alternative.
7. **One command at a time** — wait for each command to complete before sending the next.

## Listener Configuration

Listeners persist settings in `~/.localdrop/listener.json`:

```json
{
  "allowlist": ["ls", "pwd", "npm test", "npm run build"],
  "sandbox": true,
  "timeout": 300
}
```

- `allowlist`: Commands that run without prompting
- `sandbox`: Whether to jail commands (default: `true`)
- `timeout`: Max seconds per command (default: `300`)

## Starting a Listener

```bash
localdrop listen \
  --host http://<host-ip>:7431 \
  --room <room-id> \
  --password <room-password> \
  --name <machine-name>
```

Optional flags:
- `--allow <cmd,...>` — Pre-approve specific commands
- `--timeout <seconds>` — Override command timeout
- `--full-access` — Disable sandbox (use with caution)

## Starting a Host

```bash
localdrop [--port 7431] [--sync ./project-dir]
```

The server prints a URL and QR code. Any device on the network can join.

## Error Handling

| Status | Meaning |
|--------|---------|
| `unauthorized` | Session cookie missing or expired — rejoin the room |
| `denied` | Command blocked by blocklist, jail detection, or operator denial |
| `error` | Command ran but exited with non-zero code — check `stderr` |
| `timeout` | Command exceeded the timeout limit |

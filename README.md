# Web Terminal with tmux Support

A production-ready web terminal that runs tmux inside a real PTY, enabling Claude Code and other complex TTY applications to work correctly in the browser.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Architecture

```
Browser (xterm.js)  ←──WebSocket (binary)──→  Server  ←──PTY──→  tmux  →  bash/apps
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **xterm.js** | Terminal emulation: ANSI parsing, cursor control, alternate screen buffer, raw mode |
| **WebSocket** | Binary byte relay (no interpretation) |
| **Server** | PTY lifecycle management, session routing |
| **PTY (node-pty)** | Pseudo-terminal device providing stdin/stdout/signals |
| **tmux** | Session persistence, survives disconnects |

### Session Lifecycle

```
1. Browser connects via WebSocket
2. Browser sends init message: { userId, cols, rows }
3. Server checks: does tmux session for userId exist?
   ├── YES: spawn PTY running "tmux attach -t <userId>"
   └── NO:  spawn PTY running "tmux new-session -s <userId>"
4. PTY stdout → WebSocket binary frame → xterm.js
5. xterm.js keystrokes → WebSocket binary frame → PTY stdin
6. On disconnect:
   ├── PTY is killed (was just running "tmux attach")
   └── tmux session continues running
7. On reconnect: new PTY attaches to existing tmux session
```

**Key insight**: The PTY is ephemeral; tmux is persistent. Killing the PTY just detaches from tmux.

## Claude Code Compatibility

Claude Code is a highly interactive TTY application that requires:

| Feature | Why It Works |
|---------|--------------|
| **Raw mode** | node-pty provides a real PTY with full raw mode support. No line buffering. |
| **Alternate screen buffer** | xterm.js implements the ANSI alternate screen buffer (smcup/rmcup). Server doesn't interpret. |
| **Cursor control** | All cursor movement escape sequences pass through as raw bytes. |
| **256 colors / True color** | TERM=xterm-256color, COLORTERM=truecolor. xterm.js renders all colors. |
| **Mouse input** | xterm.js sends mouse escape sequences. PTY receives them verbatim. |
| **Resize (SIGWINCH)** | Browser sends resize → server calls pty.resize() → tmux gets SIGWINCH. |
| **Unicode** | UTF-8 throughout. Binary WebSocket frames preserve all bytes. |

**Why this works**: The server is a **dumb byte relay**. It never parses, interprets, or modifies terminal output. All intelligence is in xterm.js (browser) and the application (Claude Code inside tmux).

## Protocol

### WebSocket Messages

**Browser → Server:**

| Type | Format | Description |
|------|--------|-------------|
| Init | JSON: `{ type: "init", userId, cols, rows }` | First message, required |
| Input | Binary | Raw terminal input (keystrokes) |
| Resize | JSON: `{ type: "resize", cols, rows }` | Terminal size change |
| Ping | JSON: `{ type: "ping" }` | Heartbeat |

**Server → Browser:**

| Type | Format | Description |
|------|--------|-------------|
| Init Ack | JSON: `{ type: "init_ack", sessionExists, ... }` | Session ready |
| Output | Binary | Raw terminal output |
| Pong | JSON: `{ type: "pong", timestamp }` | Heartbeat response |

### Why Binary Frames?

Text WebSocket frames apply UTF-8 encoding, which can corrupt binary terminal data (alternate character sets, raw 8-bit output). Binary frames transmit bytes verbatim.

## Reconnect Behavior

1. **Browser refresh**: WebSocket closes, PTY dies, tmux survives.
2. **New page load**: New WebSocket connects, new PTY attaches to existing tmux.
3. **tmux already has content**: User sees existing session state immediately.

```javascript
// Server creates PTY with:
const cmd = `tmux attach-session -t "${userId}" || tmux new-session -s "${userId}"`;
```

This single command handles both cases:
- Session exists → attach to it
- Session doesn't exist → create new one

## Security Considerations

### Input Validation

```javascript
// userId is sanitized to prevent command injection
const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
```

### Authentication Boundary

The server expects `userId` from the init message. In production:

```javascript
// Replace this with your auth system:
// 1. Validate JWT from cookie/header
// 2. Extract userId from validated token
// 3. Check authorization for terminal access
const userId = validateAndExtractUserId(req); // Your implementation
```

### Resource Limits

| Limit | Default | Purpose |
|-------|---------|---------|
| Max total sessions | 100 | Prevent resource exhaustion |
| Max sessions per user | 1 | One tmux session per user |
| Idle timeout | 30 min | Kill idle PTYs (tmux survives) |
| Max terminal size | 500x200 | Prevent memory abuse |
| Max message size | 1 MB | Prevent large payload attacks |

### Sandboxing (Production)

For production deployment, consider:

1. **Container isolation**: Run each PTY in a separate container
2. **User namespaces**: Map userId to unprivileged system users
3. **Resource limits**: cgroups for CPU/memory limits
4. **Network isolation**: Firewall rules for terminal processes
5. **Seccomp**: Restrict system calls available to spawned processes

## Operational Concerns

### Monitoring

```bash
# Health check
curl http://localhost:3000/health
# Response: {"status":"ok","activeSessions":2,"tmuxSessions":3}

# List sessions (admin)
curl http://localhost:3000/api/sessions
```

### tmux Session Cleanup

tmux sessions persist after disconnects. Clean up stale sessions:

```bash
# List all sessions
tmux list-sessions

# Kill specific session
tmux kill-session -t <userId>

# Kill all sessions
tmux kill-server
```

Consider implementing an idle detector that kills tmux sessions after extended inactivity (hours/days).

### Graceful Shutdown

The server handles SIGINT/SIGTERM:
1. Stops accepting new connections
2. Kills all PTYs (tmux sessions survive)
3. Closes WebSocket server
4. Exits cleanly

Users can reconnect to their tmux sessions when server restarts.

### Scaling

**Single server**: Good for ~100 concurrent sessions

**Multiple servers**: Requires sticky sessions (route user to same server) because:
- tmux sessions are local to each server
- Use Redis/etcd to track which server has which user's session
- Route reconnects to the correct server

### Logging

All significant events are logged:
```
[1] WebSocket connected from 10.0.0.5
[1] Initializing session for user "alice" (120x40)
[1] tmux session "alice" exists: false
[1] Resize to 150x50
[1] WebSocket closed (code=1000, reason=)
[1] Cleaning up session for "alice"
```

## Deployment

### systemd Service

```ini
# /etc/systemd/system/tmux-web.service
[Unit]
Description=Web Terminal Server
After=network.target

[Service]
Type=simple
User=tmuxweb
WorkingDirectory=/opt/tmux-web
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y tmux && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 3000
CMD ["node", "src/server.js"]
```

### Reverse Proxy (nginx)

```nginx
location /terminal {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400; # 24 hours for long-lived WebSocket
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP/WebSocket port |
| `HOST` | 0.0.0.0 | Bind address |
| `SHELL` | /bin/bash | Shell to use |
| `TMUX_SOCKET_DIR` | /tmp/tmux-web | tmux socket directory |

## Testing

```bash
# Start server
npm start

# Open browser
open http://localhost:3000

# In terminal:
# 1. Try basic commands: ls, pwd, echo $TERM
# 2. Test colors: echo -e '\033[31mRed\033[0m \033[32mGreen\033[0m'
# 3. Test cursor: vim, htop, or any TUI app
# 4. Refresh browser - session should persist
# 5. Run Claude Code and verify full functionality
```

## Troubleshooting

### "tmux: command not found"
Install tmux: `apt install tmux` or `brew install tmux`

### Terminal looks corrupted after reconnect
tmux may need to redraw. Press `Ctrl-L` or run `reset`.

### Colors not working
Verify `$TERM` is `xterm-256color`:
```bash
echo $TERM  # Should be xterm-256color
```

### Mouse not working
Enable mouse in tmux:
```bash
echo "set -g mouse on" >> ~/.tmux.conf
tmux source ~/.tmux.conf
```

## License

MIT

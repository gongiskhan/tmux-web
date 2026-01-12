/**
 * Web Terminal Server
 *
 * Architecture:
 * - WebSocket server accepts connections
 * - Each connection gets a PTY running an interactive shell
 * - Users can manage their own tmux sessions from within the terminal
 * - Binary WebSocket frames for terminal I/O
 * - JSON messages for control (resize)
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // PTY defaults
  defaultCols: 80,
  defaultRows: 24,
  defaultShell: process.env.SHELL || '/bin/bash',

  // Limits
  maxSessionsPerUser: 1,        // One PTY per user
  maxTotalSessions: 100,        // Max concurrent PTY connections
  idleTimeoutMs: 30 * 60 * 1000, // 30 minutes idle timeout for PTY
};

// =============================================================================
// Session Management
// =============================================================================

/**
 * Tracks active WebSocket connections.
 * Map<connectionId, SessionInfo>
 */
const activeSessions = new Map();

/**
 * Persistent PTY processes that survive WebSocket disconnects.
 * Map<userId, { pty, cols, rows, createdAt, lastActivity, dataBuffer }>
 */
const persistentPtys = new Map();

// How long to keep a PTY alive after disconnect (5 minutes)
const PTY_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let connectionIdCounter = 0;

/**
 * Check if a tmux session exists for the given user.
 */
function tmuxSessionExists(userId) {
  try {
    execSync(`tmux has-session -t "${userId}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all tmux sessions (for debugging/monitoring).
 */
function listTmuxSessions() {
  try {
    const output = execSync('tmux list-sessions 2>/dev/null', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill a tmux session (for admin cleanup).
 */
function killTmuxSession(userId) {
  try {
    execSync(`tmux kill-session -t "${userId}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// PTY Management
// =============================================================================

/**
 * Create a new PTY process.
 */
function createNewPty(cols, rows) {
  return pty.spawn(CONFIG.defaultShell, [], {
    name: 'xterm-256color',
    cols: cols || CONFIG.defaultCols,
    rows: rows || CONFIG.defaultRows,
    cwd: process.env.HOME || '/tmp',
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'tmux-web',
    },
  });
}

/**
 * Get or create a persistent PTY for a user.
 * Returns { pty, isNew, recentOutput }
 */
function getOrCreatePty(userId, cols, rows) {
  const existing = persistentPtys.get(userId);

  if (existing && existing.pty) {
    // Clear any idle timeout
    if (existing.idleTimeout) {
      clearTimeout(existing.idleTimeout);
      existing.idleTimeout = null;
    }

    // Resize if dimensions changed
    if (existing.cols !== cols || existing.rows !== rows) {
      existing.pty.resize(cols, rows);
      existing.cols = cols;
      existing.rows = rows;
    }

    existing.lastActivity = Date.now();

    console.log(`[PTY] Reattaching to existing PTY for "${userId}"`);
    return {
      pty: existing.pty,
      isNew: false,
      recentOutput: existing.recentOutput || ''
    };
  }

  // Create new PTY
  const ptyProcess = createNewPty(cols, rows);

  const ptyInfo = {
    pty: ptyProcess,
    cols,
    rows,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    recentOutput: '',
    idleTimeout: null,
    wsConnection: null,
  };

  // Buffer recent output for reconnects (last 10KB)
  ptyProcess.onData((data) => {
    ptyInfo.lastActivity = Date.now();
    ptyInfo.recentOutput += data;
    // Keep only last 10KB
    if (ptyInfo.recentOutput.length > 10240) {
      ptyInfo.recentOutput = ptyInfo.recentOutput.slice(-10240);
    }
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[PTY] PTY for "${userId}" exited (code=${exitCode}, signal=${signal})`);
    persistentPtys.delete(userId);
  });

  persistentPtys.set(userId, ptyInfo);

  console.log(`[PTY] Created new PTY for "${userId}"`);
  return { pty: ptyProcess, isNew: true, recentOutput: '' };
}

/**
 * Mark a PTY as disconnected and start idle timeout.
 */
function detachPty(userId) {
  const ptyInfo = persistentPtys.get(userId);
  if (!ptyInfo) return;

  ptyInfo.wsConnection = null;

  // Start idle timeout to eventually kill the PTY
  ptyInfo.idleTimeout = setTimeout(() => {
    console.log(`[PTY] Killing idle PTY for "${userId}" after timeout`);
    if (ptyInfo.pty) {
      try {
        ptyInfo.pty.kill();
      } catch (e) {
        // Ignore
      }
    }
    persistentPtys.delete(userId);
  }, PTY_IDLE_TIMEOUT_MS);

  console.log(`[PTY] Detached PTY for "${userId}", will timeout in ${PTY_IDLE_TIMEOUT_MS / 1000}s`);
}

// =============================================================================
// WebSocket Handler
// =============================================================================

/**
 * Handle a new WebSocket connection.
 *
 * Protocol:
 * - First message MUST be JSON: { type: "init", userId: "...", cols: N, rows: N }
 * - After init, binary frames = stdin to PTY
 * - Server sends binary frames = stdout from PTY
 * - Resize: JSON { type: "resize", cols: N, rows: N }
 */
function handleWebSocket(ws, req) {
  const connectionId = ++connectionIdCounter;
  let session = null;
  let initialized = false;
  let idleTimer = null;

  console.log(`[${connectionId}] WebSocket connected from ${req.socket.remoteAddress}`);

  // Reset idle timer on activity
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[${connectionId}] Idle timeout, closing connection`);
      ws.close(4000, 'Idle timeout');
    }, CONFIG.idleTimeoutMs);
  }

  // Handle incoming messages
  ws.on('message', (data, isBinary) => {
    resetIdleTimer();

    // Before initialization, expect JSON init message
    if (!initialized) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          initializeSession(msg);
        } else {
          ws.close(4001, 'Expected init message');
        }
      } catch (e) {
        console.error(`[${connectionId}] Invalid init message:`, e.message);
        ws.close(4001, 'Invalid init message');
      }
      return;
    }

    // After initialization
    if (isBinary) {
      // Binary frame = stdin to PTY
      if (session?.pty) {
        session.pty.write(data);
      }
    } else {
      // Text frame = control message (resize)
      try {
        const msg = JSON.parse(data.toString());
        handleControlMessage(msg);
      } catch (e) {
        console.error(`[${connectionId}] Invalid control message:`, e.message);
      }
    }
  });

  // Initialize session with PTY
  function initializeSession(msg) {
    const { userId, cols, rows } = msg;

    if (!userId || typeof userId !== 'string') {
      ws.close(4002, 'Missing userId');
      return;
    }

    // Check session limits
    if (activeSessions.size >= CONFIG.maxTotalSessions) {
      ws.close(4003, 'Server at capacity');
      return;
    }

    // Validate dimensions
    const safeCols = Math.min(Math.max(parseInt(cols, 10) || CONFIG.defaultCols, 10), 500);
    const safeRows = Math.min(Math.max(parseInt(rows, 10) || CONFIG.defaultRows, 5), 200);

    console.log(`[${connectionId}] Initializing session for user "${userId}" (${safeCols}x${safeRows})`);

    // Get or create persistent PTY
    const { pty: ptyProcess, isNew, recentOutput } = getOrCreatePty(userId, safeCols, safeRows);
    const ptyInfo = persistentPtys.get(userId);

    session = {
      connectionId,
      userId,
      pty: ptyProcess,
      cols: safeCols,
      rows: safeRows,
      createdAt: Date.now(),
    };

    activeSessions.set(connectionId, session);
    initialized = true;

    // Store reference to WebSocket in PTY info
    if (ptyInfo) {
      ptyInfo.wsConnection = ws;
    }

    // Set up data forwarding from PTY to this WebSocket
    const dataHandler = (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(data), { binary: true });
      }
    };

    // For new PTYs, onData is already set up in getOrCreatePty
    // We need to add our WebSocket forwarding
    if (isNew) {
      ptyProcess.onData(dataHandler);
    } else {
      // For existing PTYs, we need to set up forwarding
      // The onData in getOrCreatePty buffers output; we add another listener
      ptyProcess.onData(dataHandler);

      // Send recent output to restore terminal state
      if (recentOutput) {
        console.log(`[${connectionId}] Sending ${recentOutput.length} bytes of recent output`);
        ws.send(Buffer.from(recentOutput), { binary: true });
      }
    }

    // PTY exit handler - close WebSocket when PTY dies
    if (isNew) {
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[${connectionId}] PTY exited (code=${exitCode}, signal=${signal})`);
        cleanup(false); // Don't detach, PTY is already dead
        ws.close(1000, 'PTY exited');
      });
    }

    // Send acknowledgment
    ws.send(JSON.stringify({
      type: 'init_ack',
      connectionId,
      sessionExists: !isNew,
      cols: safeCols,
      rows: safeRows,
    }));

    resetIdleTimer();
  }

  // Handle control messages (resize)
  function handleControlMessage(msg) {
    if (msg.type === 'resize' && session?.pty) {
      const cols = Math.min(Math.max(parseInt(msg.cols, 10), 10), 500);
      const rows = Math.min(Math.max(parseInt(msg.rows, 10), 5), 200);

      console.log(`[${connectionId}] Resize to ${cols}x${rows}`);
      session.pty.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    }
  }

  // Cleanup on disconnect
  function cleanup(shouldDetach = true) {
    if (idleTimer) clearTimeout(idleTimer);

    if (session) {
      console.log(`[${connectionId}] Cleaning up session for "${session.userId}"`);

      // Detach PTY (keep it alive for reconnects) instead of killing
      if (shouldDetach && session.userId) {
        detachPty(session.userId);
      }

      activeSessions.delete(connectionId);
      session = null;
    }
  }

  ws.on('close', (code, reason) => {
    console.log(`[${connectionId}] WebSocket closed (code=${code}, reason=${reason})`);
    cleanup(true); // Detach PTY, keep it alive
  });

  ws.on('error', (err) => {
    console.error(`[${connectionId}] WebSocket error:`, err.message);
    cleanup();
  });
}

// =============================================================================
// HTTP Server (serves static files)
// =============================================================================

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function handleHttpRequest(req, res) {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeConnections: activeSessions.size,
      persistentPtys: persistentPtys.size,
      tmuxSessions: listTmuxSessions().length,
    }));
    return;
  }

  // API: list sessions (for admin)
  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      active: Array.from(activeSessions.values()).map(s => ({
        connectionId: s.connectionId,
        userId: s.userId,
        cols: s.cols,
        rows: s.rows,
        uptime: Date.now() - s.createdAt,
      })),
      tmux: listTmuxSessions(),
    }));
    return;
  }

  // Serve static files (strip query string)
  const urlPath = req.url.split('?')[0];
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = join(PUBLIC_DIR, filePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

function main() {
  // Create HTTP server
  const httpServer = createServer(handleHttpRequest);

  // Create WebSocket server
  const wss = new WebSocketServer({
    server: httpServer,
    // Important: handle binary data properly
    perMessageDeflate: false, // Disable compression for lower latency
    maxPayload: 1024 * 1024,  // 1MB max message size
  });

  wss.on('connection', handleWebSocket);

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down...`);

    // Close all PTYs (but leave tmux sessions intact)
    for (const [id, session] of activeSessions) {
      console.log(`Closing session ${id}`);
      try {
        session.pty?.kill();
      } catch (e) {
        // Ignore
      }
    }

    wss.close(() => {
      httpServer.close(() => {
        console.log('Server shut down cleanly');
        process.exit(0);
      });
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      console.log('Forcing exit...');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start server
  httpServer.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                  Web Terminal Server Started                   ║
╠════════════════════════════════════════════════════════════════╣
║  URL:     http://${CONFIG.host}:${CONFIG.port.toString().padEnd(43)}║
║  Health:  http://${CONFIG.host}:${CONFIG.port}/health${' '.repeat(35)}║
╠════════════════════════════════════════════════════════════════╣
║  Features:                                                     ║
║  • Real PTY with interactive shell                             ║
║  • Binary WebSocket frames for raw terminal I/O                ║
║  • User-managed tmux sessions supported                        ║
║  • Terminal resize support                                     ║
╚════════════════════════════════════════════════════════════════╝
    `);
  });
}

main();

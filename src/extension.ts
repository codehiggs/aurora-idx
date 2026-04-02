/**
 * AURORA extension for Project IDX
 *
 * Starts a local HTTP/SSE server that acts as an MCP bridge between
 * the AURORA CLI (running in IDX's integrated terminal) and the IDX
 * editor APIs (open files, show diffs, etc.).
 *
 * Communication flow:
 *   AURORA CLI  <--SSE-->  This extension (MCP server)  <-->  VS Code API
 *
 * On activation the extension:
 * 1. Finds a free TCP port.
 * 2. Starts an HTTP server with GET /sse (event stream) and POST /message.
 * 3. Writes ~/.claude/ide/<port>.lock so AURORA auto-detects the connection.
 * 4. Cleans up on deactivation (stops server, removes lockfile).
 */

import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LockfileContent {
  workspaceFolders: string[]
  pid: number
  ideName: string
  transport: 'sse'
  runningInWindows: boolean
}

interface SseClient {
  id: string
  response: http.ServerResponse
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: http.Server | null = null
let lockfilePath: string | null = null
let sseClients: SseClient[] = []
let statusBarItem: vscode.StatusBarItem | null = null
let outputChannel: vscode.OutputChannel | null = null

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('AURORA')
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  )
  statusBarItem.command = 'aurora.idx.showStatus'
  context.subscriptions.push(statusBarItem, outputChannel)

  context.subscriptions.push(
    vscode.commands.registerCommand('aurora.idx.startServer', startServer),
    vscode.commands.registerCommand('aurora.idx.stopServer', stopServer),
    vscode.commands.registerCommand('aurora.idx.showStatus', showStatus),
  )

  const config = vscode.workspace.getConfiguration('aurora.idx')
  if (config.get<boolean>('autoStart', true)) {
    await startServer()
  }
}

export function deactivate(): void {
  stopServer()
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(): Promise<void> {
  if (server) {
    log('MCP server is already running')
    return
  }

  const configPort = vscode.workspace
    .getConfiguration('aurora.idx')
    .get<number>('port', 0)
  const port = configPort > 0 ? configPort : await findFreePort()

  server = http.createServer(requestHandler)
  server.listen(port, '127.0.0.1', () => {
    log(`MCP SSE server listening on port ${port}`)
    writeLockfile(port)
    updateStatusBar(true, port)
  })

  server.on('error', err => {
    log(`Server error: ${err.message}`)
    updateStatusBar(false)
  })
}

function stopServer(): void {
  removeLockfile()
  if (server) {
    server.close()
    server = null
  }
  sseClients = []
  updateStatusBar(false)
  log('MCP server stopped')
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function requestHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // CORS for local connections
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/sse') {
    handleSseConnection(req, res)
  } else if (req.method === 'POST' && req.url === '/message') {
    handleMessage(req, res)
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function handleSseConnection(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const clientId = Math.random().toString(36).slice(2)
  const client: SseClient = { id: clientId, response: res }
  sseClients.push(client)
  log(`SSE client connected: ${clientId}`)

  // Send initial capabilities
  sendSseEvent(client, 'capabilities', {
    tools: ['open_file', 'get_workspace_folders', 'show_diff'],
  })

  res.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId)
    log(`SSE client disconnected: ${clientId}`)
  })
}

function sendSseEvent(client: SseClient, event: string, data: unknown): void {
  client.response.write(`event: ${event}\n`)
  client.response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcastSseEvent(event: string, data: unknown): void {
  for (const client of sseClients) {
    sendSseEvent(client, event, data)
  }
}

// ---------------------------------------------------------------------------
// MCP message handler
// ---------------------------------------------------------------------------

function handleMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', async () => {
    try {
      const message = JSON.parse(body) as {
        id?: string
        method: string
        params?: Record<string, unknown>
      }
      const result = await dispatchTool(message.method, message.params ?? {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: message.id, result }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  })
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'open_file':
      return openFile(params)
    case 'get_workspace_folders':
      return getWorkspaceFolders()
    case 'show_diff':
      return showDiff(params)
    default:
      throw new Error(`Unknown tool: ${method}`)
  }
}

async function openFile(params: Record<string, unknown>): Promise<unknown> {
  const filePath = params['path']
  if (typeof filePath !== 'string') {
    throw new Error('open_file requires a "path" string parameter')
  }
  const uri = vscode.Uri.file(filePath)
  await vscode.window.showTextDocument(uri, { preview: false })
  return { opened: filePath }
}

function getWorkspaceFolders(): unknown {
  const folders =
    vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
  return { workspaceFolders: folders }
}

async function showDiff(params: Record<string, unknown>): Promise<unknown> {
  const original = params['original']
  const modified = params['modified']
  const title = typeof params['title'] === 'string' ? params['title'] : 'Diff'

  if (typeof original !== 'string' || typeof modified !== 'string') {
    throw new Error('show_diff requires "original" and "modified" string parameters')
  }

  const originalUri = vscode.Uri.parse(
    `untitled:${title} (original)`,
  )
  const modifiedUri = vscode.Uri.parse(`untitled:${title} (modified)`)

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    modifiedUri,
    title,
  )

  return { shown: true }
}

// ---------------------------------------------------------------------------
// Lockfile helpers
// ---------------------------------------------------------------------------

function getLockfileDir(): string {
  return path.join(os.homedir(), '.claude', 'ide')
}

function writeLockfile(port: number): void {
  const dir = getLockfileDir()
  fs.mkdirSync(dir, { recursive: true })
  lockfilePath = path.join(dir, `${port}.lock`)

  const content: LockfileContent = {
    workspaceFolders:
      vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
    pid: process.pid,
    ideName: 'Project IDX',
    transport: 'sse',
    runningInWindows: false,
  }

  fs.writeFileSync(lockfilePath, JSON.stringify(content), 'utf-8')
  log(`Lockfile written: ${lockfilePath}`)
}

function removeLockfile(): void {
  if (lockfilePath) {
    try {
      fs.unlinkSync(lockfilePath)
    } catch {
      // ignore — may already be gone
    }
    lockfilePath = null
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatusBar(connected: boolean, port?: number): void {
  if (!statusBarItem) return
  if (connected && port !== undefined) {
    statusBarItem.text = `$(plug) AURORA :${port}`
    statusBarItem.tooltip = `AURORA MCP server running on port ${port}`
    statusBarItem.backgroundColor = undefined
  } else {
    statusBarItem.text = `$(debug-disconnect) AURORA`
    statusBarItem.tooltip = 'AURORA MCP server stopped'
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground',
    )
  }
  statusBarItem.show()
}

function showStatus(): void {
  const isRunning = server !== null
  const msg = isRunning
    ? `AURORA MCP server is running. ${sseClients.length} client(s) connected.`
    : 'AURORA MCP server is stopped. Run "AURORA: Start MCP Server" to start it.'
  void vscode.window.showInformationMessage(msg)
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(message: string): void {
  outputChannel?.appendLine(`[AURORA] ${message}`)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

// Notify any connected AURORA CLI instances when workspace folders change
vscode.workspace.onDidChangeWorkspaceFolders(() => {
  broadcastSseEvent('workspace_changed', {
    workspaceFolders:
      vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
  })
})

import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

type EmbeddedBackendState = {
  child: ChildProcess
  port: number
  backendRoot: string
  dataDir: string
  profilesDir: string
  logPath: string
  logStream: fs.WriteStream
}

let state: EmbeddedBackendState | null = null

const BACKEND_LOG_FILENAME = 'embedded-backend.log'

export function getEmbeddedBackendLogPath(): string {
  return path.join(app.getPath('userData'), BACKEND_LOG_FILENAME)
}

function nowIso(): string {
  return new Date().toISOString()
}

function openBackendLogStream(logPath: string): fs.WriteStream {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch {
    // ignore
  }

  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  stream.on('error', () => {
    // ignore
  })
  return stream
}

function logToFile(stream: fs.WriteStream | null | undefined, line: string): void {
  try {
    stream?.write(`${line}\n`)
  } catch {
    // ignore
  }
}

function chunkToLines(chunk: Buffer): string[] {
  return String(chunk)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function seedFileIfMissing(sourceFile: string, destFile: string): void {
  try {
    if (exists(destFile)) return
    if (!exists(sourceFile)) return

    fs.mkdirSync(path.dirname(destFile), { recursive: true })
    fs.copyFileSync(sourceFile, destFile)
  } catch {
    // ignore (best-effort)
  }
}

function seedDirIfMissing(sourceDir: string, destDir: string): void {
  try {
    if (exists(destDir)) return
    if (!exists(sourceDir)) return

    fs.mkdirSync(path.dirname(destDir), { recursive: true })
    fs.cpSync(sourceDir, destDir, { recursive: true })
  } catch {
    // ignore (best-effort)
  }
}

function findBackendRoot(): string {
  const candidates: string[] = []

  const envDir =
    process.env.LB_BACKEND_DIR || process.env.LIGHTNINGBOT_BACKEND_DIR || process.env.BACKEND_DIR
  if (envDir) candidates.push(envDir)

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'backend'))
  }

  // Common paths for electron-vite (dev) and electron-builder (asar)
  candidates.push(path.join(__dirname, '../../../backend'))
  candidates.push(path.join(__dirname, '../../../../backend'))

  // Fallbacks (depending on how Electron is launched)
  candidates.push(path.join(process.cwd(), '../backend'))
  candidates.push(path.join(process.cwd(), '../../backend'))

  for (const candidate of candidates) {
    const pkg = path.join(candidate, 'package.json')
    const entry = path.join(candidate, 'src', 'server.js')
    if (exists(pkg) && exists(entry)) return candidate
  }

  throw new Error(`Embedded backend not found. Tried: ${candidates.join(', ')}`)
}

function pingHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        method: 'GET',
        timeout: 2000
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )

    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function waitForBackendReady(port: number, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await pingHealth(port)
    if (ok) return true

    await new Promise((r) => setTimeout(r, 250))
  }

  return false
}

export async function startEmbeddedBackend(): Promise<{ port: number; apiUrl: string } | null> {
  if (state) return { port: state.port, apiUrl: `http://127.0.0.1:${state.port}/api` }

  const backendRoot = findBackendRoot()
  const entry = path.join(backendRoot, 'src', 'server.js')

  const logPath = getEmbeddedBackendLogPath()
  const logStream = openBackendLogStream(logPath)
  logToFile(logStream, `\n=== Embedded backend start ${nowIso()} ===`)
  logToFile(logStream, `packaged=${String(app.isPackaged)}`)
  logToFile(logStream, `execPath=${process.execPath}`)
  logToFile(logStream, `backendRoot=${backendRoot}`)
  logToFile(logStream, `entry=${entry}`)

  const port = Number(process.env.LB_BACKEND_PORT || 3001)
  logToFile(logStream, `port=${String(port)}`)

  // If something is already serving the expected health endpoint,
  // do not spawn another backend process.
  try {
    if (await pingHealth(port)) {
      logToFile(logStream, `reusingExistingBackend=true`)
      try {
        logStream.end()
      } catch {
        // ignore
      }
      return { port, apiUrl: `http://127.0.0.1:${port}/api` }
    }
  } catch {
    // ignore
  }

  const runtimeRoot = path.join(app.getPath('userData'), 'backend-runtime')
  const dataDir = path.join(runtimeRoot, 'data')
  const profilesDir = path.join(runtimeRoot, 'profiles')

  logToFile(logStream, `dataDir=${dataDir}`)
  logToFile(logStream, `profilesDir=${profilesDir}`)

  // Seed initial state (best-effort). Runtime directories must be writable.
  seedFileIfMissing(path.join(backendRoot, 'data', 'store.json'), path.join(dataDir, 'store.json'))
  seedFileIfMissing(path.join(backendRoot, 'data', 'users.json'), path.join(dataDir, 'users.json'))
  seedDirIfMissing(path.join(backendRoot, 'profiles'), profilesDir)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    HOST: '127.0.0.1',
    DEFAULT_HEADLESS: app.isPackaged ? '0' : process.env.DEFAULT_HEADLESS,
    FORCE_VISIBLE_BROWSER: app.isPackaged ? '1' : process.env.FORCE_VISIBLE_BROWSER,
    VISA_DATA_DIR: dataDir,
    VISA_PROFILES_DIR: profilesDir,
    NODE_ENV: app.isPackaged ? 'production' : process.env.NODE_ENV || 'development'
  }

  // Allow the backend to resolve shared deps from the Electron app as a fallback.
  // This helps in packaged builds if backend/node_modules is missing or incomplete.
  const nodePathEntries = new Set<string>()
  const existing = env.NODE_PATH ? String(env.NODE_PATH) : ''
  for (const p of existing.split(path.delimiter)) {
    const trimmed = p.trim()
    if (trimmed) nodePathEntries.add(trimmed)
  }
  nodePathEntries.add(path.join(backendRoot, 'node_modules'))
  if (app.isPackaged) {
    nodePathEntries.add(path.join(process.resourcesPath, 'app.asar', 'node_modules'))
    nodePathEntries.add(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'))
  } else {
    nodePathEntries.add(path.join(app.getAppPath(), 'node_modules'))
    nodePathEntries.add(path.join(process.cwd(), 'node_modules'))
  }
  env.NODE_PATH = Array.from(nodePathEntries).join(path.delimiter)
  logToFile(logStream, `NODE_PATH=${env.NODE_PATH || ''}`)

  const recent: string[] = []
  const remember = (line: string) => {
    recent.push(line)
    if (recent.length > 100) recent.splice(0, recent.length - 100)
  }

  const child = spawn(process.execPath, [entry], {
    cwd: backendRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  state = { child, port, backendRoot, dataDir, profilesDir, logPath, logStream }

  child.on('error', (err) => {
    const msg = `[${nowIso()}] [spawn:error] ${String((err as Error)?.message || err)}`
    console.error('[backend] spawn error:', err)
    logToFile(logStream, msg)
    remember(msg)
  })

  child.stdout?.on('data', (buf) => {
    for (const line of chunkToLines(buf)) {
      const msg = `[${nowIso()}] [stdout] ${line}`
      console.log(`[backend] ${line}`)
      logToFile(logStream, msg)
      remember(msg)
    }
  })

  child.stderr?.on('data', (buf) => {
    for (const line of chunkToLines(buf)) {
      const msg = `[${nowIso()}] [stderr] ${line}`
      console.error(`[backend] ${line}`)
      logToFile(logStream, msg)
      remember(msg)
    }
  })

  child.on('exit', (code, signal) => {
    console.warn(`[backend] exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
    logToFile(
      logStream,
      `=== Embedded backend exit ${nowIso()} code=${String(code ?? 'null')} signal=${String(
        signal ?? 'null'
      )} ===`
    )
    try {
      logStream.end()
    } catch {
      // ignore
    }
    if (state?.child === child) state = null
  })

  const ready = await waitForBackendReady(port).catch(() => false)
  if (!ready) {
    const tail = recent.slice(-25).join('\n')
    logToFile(logStream, `=== Embedded backend NOT READY ${nowIso()} ===`)

    try {
      const pid = child.pid
      if (process.platform === 'win32' && pid) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // ignore
    }

    try {
      logStream.end()
    } catch {
      // ignore
    }
    state = null

    throw new Error(
      `Embedded backend failed to become healthy on 127.0.0.1:${port}.\n` +
        `Log: ${logPath}` +
        (tail ? `\n\nLast output:\n${tail}` : '')
    )
  }

  logToFile(logStream, `=== Embedded backend ready ${nowIso()} ===`)
  return { port, apiUrl: `http://127.0.0.1:${port}/api` }
}

export function stopEmbeddedBackend(): void {
  if (!state) return

  try {
    const pid = state.child.pid
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      state.child.kill('SIGTERM')
    }
  } catch {
    // ignore
  } finally {
    try {
      logToFile(state.logStream, `\n=== Embedded backend stop ${nowIso()} ===`)
      state.logStream.end()
    } catch {
      // ignore
    }
    state = null
  }
}

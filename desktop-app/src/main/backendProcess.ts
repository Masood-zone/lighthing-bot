import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

const EMBEDDED_BACKEND_PORT = 3001
const HEALTHCHECK_URL = `http://127.0.0.1:${EMBEDDED_BACKEND_PORT}/api/health`
const BACKEND_BOOT_TIMEOUT_MS = 15000
const BACKEND_SHUTDOWN_TIMEOUT_MS = 5000

type EmbeddedBackendHandle = {
  baseUrl: string
  external: boolean
  stop: () => Promise<void>
}

type BackendTemplatePaths = {
  root: string
  srcDir: string
  mainDir: string
  dataDir: string
  envFile: string
}

type BackendRuntimePaths = {
  root: string
  srcDir: string
  mainDir: string
  dataDir: string
  profilesDir: string
  envFile: string
  serverScript: string
}

function getSeleniumManagerBinaryName(): string {
  return process.platform === 'win32' ? 'selenium-manager.exe' : 'selenium-manager'
}

function getSeleniumManagerPlatformDir(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'linux'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function isBackendHealthy(): Promise<boolean> {
  try {
    const response = await fetch(HEALTHCHECK_URL)
    return response.ok
  } catch {
    return false
  }
}

function findDevBackendRoot(): string {
  const candidates = [
    resolve(app.getAppPath(), '..', 'backend'),
    resolve(process.cwd(), '..', 'backend'),
    resolve(process.cwd(), 'backend')
  ]

  for (const root of candidates) {
    const serverScript = join(root, 'src', 'server.js')
    if (existsSync(serverScript)) {
      return root
    }
  }

  throw new Error('Could not resolve the backend project directory for embedded startup.')
}

function resolveEnvTemplateFile(backendRoot: string): string {
  const candidates = is.dev
    ? [
        join(app.getAppPath(), 'build', 'embedded-backend.env'),
        join(process.cwd(), 'build', 'embedded-backend.env'),
        join(backendRoot, '.env')
      ]
    : [join(backendRoot, '.env')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error('Could not resolve the embedded backend environment template.')
}

function resolveBackendTemplate(): BackendTemplatePaths {
  const root = is.dev ? findDevBackendRoot() : join(process.resourcesPath, 'backend')

  return {
    root,
    srcDir: join(root, 'src'),
    mainDir: join(root, 'main'),
    dataDir: join(root, 'data'),
    envFile: resolveEnvTemplateFile(root)
  }
}

function ensureSeedFile(seedFilePath: string, runtimeFilePath: string): void {
  if (!existsSync(seedFilePath) || existsSync(runtimeFilePath)) return
  mkdirSync(dirname(runtimeFilePath), { recursive: true })
  copyFileSync(seedFilePath, runtimeFilePath)
}

function getRuntimePaths(): BackendRuntimePaths {
  const root = join(app.getPath('userData'), 'backend-runtime')

  return {
    root,
    srcDir: join(root, 'src'),
    mainDir: join(root, 'main'),
    dataDir: join(root, 'data'),
    profilesDir: join(root, 'profiles'),
    envFile: join(root, '.env'),
    serverScript: join(root, 'src', 'server.js')
  }
}

function syncTemplateDirectory(templateDir: string, runtimeDir: string): void {
  rmSync(runtimeDir, { recursive: true, force: true })
  cpSync(templateDir, runtimeDir, { recursive: true, force: true })
}

function prepareBackendRuntime(template: BackendTemplatePaths, runtime: BackendRuntimePaths): void {
  mkdirSync(runtime.root, { recursive: true })

  // Keep executable code in sync with the packaged template while preserving user data.
  syncTemplateDirectory(template.srcDir, runtime.srcDir)
  syncTemplateDirectory(template.mainDir, runtime.mainDir)
  copyFileSync(template.envFile, runtime.envFile)

  mkdirSync(runtime.dataDir, { recursive: true })
  mkdirSync(runtime.profilesDir, { recursive: true })

  ensureSeedFile(join(template.dataDir, 'users.json'), join(runtime.dataDir, 'users.json'))

  const runtimeStoreFile = join(runtime.dataDir, 'store.json')
  if (!existsSync(runtimeStoreFile)) {
    writeFileSync(runtimeStoreFile, `${JSON.stringify({ sessions: {} }, null, 2)}\n`, 'utf8')
  }
}

function getNodePath(): string {
  const candidatePaths = [
    join(app.getAppPath(), 'node_modules'),
    join(process.cwd(), 'node_modules'),
    join(process.resourcesPath, 'app.asar', 'node_modules'),
    join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
    join(process.resourcesPath, 'app', 'node_modules'),
    process.env.NODE_PATH
  ].filter(Boolean)

  return Array.from(new Set(candidatePaths)).join(delimiter)
}

function getSeleniumManagerPath(): string | undefined {
  const platformDir = getSeleniumManagerPlatformDir()
  const binaryName = getSeleniumManagerBinaryName()

  const candidatePaths = [
    join(app.getAppPath(), 'node_modules', 'selenium-webdriver', 'bin', platformDir, binaryName),
    join(process.cwd(), 'node_modules', 'selenium-webdriver', 'bin', platformDir, binaryName),
    join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'selenium-webdriver',
      'bin',
      platformDir,
      binaryName
    ),
    join(
      process.resourcesPath,
      'app.asar',
      'node_modules',
      'selenium-webdriver',
      'bin',
      platformDir,
      binaryName
    ),
    process.env.SE_MANAGER_PATH
  ].filter(Boolean) as string[]

  return candidatePaths.find((candidatePath) => existsSync(candidatePath))
}

function logBackendStream(kind: 'stdout' | 'stderr', chunk: Buffer): void {
  const text = chunk.toString('utf8').trim()
  if (!text) return

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const prefix = `[embedded-backend:${kind}]`
    if (kind === 'stderr') {
      console.error(`${prefix} ${line}`)
    } else {
      console.log(`${prefix} ${line}`)
    }
  }
}

async function waitForHealthyBackend(timeoutMs: number, hasExited: () => boolean): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isBackendHealthy()) return
    if (hasExited()) break
    await sleep(250)
  }

  throw new Error('Embedded backend did not become ready before the startup timeout.')
}

async function forceKillChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) return

  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })

      const finish = () => resolvePromise()
      killer.once('exit', finish)
      killer.once('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        finish()
      })
    })
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
}

async function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) return

  await new Promise<void>((resolvePromise) => {
    let settled = false

    const finalize = () => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimer)
      resolvePromise()
    }

    const forceKillTimer = setTimeout(() => {
      void forceKillChildProcess(child).finally(finalize)
    }, BACKEND_SHUTDOWN_TIMEOUT_MS)

    child.once('exit', finalize)

    try {
      child.kill('SIGTERM')
    } catch {
      finalize()
    }
  })
}

export async function startEmbeddedBackend(): Promise<EmbeddedBackendHandle> {
  if (await isBackendHealthy()) {
    console.log('[embedded-backend] Reusing an existing backend on port 3001.')
    return {
      baseUrl: `http://127.0.0.1:${EMBEDDED_BACKEND_PORT}/api`,
      external: true,
      stop: async () => {}
    }
  }

  const template = resolveBackendTemplate()
  const runtime = getRuntimePaths()
  const seleniumManagerPath = getSeleniumManagerPath()

  prepareBackendRuntime(template, runtime)

  let isStopping = false
  let hasExited = false

  const child = spawn(process.execPath, [runtime.serverScript], {
    cwd: runtime.root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: getNodePath(),
      ...(seleniumManagerPath ? { SE_MANAGER_PATH: seleniumManagerPath } : {}),
      PORT: String(EMBEDDED_BACKEND_PORT)
    }
  })

  if (seleniumManagerPath) {
    console.log(`[embedded-backend] Using Selenium Manager at ${seleniumManagerPath}`)
  }

  child.stdout?.on('data', (chunk) => logBackendStream('stdout', chunk))
  child.stderr?.on('data', (chunk) => logBackendStream('stderr', chunk))

  child.on('exit', (code, signal) => {
    hasExited = true
    if (isStopping) return
    console.error(`[embedded-backend] Backend exited unexpectedly (code=${code}, signal=${signal})`)
  })

  child.on('error', (error) => {
    console.error('[embedded-backend] Failed to start backend process:', error)
  })

  await waitForHealthyBackend(BACKEND_BOOT_TIMEOUT_MS, () => hasExited)

  return {
    baseUrl: `http://127.0.0.1:${EMBEDDED_BACKEND_PORT}/api`,
    external: false,
    stop: async () => {
      isStopping = true
      await stopChildProcess(child)
    }
  }
}

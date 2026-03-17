import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const desktopAppDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopAppDir, '..')
const backendDir = path.resolve(repoRoot, 'backend')

// This folder is generated during builds and bundled via electron-builder extraResources.
const stagingDir = path.resolve(desktopAppDir, '.backend-deps')

function mustExist(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing required file/folder: ${p}`)
  }
}

function run(command, args, cwd) {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          // Spawning .cmd directly is unreliable; delegate to cmd.exe.
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', command, ...args],
          { cwd, stdio: 'inherit', windowsHide: true }
        )
      : spawnSync(command, args, { cwd, stdio: 'inherit' })

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exitCode = result.status
    throw new Error(`${command} exited with code ${result.status}`)
  }

  if (result.error) {
    throw result.error
  }
}

try {
  const backendPkgJson = path.join(backendDir, 'package.json')
  const backendLock = path.join(backendDir, 'pnpm-lock.yaml')

  mustExist(backendPkgJson)
  mustExist(backendLock)

  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.mkdirSync(stagingDir, { recursive: true })

  fs.copyFileSync(backendPkgJson, path.join(stagingDir, 'package.json'))
  fs.copyFileSync(backendLock, path.join(stagingDir, 'pnpm-lock.yaml'))

  // IMPORTANT:
  // - `node-linker=hoisted` + `package-import-method=copy` yields a portable node_modules on Windows
  //   (no absolute-path junctions/symlinks that break when installed under Program Files).
  // - `--ignore-scripts` keeps the build deterministic and avoids postinstall surprises.
  run(
    'pnpm',
    [
      'install',
      '--prod',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.package-import-method=copy'
    ],
    stagingDir
  )

  const expressDir = path.join(stagingDir, 'node_modules', 'express')
  mustExist(expressDir)

  // eslint-disable-next-line no-console
  console.log(`Prepared backend deps at: ${stagingDir}`)
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[prepare-backend-deps] failed:', err)
  process.exitCode = process.exitCode || 1
}

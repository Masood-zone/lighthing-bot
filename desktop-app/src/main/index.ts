import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startEmbeddedBackend, stopEmbeddedBackend } from './embeddedBackend'

let mainWindow: BrowserWindow | null = null
let runtimeApiUrl: string | undefined

function shouldOpenDevToolsOnStart(): boolean {
  return (
    process.argv.includes('--devtools') ||
    process.env.LB_DEVTOOLS === '1' ||
    process.env.LIGHTNINGBOT_DEVTOOLS === '1'
  )
}

function withApiUrl(url: string, apiUrl: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('apiUrl', apiUrl)
    return u.toString()
  } catch {
    return url
  }
}

function createWindow(opts?: { apiUrl?: string; openDevTools?: boolean }): BrowserWindow {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    const url = opts?.apiUrl ? withApiUrl(base, opts.apiUrl) : base
    mainWindow.loadURL(url)
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    if (opts?.apiUrl) {
      mainWindow.loadFile(filePath, { query: { apiUrl: opts.apiUrl } })
    } else {
      mainWindow.loadFile(filePath)
    }
  }

  if (opts?.openDevTools) {
    mainWindow.webContents.openDevTools({ mode: 'right' })
  }

  return mainWindow
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.lightningbot.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  if (app.isPackaged) {
    // Allow DevTools toggling in production builds.
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow
      win?.webContents.toggleDevTools()
    })
  }

  let backendError: unknown = null
  try {
    const started = await startEmbeddedBackend()
    runtimeApiUrl = started?.apiUrl
  } catch (err) {
    backendError = err
    console.error('[backend] failed to start:', err)
  }

  createWindow({
    apiUrl: runtimeApiUrl,
    openDevTools: shouldOpenDevToolsOnStart() || Boolean(backendError)
  })

  if (backendError) {
    const message = backendError instanceof Error ? backendError.message : String(backendError)
    dialog.showErrorBox('Lightning Bot backend failed to start', message)
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  stopEmbeddedBackend()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

# LightningBot Desktop App

The Electron shell for LightningBot. It wraps the React frontend, starts the backend automatically, and packages the Playwright worker into the desktop build so operators do not need to run a separate backend in production.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

## Embedded backend

When the Electron app launches, it starts the backend from `../backend` as a child process.

- Backend API base URL: `http://localhost:3001/api`
- Runtime persistence: Electron `userData` folder under `backend-runtime/` for session data and Chrome profiles
- Production bundles: the backend and worker are packaged into the app, so clients do **not** need a separate backend instance
- Packaged desktop sessions default to visible browser mode so the Chrome window opens when a session starts
- The booking algorithm that actually runs lives in `backend/main/index.js`

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

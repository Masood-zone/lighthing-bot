# desktop-app

An Electron application with React and TypeScript

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

This desktop app automatically starts the current backend from `../backend` as a child process when the Electron app launches.

- Backend API base URL: `http://localhost:3001/api`
- Runtime persistence (writable): Electron `userData` folder under `backend-runtime/` (stores `data/` and `profiles/`)
- Production bundles: the backend and Playwright worker are packaged into the app, so clients do **not** need to run a separate backend instance
- Packaged desktop sessions default to visible browser mode so the Chrome window opens when a session starts.

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

# LightningBot Frontend

This package contains the React + Vite control plane for LightningBot. It is the browser UI for starting sessions, observing worker state, and managing the automation service while the Playwright booking worker runs in the backend.

## What lives here

- The operator-facing UI for sessions, status, and configuration.
- A frontend-only Vite app that talks to the backend API.
- Shared component and state code for the desktop shell and web development workflow.

## Scripts

- `pnpm dev` - start the Vite dev server.
- `pnpm build` - type-check and build the production bundle.
- `pnpm lint` - run ESLint.
- `pnpm preview` - preview the production build locally.

## Notes

- This package does not start the worker itself.
- In the desktop app, the backend is started automatically from `../backend` when the Electron shell launches.

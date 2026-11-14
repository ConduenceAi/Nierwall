# Nierwall landing page

A standalone, dependency-free landing page with two sections, an animated illustrative agent demo, three selectable scenarios, a Mac setup dialog, and a privacy disclosure.

From the repository root:

```sh
pnpm landing
pnpm landing:build
```

Preview: http://127.0.0.1:4310. Set `PORT` to choose another port. The production build is in `apps/landing/dist/` and can be served by any static host. The `.openai/hosting.json` file identifies the private Sites deployment.

The primary action opens setup instructions and links to the project's GitHub README. Demo accounts and messages are illustrative; the page never connects a wallet or calls the agent. Motion can be paused and respects the system's reduced-motion preference.

The design uses Conduence's white, black, serif, and outlined-button language with the requested `#3B82F6` blue. Fonts are loaded from Google Fonts with local system fallbacks.

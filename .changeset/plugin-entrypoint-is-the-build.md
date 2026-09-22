---
'@aivi/opencode': patch
---

The plugin loads again from npm. 0.1.3 shipped a root `server.js` that re-exported `./src/index.ts`, while `files` publishes only `dist` — so every install failed with "Cannot find module './src/index.ts'" and registered no aivi tools. Nothing ships from the package root now: `exports["."]` is the only export, and OpenCode's loader reaches it through its fallback candidate. The example home names the build it runs, `../packages/opencode/dist/index.js`, so a fresh clone runs `npm run build` before OpenCode loads the plugin.

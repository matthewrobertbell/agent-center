# Agent Center

Agent Center is a compact browser client for working with software-development agents through an [OpenCode](https://opencode.ai/) server. It uses the official `@opencode-ai/sdk` directly from a React interface, with no application backend or proxy.

The project is designed for developers who keep several agent tasks active at once and want dense navigation, clear progress state, and readable tool output without terminal-style clutter.

> Agent Center is an independent community project and is not affiliated with or endorsed by OpenCode.

## Features

- Space-efficient task sidebar with search, pinning, renaming, deletion, unread state, and live activity indicators
- Date and project grouping across every project exposed by the connected server
- Recent-project picker plus manual directory entry for new tasks and project switching
- Direct task prompting through the official OpenCode TypeScript SDK
- Agent and model selectors populated from the connected OpenCode server
- Markdown, tables, code blocks, tool calls, reasoning, todos, attachments, and timing information
- Image attachment by file selection or clipboard paste
- Expandable subagent trees in the sidebar and parent conversations, with direct transcript navigation
- Stop control for active tasks
- System-aware light and dark themes with a persistent override

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- A reachable [OpenCode server](https://opencode.ai/docs/server/)

## Quick start

Install dependencies:

```bash
npm ci
```

Start OpenCode and allow the Vite development origin:

```bash
opencode serve --port 4096 --cors http://127.0.0.1:5173
```

In another terminal, start Agent Center:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. Agent Center connects to `http://127.0.0.1:4096` by default.

## Connecting to another server

Open the connection panel at the bottom of the sidebar and enter the server URL, optional project directory, and password. The browser must be able to reach that URL, and the OpenCode server must allow the Agent Center origin through its CORS configuration. Password authentication uses OpenCode's default `opencode` username.

Passwords are kept in memory for the current page session. They are not written to local storage.

## Standalone build

Create the self-contained HTML build:

```bash
npm run build
```

The command compiles the application and produces a self-contained HTML file with its JavaScript, CSS, fonts, and icons inlined.

Serve the build and allow its origin in OpenCode:

```bash
npm run preview -- --port 4173
opencode serve --port 4096 --cors http://127.0.0.1:4173
```

Then open `http://127.0.0.1:4173`.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Vite server |
| `npm run typecheck` | Check the TypeScript project |
| `npm run build` | Typecheck and create the production build |
| `npm run preview` | Serve the production build locally |
| `npm run check` | Run the release verification command |

The main integration boundary lives in `src/opencode.ts`. UI state and rendering live in `src/App.tsx`, with the design tokens and responsive styles in `src/styles.css`. `scripts/inline-build.mjs` converts Vite's output into the distributable single-file build.

## Contributing

Issues and pull requests are welcome. Before submitting a change:

1. Keep the interface compact, accessible, and keyboard operable.
2. Follow the documented [product and design principles](docs/PRODUCT.md).
3. Use the official OpenCode SDK rather than adding a parallel HTTP abstraction.
4. Run `npm run check`.

## License

Agent Center is available under the [MIT License](LICENSE).

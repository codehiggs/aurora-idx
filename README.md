# AURORA for Project IDX

Integrates the **AURORA** AI assistant CLI with [Google Project IDX](https://idx.dev).

## How it works

The extension starts a local MCP (Model Context Protocol) server inside your IDX workspace. When you run `aurora` in the integrated terminal, it auto-detects the extension and gains access to editor actions:

- Open files in the editor
- Show inline diffs
- Read workspace folder structure

## Installation

Add the extension to your `.idx/dev.nix`:

```nix
{ pkgs, ... }: {
  idx.extensions = [
    "higgs.aurora-idx"
  ];
}
```

Then rebuild the workspace. The extension activates automatically and AURORA will connect on the next terminal session.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `aurora.idx.port` | `0` | MCP server port (0 = auto-assign) |
| `aurora.idx.autoStart` | `true` | Start server on workspace open |

## Commands

- **AURORA: Start MCP Server** — start the server manually
- **AURORA: Stop MCP Server** — stop the server
- **AURORA: Show Connection Status** — show current status

## Requirements

- AURORA CLI installed in the workspace (`npm install -g aurora-cli` or via Nix)
- Project IDX with a terminal

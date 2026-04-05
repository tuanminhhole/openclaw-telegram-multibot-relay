# Publishing Guide

## Goal

Publish this plugin so users with an existing OpenClaw installation can install it directly from ClawHub or npm.

## Recommended release flow

1. Create a dedicated GitHub repository for the plugin.
2. Push the plugin files from this directory into that repository.
3. Tag a release such as `v0.2.0`.
4. Publish the package to npm.
5. Publish the package to ClawHub.

## Required metadata

Make sure these files stay in sync:

- `package.json`
- `openclaw.plugin.json`
- `README.md`
- `LICENSE`

For ClawHub plugin publishing, `package.json` should include:

- `openclaw.extensions`
- `openclaw.compat.pluginApi`
- `openclaw.compat.minGatewayVersion`
- `openclaw.build.openclawVersion`
- `openclaw.build.pluginSdkVersion`

## Local validation

```bash
npm pack --dry-run
node --check index.js
```

## Publish to npm

```bash
npm login
npm publish --access public
```

## Publish to ClawHub

```bash
npm i -g clawhub
clawhub package publish . --dry-run
clawhub package publish .
```

## Install commands for end users

From ClawHub:

```bash
openclaw plugins install clawhub:openclaw-telegram-multibot-relay
```

From npm:

```bash
openclaw plugins install openclaw-telegram-multibot-relay
```

## After installation

Enable the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "telegram-multibot-relay": {
        "enabled": true
      }
    }
  }
}
```

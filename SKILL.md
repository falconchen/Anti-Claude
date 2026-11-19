---
name: anti-claude
description: Deploy Anti-Claude's Claude-inspired desktop UI, typography, stratified model selector, live context & plan quota popover, in-bubble undo & edit, sidebar top Recents & collapsed folder badges, native Settings module switches, interleaved step stream, and in-flow live TodoWrite checklist card onto Google Antigravity Desktop 2.0 via non-invasive CDP runtime injection.
---

# Anti-Claude — Agent Auto-Deployment Skill

Only run these steps when the user **explicitly asks to install, update, or uninstall** `Anti-Claude`. If the user only shares the URL or asks you to read, review, or evaluate the project, do **not** install anything.

The installer changes user config (theme-patch `user/` files, `product_skin`, `verboseConversationSteps`, a rule block in `~/.gemini/AGENTS.md`) and records every change for rollback. Tell the user this before running it.

## Prerequisites
- Google Antigravity Desktop 2.0 (`v2.30+`, tested through `v2.33.0+`) on macOS or Windows
- Node.js `>= 22`

## 1-Step Installation (Fresh Install or Update to Latest)
1. Clone this repository (or pull the latest `main` if already cloned) and run the installer:
   ```bash
   if [ -d "$HOME/Developer/Anti-Claude/.git" ]; then
     git -C "$HOME/Developer/Anti-Claude" pull --ff-only
   else
     git clone https://github.com/hongqi7/Anti-Claude.git "$HOME/Developer/Anti-Claude"
   fi
   node "$HOME/Developer/Anti-Claude/install.mjs" install
   node "$HOME/Developer/Anti-Claude/install.mjs" doctor
   ```
2. What `node install.mjs install` automatically handles:
   - Installs upstream `Anarcadia/chuanban-antigravity-theme-patch` (`~/.gemini/antigravity/theme-patch`) if not yet present;
   - Automatically copies official Anthropic variable fonts from `/Applications/Claude.app/Contents/Resources/fonts` on macOS if `Claude.app` is installed locally;
   - Backs up existing `theme-patch/user/` files under `~/.gemini/antigravity/anti-claude/backup/` (plus `base/` 3-way JSON merge baselines and `install-state.json` rollback manifest; legacy `claude-ux/` installs migrate automatically) and deploys all 4 user-layer files (`config.json`, `custom.css`, `custom.js`, `i18n.override.json`);
   - Enables the stratified Model Selector (`Models · This chat`, `1–5` quick keys, separate `Thinking effort >` & `More models >` flyouts), radial Context Progress Ring + live 5h/weekly Quota Popover, clean `tok/s · TTFT` pill (stripping `+sub` clutter), in-bubble Undo & Edit (`Undo` with modified-file preview chips & `Revert files` switch), sidebar top `Recents` & collapsed folder status badges, opaque `/` & `@` typeahead popups, and clean Settings sidebar with an embedded `UI Enhancements` 10-switch live control panel (English by default, zero-reload `Chinese UI Localization` switch);
   - Unlocks Antigravity's hidden Developer Step Stream (`project4kMode = 1` / `PRODUCT_SKIN_DEVELOPER` + `verboseConversationSteps = true`) via live CDP and persistent config so intermediate tool & MCP calls are never wiped;
   - Prepends an idempotent `<!-- BEGIN anti-claude -->` rule block to `~/.gemini/AGENTS.md` enabling language-adaptive Claude-style mid-turn progress updates, invisible `<!-- todo:N/M -->` progression, `ask_question` interactive choice cards, official-blue orbiting step timers (`#2F75C3` / `#2F71E3`), and in-flow 3-state `- [ ]` / `- [/]` / `- [x]` live checklist cards compatible with both Developer and Knowledge Work modes;
   - Registers the `0-token` macOS `launchd` auto-sync watcher (`com.antigravity.anti-claude.autosync`), injects the `v2.33.0+` macOS cold-launch `--remote-debugging-port=0` auto-bootstrap into `antigravity-font-daemon.mjs` (keeping `/Applications/Antigravity.app`'s Apple code signature 100% untouched), and triggers immediate hot-reload in the running Antigravity window.

## Clean Rollback
```bash
node "$HOME/Developer/Anti-Claude/install.mjs" uninstall
```
Removes the auto-update watcher, restores backed-up `theme-patch/user/` files (files that did not exist before are deleted; post-install edits are saved to a side folder first), reverts the step-stream settings it changed, removes the rule block from `~/.gemini/AGENTS.md`, and hot-reloads immediately. Running it twice is a no-op.

Options: `install --no-auto-update | --no-step-unlock | --no-agents-rule | --overwrite-local`. Feature switches live in `user/config.json` → `modules.claudeUx*`. Never touches `/Applications/Antigravity.app/Contents/Resources/app.asar`.

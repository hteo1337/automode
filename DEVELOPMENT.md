# Development

## Repo layout

- **GitHub**: https://github.com/hteo1337/automode
- **npm**: https://www.npmjs.com/package/@oc-moth/automode
- **License**: MIT

The source of truth lives in this repo. `npm publish` is driven by CI on
tagged pushes — no manual publishes in the normal flow.

## Local loop

```bash
npm install         # once per clone
npm test            # vitest, 185 tests
npm run typecheck   # tsc --noEmit (strict)
```

No compile step: OpenClaw loads `*.ts` via jiti at runtime.

## Release cycle

Three files hold the version in lockstep. Bump **all three** in the same
commit, tag, push — CI handles npm.

1. `package.json`              → `"version"`
2. `openclaw.plugin.json`      → `"version"` (same value)
3. `CHANGELOG.md`              → new `## [X.Y.Z] — YYYY-MM-DD` section

Then:

```bash
git add package.json openclaw.plugin.json CHANGELOG.md src/... README.md
git commit -m "release: X.Y.Z — short summary"
git tag vX.Y.Z
git push && git push origin vX.Y.Z
```

The `.github/workflows/publish.yml` workflow fires on any `v*` tag:
1. Checkout, install, typecheck, test.
2. Assert `tag == package.json version` (refuses to publish on mismatch).
3. `npm publish --access public --provenance` using `secrets.NPM_TOKEN`.

Tail progress in the **Actions** tab on GitHub. On success, the new version
shows up at https://www.npmjs.com/package/@oc-moth/automode within ~1 min.

## Versioning

Semver, pre-1.0:
- **Patch (0.3.x → 0.3.x+1)**: bug fixes, security fixes, test additions,
  doc-only changes, no API surface change.
- **Minor (0.3.x → 0.4.0)**: new public features, config fields, commands.
  Existing behaviour preserved.
- **Major (0.x → 1.0)**: freeze `TaskState` schema + stable public API;
  provide migration function.

`CHANGELOG.md` follows Keep a Changelog. Every release gets a dated section
with Added / Changed / Fixed / Removed subsections as needed.

## Hot-patching (dev machine only)

For rapid iteration without a release:
```bash
# edit, test, then:
launchctl kickstart -k "gui/$UID/ai.openclaw.gateway"   # macOS
```
The plugin reloads on gateway restart. This does NOT ship a new npm version;
it's purely local. Use a release when the change should land everywhere.

## First-time setup for a new contributor

```bash
gh repo clone hteo1337/automode ~/.openclaw/extensions/automode
cd ~/.openclaw/extensions/automode
npm install
npm test
```

To actually run it against an OpenClaw gateway, ensure the extension is
enabled in `~/.openclaw/openclaw.json`:
```json
"plugins": {
  "allow": ["automode"],
  "entries": { "automode": { "enabled": true } }
}
```
Restart the gateway (see hot-patching above).

## Release token rotation

`NPM_TOKEN` lives in GitHub repo secrets (`Settings → Secrets and variables
→ Actions`). To rotate:

1. Create a new automation token at https://www.npmjs.com/settings/~/tokens
   with **Publish** access.
2. `gh secret set NPM_TOKEN --body "$(pbpaste)" --repo hteo1337/automode`
   (paste the token).
3. Revoke the old token on the npm site.

The token never touches git.

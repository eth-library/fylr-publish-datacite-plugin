# CLAUDE.md — Project Instructions

Context for AI coding assistants working on this plugin. Keep it concise; treat it as a pointer to the real docs rather than a duplicate of them.

## What this is

A fylr webhook plugin that registers DOIs with DataCite when a workflow fires. Multi-repository capable — one plugin instance serves many DataCite repositories, selected per webhook URL via `?repository=<profile-id>`.

## Where to read first

- [README.md](README.md) — user-facing overview, installation, admin config
- [documentation.md](documentation.md) — full developer guide; architecture, per-function descriptions, troubleshooting
- [CHANGELOG.md](CHANGELOG.md) — release history

Do not duplicate those files here. If context is missing, prefer extending `documentation.md`.

## Architecture in one paragraph

Single Node.js script at [server/webhook/register-doi.js](server/webhook/register-doi.js). No npm dependencies — only the Node stdlib (`http`, `https`, `Buffer`, `URL`). fylr invokes it with the webhook body on stdin and `info.json` as `process.argv[2]`. The script reads the profile from `info.request.query.repository[0]`, builds a DataCite JSON:API payload from the configured field mappings, POSTs to DataCite (PUT on 422 → idempotent update), then POSTs a publish entry back to fylr so the DOI appears in the object's publish tab.

## Non-obvious things that will bite you

1. **The fylr publish endpoint requires a `_basetype` wrapper.** The request body must be `[{_basetype: 'publish', publish: {system_object_id, collector, publish_uri, easydb_uri}}]` — not a flat object. Missing the wrapper produces `PublishUnknownCollector: collector ""` even though the `collector` field is set, because the parser looks for `collector` inside the `publish` sub-object. This is not documented clearly in the public API docs.

2. **Bearer auth works for all fylr API calls, including publish.** An earlier iteration of this plugin used `?access_token=<token>` as a query param; that was a workaround discovered before we knew about the `_basetype` wrapper. Stick with `Authorization: Bearer <token>` headers everywhere.

3. **fylr base_config does not support nested tables.** The three-section design (`datacite_global`, `datacite_profiles`, `datacite_field_mappings`) works around this. Field mappings link to profiles via a `profile_id` text column — admins maintain the foreign-key relationship by typing the same `id` in both tables.

4. **Linked-object fields are shallow in the webhook payload.** When a dot-path descends into a linked object, `resolveFieldPathAsync()` must fetch the full linked object from `GET /api/v1/db/<objecttype>/_all_fields/<id>?format=long` before continuing. This is in the code already; don't remove it.

5. **Commented-out `console.error` debug lines are preserved intentionally.** Uncomment during development, re-comment before release. Do not delete them.

6. **`exit(0)` on config errors, `exit(1)` only on unhandled exceptions.** Non-zero exit makes fylr hide the emitted JSON body, which hides error diagnostics from the admin.

7. **Always use `info.api_url` (internal URL) for fylr API calls**, not `info.external_url`. The internal URL avoids reverse-proxy interference — particularly important for the publish call.

## Build system

- `make zip` → produces `build/<plugin-name>.zip`
- The `buildinfojson` target is copied verbatim from the [official fylr docs](https://docs.fylr.io/for-developers/plugin/release). It generates `build-info.json` (with git metadata) which fylr reads to display **Build Info** in the plugin manager.
- `manifest.master.yml` → `manifest.yml` (renamed during build; filename must be exactly `manifest.yml`)
- No transpilation, no bundling, no dependency install step.

Release workflow: bump `version` in `manifest.master.yml`, add a `CHANGELOG.md` entry, `make zip RELEASE_TAG=vX.Y.Z`.

## Testing

- Test DataCite endpoint: `https://api.test.datacite.org` (the default `api_url` for new profiles). Returns real-looking responses but doesn't mint public DOIs.
- There are no automated tests — this is a small plugin with external-side-effect-heavy logic. Verification is manual: configure a profile, fire the webhook, check DataCite + the object's publish tab.
- For local curl testing against the running fylr docker container, the internal API is typically reachable at `http://<service>:8080` (the port matters — omitting it yields a 301).

## Do not

- Add npm dependencies. The no-deps constraint keeps the zip simple and compatible with whatever Node version fylr's node-exec service ships.
- Move logic out of [register-doi.js](server/webhook/register-doi.js) into modules. It's a single-file script by design.
- Invent manifest fields. Reference the [fylr plugin docs](https://docs.fylr.io/for-developers/plugin/) when adding anything to `manifest.master.yml` — if it's not in the docs, it probably isn't a real field.
- Touch the `_basetype` wrapper in the publish payload without re-reading point 1 above.

## External references

- [fylr plugin development docs](https://docs.fylr.io/for-developers/plugin/)
- [DataCite REST API](https://support.datacite.org/reference/introduction)
- [DataCite metadata schema](https://schema.datacite.org/)

# fylr-plugin-datacite — Developer Documentation

This document explains how the `fylr-plugin-datacite` plugin is implemented. It targets developers who have never worked on this plugin (and possibly never worked with the fylr plugin system before). Read the [README](README.md) first for a high-level user-facing description; this file covers the internals.

## Table of Contents

1. [Summary](#summary)
2. [Background: The fylr Plugin System](#background-the-fylr-plugin-system)
   - [What a fylr plugin is](#what-a-fylr-plugin-is)
   - [Extension types](#extension-types)
   - [How exec scripts are invoked](#how-exec-scripts-are-invoked)
   - [`info.json` — what it is and why it exists](#infojson--what-it-is-and-why-it-exists)
   - [Base configuration](#base-configuration)
   - [Authentication (`plugin_user` and access tokens)](#authentication-plugin_user-and-access-tokens)
   - [Localization (`l10n`)](#localization-l10n)
3. [Repository Layout](#repository-layout)
4. [Build and Release](#build-and-release)
5. [Release Workflow](#release-workflow)
6. [Plugin Manifest (`manifest.master.yml`)](#plugin-manifest-manifestmasteryml)
7. [Configuration Model](#configuration-model)
   - [Why three base_config sections](#why-three-base_config-sections)
   - [Profile selection via `?repository=` query parameter](#profile-selection-via-repository-query-parameter)
8. [End-to-End Request Flow](#end-to-end-request-flow)
9. [The Main Script (`server/webhook/register-doi.js`)](#the-main-script-serverwebhookregister-doijs)
   - [Top-level structure](#top-level-structure)
   - [`main()`](#main)
   - [`resolveFieldPathAsync()`](#resolvefieldpathasync)
   - [`getNestedValue()`](#getnestedvalue)
   - [`httpRequest()`](#httprequest)
10. [DataCite API Integration](#datacite-api-integration)
    - [JSON:API payload format](#jsonapi-payload-format)
    - [Create-or-update pattern (422 → PUT)](#create-or-update-pattern-422--put)
    - [Draft vs Findable DOIs](#draft-vs-findable-dois)
11. [fylr Publish Callback](#fylr-publish-callback)
    - [Why the `_basetype` wrapper is required](#why-the-_basetype-wrapper-is-required)
12. [Error Handling and Logging](#error-handling-and-logging)
13. [Common Maintenance Tasks](#common-maintenance-tasks)
14. [Troubleshooting](#troubleshooting)

---

## Summary

`fylr-plugin-datacite` is a webhook plugin for [fylr](https://fylr.io) that registers DOIs with [DataCite](https://datacite.org) when a fylr workflow fires. It supports **multiple DataCite repositories** from a single plugin installation: each repository is configured as a profile, and each webhook URL selects a profile via a `?repository=<id>` query parameter.

The plugin does three things when triggered:

1. Looks up the selected profile's credentials, DOI prefix, and field mappings from the plugin's base configuration.
2. Builds a DataCite JSON:API metadata record from the webhook payload (resolving dot-paths into the fylr object, including cross-referencing linked objects via the fylr API) and sends it to DataCite's REST API. If the DOI already exists, it updates it via PUT.
3. Posts a corresponding publish entry back to fylr's publish API so the registered DOI URL shows up in the object's publish tab.

All logic lives in a single Node.js script ([server/webhook/register-doi.js](server/webhook/register-doi.js)) with no npm dependencies — it only uses the Node standard library (`http`, `https`, `Buffer`, `URL`). Configuration and localization are declared in [manifest.master.yml](manifest.master.yml) and [l10n/datacite-loca.csv](l10n/datacite-loca.csv). The `Makefile` produces the distributable `.zip`.

---

## Background: The fylr Plugin System

This section exists so a developer unfamiliar with fylr can make sense of the rest of the document. Skip ahead if you already know how fylr plugins work.

### What a fylr plugin is

A fylr plugin is a `.zip` file uploaded through the fylr admin UI. Inside the zip, fylr expects at least a `manifest.yml` file declaring the plugin's metadata, extensions, callbacks, and base configuration schema. Plugins extend fylr by registering callbacks (fired by fylr at specific lifecycle points) or by exposing extensions (endpoints addressable via HTTP that execute scripts).

fylr itself runs inside a Docker container. Plugin scripts do not run as long-lived services; they are spawned on demand.

### Extension types

This plugin uses one extension: `webhook/register-doi`. A `webhook` extension registers a URL under `/api/v1/plugin/base/<plugin-name>/webhook/<name>` that fylr calls when a workflow rule references it. Other extension types exist (e.g. `db_pre_save` callbacks that hook the object save pipeline), but we do not use them here.

### How exec scripts are invoked

Under `extensions.<name>.exec.commands`, the manifest tells fylr how to execute the script. For this plugin:

```yaml
exec:
  service: "node"
  commands:
    - prog: "node"
      stdin:
        type: "body"
      stdout:
        type: "body"
      args:
        - type: "value"
          value: "%_exec.pluginDir%/server/webhook/register-doi.js"
        - type: "value"
          value: "%info.json%"
```

This means:

- fylr spawns `node <pluginDir>/server/webhook/register-doi.js <info.json>` for each request.
- The webhook request body is piped into the script's **stdin**.
- Whatever the script writes to **stdout** becomes the webhook's response body.
- **stderr** is captured and shown in fylr's event viewer under plugin logs.
- `%info.json%` is substituted by fylr at invocation time with the full, serialized `info.json` object (see next section). It arrives as `process.argv[2]`.

The `service: "node"` declaration tells fylr which runtime container to spawn the script in; fylr ships several (node, python, etc.).

### `info.json` — what it is and why it exists

`info.json` is a per-invocation context object that fylr injects into the script. It contains everything the script needs about the current request that is **not** part of the user-supplied payload:

- The full merged plugin configuration (`info.config.plugin.<plugin-name>.config`)
- Pre-authenticated access tokens (`info.plugin_user_access_token`, `info.api_user_access_token`)
- The fylr instance's internal API URL (`info.api_url`) and external URL (`info.external_url`)
- The incoming HTTP request metadata including query parameters (`info.request.query`)
- Various other fields (user info, locale, etc.)

In this plugin we read `info.json` from `process.argv[2]` and parse it once at startup (see [register-doi.js:6-13](server/webhook/register-doi.js#L6-L13)). Do **not** confuse `info.json` (context) with the stdin payload (the webhook body, which contains the objects being registered).

### Base configuration

Plugins can declare configuration that administrators fill out via the fylr admin UI under **Base Configuration**. The shape of each section is declared in `manifest.master.yml` under `base_config`. Supported field types include `text`, `bool`, `user`, and `table` (a table of rows with typed columns). The current values are passed into the script as part of `info.json` under `config.plugin.<plugin-name>.config.<section>.<parameter>`.

### Authentication (`plugin_user` and access tokens)

To call the fylr API from a plugin script, the script needs a valid Bearer token. The `plugin_user` directive in the extension definition tells fylr to inject an access token for a configured user into `info.json` **before** the script runs:

```yaml
plugin_user:
  base_config: "datacite_global.api_user"
```

This reads the user configured in `datacite_global.api_user` (a `type: user` field in the base config) and puts their token into `info.plugin_user_access_token`. The script does not need to perform any login flow — the token is already valid.

There is also `info.api_user_access_token`, which is the token of the user who triggered the webhook. We use `plugin_user_access_token` first and fall back to `api_user_access_token`. The plugin user must have the `system.api.publish.post` system right because the script writes publish entries.

### Localization (`l10n`)

All human-readable labels in the admin UI come from a CSV file declared in the manifest (`l10n: l10n/datacite-loca.csv`). Each row has a key and one column per locale. Keys follow a hierarchical convention (e.g. `server.config.parameter.system.plugin_fylr-plugin-datacite_datacite_profiles.repository_id.label`). fylr looks up labels by key at render time.

---

## Repository Layout

```
fylr-plugin-datacite/
├── manifest.master.yml        # Plugin manifest source (becomes manifest.yml in the zip)
├── Makefile                   # Build script — produces fylr-plugin-datacite.zip
├── README.md                  # User-facing documentation
├── CHANGELOG.md               # Version history
├── documentation.md           # This file — developer documentation
├── l10n/
│   └── datacite-loca.csv      # Localization table (de-DE, en-US)
└── server/
    └── webhook/
        └── register-doi.js    # The one and only script (Node.js, no deps)
```

Everything inside `server/` and `l10n/`, plus the processed `manifest.master.yml → manifest.yml`, ends up in the zip.

## Build and Release

From the repository root:

```
make zip
```

This produces `build/fylr-plugin-datacite.zip`, which is uploaded to fylr under **Plugins**. The Makefile:

1. Runs the `buildinfojson` target, which calls `git show` and `date` to collect the repository name, full commit hash, last-changed timestamp, build date, and optional release tag, writing them as `build-info.json` in the repo root. This is the [pattern prescribed by the official fylr plugin docs](https://docs.fylr.io/for-developers/plugin/release).
2. Copies `manifest.master.yml` → `build/fylr-plugin-datacite/manifest.yml` (the filename change is required — fylr expects exactly `manifest.yml`).
3. Copies `build-info.json` into the build directory so it ends up inside the zip.
4. Copies `server/` and `l10n/` verbatim.
5. Zips the result.

`build-info.json` is what the fylr plugin manager reads to display **Build Info**. It is a build artifact and is listed in `.gitignore`. When releasing via GitHub Actions, pass the tag as `make zip RELEASE_TAG=v1.0.0`; the `release` field in the JSON will be populated accordingly.

To release a new version: update `version` in `manifest.master.yml`, add an entry to `CHANGELOG.md`, then `make zip`.

There is no transpilation, bundling, or dependency install step. The script is plain Node.js and runs in whatever node version the fylr node exec service ships.

## Release Workflow

This is the full end-to-end process for shipping a new version, from code change to live plugin in fylr.

### 1. Make and commit your changes

Edit the relevant files, test manually against a fylr instance (see [Testing](#testing)), then commit normally and push to `main`.

### 2. Update the version and changelog

- Bump `version` in [manifest.master.yml](manifest.master.yml) following semantic versioning (`MAJOR.MINOR.PATCH`):
  - `PATCH` (e.g. `1.0.0` → `1.0.1`) — bug fixes, no config or behaviour changes for admins
  - `MINOR` (e.g. `1.0.0` → `1.1.0`) — new fields or features, backwards compatible
  - `MAJOR` (e.g. `1.0.0` → `2.0.0`) — breaking changes (e.g. base_config restructure that requires re-configuration)
- Add an entry at the top of [CHANGELOG.md](CHANGELOG.md) with the version number, date, and a short description of what changed.
- Commit both files: `bump version to vX.Y.Z`.
- Push to `main`.

### 3. Create and push a version tag

**Via VS Code** (if CLI authentication is not set up):
- Open the Command Palette (`Ctrl+Shift+P`) → **Git: Create Tag** → enter `vX.Y.Z` (must start with `v` and match `v*.*.*` for the workflow to trigger).
- Command Palette → **Git: Push Tags** to push the tag to GitHub.

**Via git CLI:**
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 4. GitHub Actions builds the zip

The release workflow (`.github/workflows/release.yaml`) fires automatically on the tag push. It runs `make zip RELEASE_TAG=vX.Y.Z` and creates a **draft release** on GitHub with `fylr-plugin-datacite.zip` attached. Watch progress under the **Actions** tab.

### 5. Publish the draft release

Go to **Releases** on GitHub. Open the draft, review the autogenerated release notes, and click **Publish release**. Once published, the GitHub "latest" redirect becomes active:

```
https://github.com/eth-library/fylr-publish-datacite-plugin/releases/latest/download/fylr-plugin-datacite.zip
```

### 6. Update the plugin in fylr

Fylr should get the new version automatically every day. If not:
In the fylr admin UI under **Plugins**, find `fylr-plugin-datacite`, delete it and add it again.

### If something goes wrong

To re-run the workflow with the same version tag (e.g. the Actions run failed, or you need to fix something after tagging):

1. Go to **Releases** on GitHub and delete the draft release, if one was created.
2. Go to **Code → Tags** on GitHub and delete the tag there.
3. Delete the tag locally and recreate it:
   ```bash
   git tag -d vX.Y.Z           # delete locally
   git tag vX.Y.Z              # recreate
   git push origin vX.Y.Z      # push (or use VS Code: Git: Push Tags)
   ```

Alternatively, increment to the next patch version (`vX.Y.Z+1`) and skip the deletion — cleaner than reusing a tag.

## Plugin Manifest (`manifest.master.yml`)

The manifest has three top-level sections:

1. `plugin` — name, version, displayname, l10n path, and short `info` description (shown in the plugin manager). Build metadata is not embedded in the manifest — it lives in a separate `build-info.json` file generated at build time (see [Build and Release](#build-and-release)).
2. `extensions` — declares `webhook/register-doi` (see [How exec scripts are invoked](#how-exec-scripts-are-invoked)). The `plugin_user` directive points to `datacite_global.api_user`, wiring up the token injection.
3. `base_config` — declares the three configuration sections described below.

If you add new configuration parameters, they must be declared here **and** given l10n keys in `datacite-loca.csv`, otherwise the admin UI will show untranslated raw keys.

## Configuration Model

### Why three base_config sections

The config is split into three sections for a single architectural reason: **fylr does not support nested tables in base_config**. Ideally one row in a "profiles" table would contain an inner "field mappings" table, but that is not allowed. The three-section design works around that:

- **`datacite_global`** — one singleton section holding the `api_user` field. Shared across all profiles; exists only because `plugin_user` must reference exactly one user.
- **`datacite_profiles`** — a table with one row per DataCite repository. Contains credentials, DOI prefix, API URL, collector name, findable flag, detail URL template, and DOI resolver URL.
- **`datacite_field_mappings`** — a table with one row per field mapping. The `profile_id` column is a foreign key that links each mapping to a row in `datacite_profiles` (matched on the `id` column).

Administrators maintain the foreign-key relationship by hand: they must type the same `id` value in both tables. The script filters mappings by `profile_id === profileId` at runtime.

### Profile selection via `?repository=` query parameter

fylr only allows a plugin to be installed once per instance, but a single fylr instance may need to serve DOIs for multiple DataCite repositories (different prefixes, different credentials). The webhook URL includes a query parameter:

```
/api/v1/plugin/base/fylr-plugin-datacite/webhook/register-doi?repository=<profile-id>
```

fylr passes query parameters into `info.json` as arrays at `info.request.query.<param>`. The script reads the profile id at [register-doi.js:71](server/webhook/register-doi.js#L71):

```javascript
const profileId = info && info.request && info.request.query && info.request.query.repository && info.request.query.repository[0];
```

If the admin forgets the query parameter, the script fails fast with `datacite.config.missing_profile_id`.

## End-to-End Request Flow

1. A fylr workflow rule fires and calls the webhook URL with some trigger payload and `?repository=<id>`.
2. fylr spawns `node register-doi.js <info.json>` and pipes the webhook body into stdin.
3. The script parses `info.json` from `argv[2]` and the payload from stdin.
4. It reads the selected profile and its matching field mappings from the plugin config.
5. For each object in `data.objects`:
   - Resolve each field mapping's dot-path into the object. If a path goes into a linked object, fetch the full linked object from the fylr API using the plugin user's Bearer token.
   - Construct the DOI as `<doi_prefix><system_object_id>`.
   - Build the DataCite JSON:API payload.
   - POST to `<api_url>/dois`. If DataCite returns 422 (exists), retry with PUT to `<api_url>/dois/<doi>`.
   - POST a publish entry to `<fylr_api_url>/api/v1/publish` (Bearer auth) so the DOI appears in the object's publish tab.
6. Accumulate any errors and write `{"objects": [], "errors": [...]}` to stdout.

## The Main Script (`server/webhook/register-doi.js`)

### Top-level structure

The file is ~480 lines with this shape:

- Lines 1-13: require `http`/`https`, parse `info.json` from `argv[2]`.
- Lines 15-41: buffer stdin, invoke `main()` when stdin ends, catch unhandled errors.
- Lines 43-334: `main()` — the whole orchestration.
- Lines 341-419: `resolveFieldPathAsync()` — dot-path resolution with fylr-specific fallbacks.
- Lines 424-437: `getNestedValue()` — simple dot-path getter.
- Lines 443-476: `httpRequest()` — Node stdlib HTTP wrapper returning a Promise.

There are commented-out `console.error` debug lines throughout. They are intentionally preserved for quick re-enablement during future debugging; do not delete them without a reason.

### `main()`

[register-doi.js:43-334](server/webhook/register-doi.js#L43-L334)

Orchestrates everything in a single async function:

1. **Parse stdin** ([L44-52](server/webhook/register-doi.js#L44-L52)) — the webhook body arrives as a JSON string on stdin. On parse failure, emit a JSON error and exit 1.
2. **Merge config from `info.json`** ([L54-60](server/webhook/register-doi.js#L54-L60)) — follows the pattern from the fylr plugin examples: if stdin data doesn't carry `info.config`, copy it from the parsed `info.json`. This makes the downstream `getNestedValue` call uniform.
3. **Read plugin config** ([L63-68](server/webhook/register-doi.js#L63-L68)) — extracts `info.config.plugin.fylr-plugin-datacite.config`. If missing, exit 0 with a config error (exit 0 because the webhook itself succeeded — the error is reported in the body).
4. **Read and validate `profileId`** ([L71-76](server/webhook/register-doi.js#L71-L76)) from the URL query parameter.
5. **Look up the profile** ([L79-85](server/webhook/register-doi.js#L79-L85)) by scanning `datacite_profiles.profiles` for a matching `id`.
6. **Filter field mappings** ([L88-89](server/webhook/register-doi.js#L88-L89)) by `profile_id === profileId`.
7. **Validate required fields** ([L92-101](server/webhook/register-doi.js#L92-L101)) — repository_id, password, doi_prefix must all be set. Findable DOIs additionally require a detail URL template ([L110-119](server/webhook/register-doi.js#L110-L119)).
8. **Read tokens and API URLs** ([L122-125](server/webhook/register-doi.js#L122-L125)) — `fylrApiUrl` prefers the internal URL (`info.api_url`) over the external one to avoid proxy interference; the access token prefers `plugin_user_access_token` and falls back to `api_user_access_token`.
9. **Compute the DataCite Basic Auth header** ([L128](server/webhook/register-doi.js#L128)).
10. **Loop over objects** ([L143-323](server/webhook/register-doi.js#L143-L323)):
    - Read `_system_object_id` and `_objecttype`.
    - For each field mapping: strip an optional `<objecttype>.` prefix from the dot-path (the UI sometimes includes it, sometimes not), pick `_current[objecttype]` as the root if it exists (richer data, closer to what a full object fetch would return), and resolve the path.
    - Construct the DOI as `<doi_prefix><system_object_id>`.
    - Construct the landing URL by substituting `%system_object_id%` in the template.
    - Build the DataCite payload (see [JSON:API payload format](#jsonapi-payload-format)). Note the defensive `:unkn` fallbacks — DataCite requires certain fields and rejects empty ones.
    - POST to DataCite. If 422, retry as PUT. Anything outside 2xx is recorded as an error and the object is skipped.
    - POST the publish entry back to fylr (see [fylr Publish Callback](#fylr-publish-callback)).
11. **Emit result** ([L332](server/webhook/register-doi.js#L332)) — always `{objects: [], errors: [...]}`. `objects: []` is the required shape for webhook responses; `errors` is added so the event viewer in the fylr UI shows what went wrong.

**Why `exit(0)` on config errors?** A non-zero exit causes fylr to treat the whole webhook invocation as failed and may hide the emitted JSON body. Emitting a structured error on stdout plus `exit(0)` gives cleaner admin-visible diagnostics.

### `resolveFieldPathAsync()`

[register-doi.js:341-419](server/webhook/register-doi.js#L341-L419)

Resolves a dot-separated path (e.g. `haustieranatomie.titel` or `hersteller.hersteller.name`) into a value. The logic has three subtleties that would not be obvious from the signature:

1. **fylr date fields are wrapped objects** (`{value: "2025-04-05"}`). At the end of the walk, if the result is an object with a `value` key, it is unwrapped ([L417](server/webhook/register-doi.js#L417)).
2. **The root is always `obj[objecttype]`** — fylr objects are keyed by objecttype at the top level. Passing in a bare object without that wrapper returns `undefined`.
3. **Linked objects are shallow in the webhook payload**. When an object links to another object, the webhook payload only carries `{_id, _version}` for the linked object. If a dot-path descends into a linked object (either directly navigating into its typed key or trying to access a missing field on a wrapper), the function fetches the full linked object via `GET /api/v1/db/<objecttype>/_all_fields/<id>?format=long` using the plugin user's Bearer token, then continues the walk.

Both linked-object-fetch branches record failures via the shared `warnings` array so the caller can decide how to surface them. Errors from fetches are never fatal; the path just returns `undefined` and the mapping falls back to its `default_value`.

### `getNestedValue()`

[register-doi.js:424-437](server/webhook/register-doi.js#L424-L437)

A straightforward dot-path getter used only for reading from `info.json` (e.g. `config.plugin.fylr-plugin-datacite.config`). It does **not** handle date objects or linked objects — that is `resolveFieldPathAsync`'s job. Kept as a separate helper because conflating the two would obscure the async I/O behavior.

### `httpRequest()`

[register-doi.js:443-476](server/webhook/register-doi.js#L443-L476)

A minimal Promise wrapper around Node's built-in `http`/`https.request`. Signature:

```javascript
httpRequest({ url, method, headers, body }) → Promise<{statusCode, body}>
```

Timeout is hardcoded at 60 seconds. Response bodies are buffered into a string (we never deal with large responses — DataCite replies are small JSON). No redirect following. No TLS customization.

We use a custom wrapper instead of `fetch` or `axios` for two reasons: the plugin runs in whatever Node version the fylr node-exec service ships (we don't assume modern `fetch`), and adding npm dependencies would complicate the zip build.

## DataCite API Integration

### JSON:API payload format

DataCite's REST API uses [JSON:API](https://jsonapi.org/). Every request body has the shape:

```json
{
  "data": {
    "type": "dois",
    "attributes": { ... }
  }
}
```

Required attributes for a create: `doi`, `prefix`, `creators`, `titles`, `publisher`, `publicationYear`, `types.resourceTypeGeneral`, `schemaVersion`. Our payload is constructed in [register-doi.js:183-214](server/webhook/register-doi.js#L183-L214). The `:unkn` literal is DataCite's convention for "unknown" in required fields — it passes validation when real data is missing.

Optional attributes added conditionally: `url` (landing page), `descriptions`, `contributors`, `subjects`. `subjects` accepts a comma-separated string and is split into an array.

### Create-or-update pattern (422 → PUT)

DataCite returns 422 if the DOI already exists. Rather than pre-checking existence (extra round trip, race condition), we optimistically POST first; on 422 we retry with PUT to `/dois/<doi>`. This makes the webhook idempotent — admins can re-fire the workflow without errors. See [L249-265](server/webhook/register-doi.js#L249-L265).

### Draft vs Findable DOIs

DOIs have three states in DataCite: Draft (default on create), Registered, and Findable (publicly resolvable). To create a Findable DOI directly, set `attributes.event = "publish"` ([L205-207](server/webhook/register-doi.js#L205-L207)). This is controlled by the `publish_as_findable` profile flag, which requires a `detail_url_template` because Findable DOIs must resolve to a real landing page.

## fylr Publish Callback

After DataCite accepts the DOI, we post a publish entry back to fylr at [L279-316](server/webhook/register-doi.js#L279-L316). This entry is what appears in the object's publish tab in the fylr UI.

```javascript
const publishPayload = [{
    _basetype: 'publish',
    publish: {
        system_object_id: systemObjectId,
        collector: collectorName,
        publish_uri: doiResolverUrl + '/' + doi,
        easydb_uri: landingUrl
    }
}];

const publishUrl = fylrApiUrl + '/api/v1/publish';
```

One aspect of this call is non-obvious enough to warrant its own section.

### Why the `_basetype` wrapper is required

The publish endpoint accepts an array of objects. Each object **must** be wrapped in `{_basetype: 'publish', publish: {...}}` — not flat. Sending a flat object produces `PublishUnknownCollector: collector ""` even when the collector field is set, because the API parser looks up the `collector` field inside the `publish` sub-object specifically.

This is not clearly documented in the public API docs. It is mentioned in the types part of the official docs though. If you change this payload shape, expect the same error class of bug.

Using the internal API URL (`info.api_url`) avoids any reverse-proxy interference.

## Error Handling and Logging

- **Errors surfaced to the fylr event viewer**: anything written to stderr appears there. We reserve stderr for genuine errors (unparseable input, unhandled exceptions, linked-object fetch failures).
- **Errors surfaced to the webhook response**: the final stdout output always includes an `errors` array listing per-object failures. This is the cleanest surface for admins to see what went wrong.
- **Commented `console.error` lines**: preserved throughout the script for ad-hoc debugging. Uncommenting them during development is the fastest way to see what the script is doing without reaching into fylr logs.
- **Structured JSON errors**: config problems produce `{error: {code, description}}` on stdout instead of the usual `{objects: [...]}` shape — this lets the admin UI parse and display them clearly.

## Common Maintenance Tasks

**Adding a new DataCite metadata field**: add mapping handling around [L184-214](server/webhook/register-doi.js#L184-L214), following the pattern of existing optional fields (`descriptions`, `contributors`, `subjects`). Admins then add rows in `datacite_field_mappings` with the new `datacite_field` name. No manifest changes needed because field names are free-form.

**Adding a new profile-level setting**: add the parameter to `manifest.master.yml` under `datacite_profiles.parameters.profiles.fields`, add l10n keys to `datacite-loca.csv`, and read it from `dataciteConfig` in `main()`.

**Changing the DataCite payload schema** (e.g. upgrading to kernel-5): update `schemaVersion` at [L194](server/webhook/register-doi.js#L194) and adjust attribute shapes accordingly.

**Testing without DataCite**: point `api_url` at `https://api.test.datacite.org` (DataCite's test server). The test server returns real responses but does not mint public DOIs.

**Rebuilding after changes**: `make zip`, upload the new zip in fylr admin UI, then click **Reload** on the plugin.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `datacite.config.missing_profile_id` | Webhook URL is missing `?repository=<id>` |
| `datacite.config.profile_not_found` | The `id` in the URL does not match any row in `datacite_profiles` |
| DataCite returns 401 | Bad `repository_id` / `password`, or wrong `api_url` (test vs production mismatch) |
| DataCite returns 422 with no retry success | The PUT update also failed — check the response body in the event viewer for the actual validation message |
| `PublishUnknownCollector: collector ""` | The `_basetype` wrapper got removed, or the `collector` field inside `publish` is empty, or the collector name doesn't match the one configured in fylr |
| Publish entry returns 401/403 | The plugin user in `datacite_global.api_user` lacks the `system.api.publish.post` right |
| Linked-object field resolves to `undefined` | Either the plugin user can't read the linked objecttype, or the path is wrong. Uncomment the linked-object `console.error` lines to see the failed fetch URL. |
| Admin UI shows raw l10n keys instead of labels | New parameter was added to `manifest.master.yml` but not to `datacite-loca.csv` |

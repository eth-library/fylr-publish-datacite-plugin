# fylr-plugin-datacite

Webhook plugin for [fylr](https://fylr.io) to register DOIs with [DataCite](https://datacite.org).

## How it works

When triggered via a workflow webhook, the plugin:

1. Reads the object data from the fylr webhook payload
2. Resolves configured field mappings to build the DataCite metadata record
3. Registers a DOI with the DataCite REST API (creates a new DOI or updates an existing one)
4. Posts the registered DOI back to the fylr publish API so it appears in the object's publish tab

## Installation

1. Download the latest release zip and upload it in the fylr admin UI under **Plugins**.
2. Reload the plugin.

## Configuration

All configuration is done in the fylr admin UI under **Base Configuration**.

### Global settings (`DataCite Global`)

| Field | Description |
|---|---|
| API User | The fylr user whose token is used for internal API calls. Needs the `system.api.publish.post` system right. |

### Profiles (`DataCite Profiles`)

Each row defines one DataCite repository. Multiple profiles can be configured and selected per webhook URL.

| Field | Description |
|---|---|
| ID | Internal identifier used in the webhook URL (`?repository=<id>`) |
| Repository ID | Your DataCite repository ID |
| Password | Your DataCite repository password |
| DOI Prefix | DOI prefix including trailing slash, e.g. `10.12345/` |
| API URL | DataCite API endpoint. Default: `https://api.test.datacite.org` (test). Use `https://api.datacite.org` for production. |
| Collector Name | Internal name of the collector as configured in the fylr base config publish settings |
| Publish as Findable | If enabled, the DOI is immediately published (findable). Requires a Detail URL Template. |
| Detail URL Template | URL template for the object's landing page. Use `%system_object_id%` as placeholder. |
| DOI Resolver URL | The first part of the URL that will be written in the publish entry in fylr. The URL setting in the collector base config will be ignored. |

### Field Mappings (`DataCite Field Mappings`)

Each row maps a DataCite metadata field to a field path in the fylr object. The `profile_id` column links the mapping to a specific profile.

| Field | Description |
|---|---|
| Profile ID | Must match the `ID` of a profile in the Profiles table |
| DataCite Field | Target field name. Supported: `title`, `creator`, `publisher`, `date`, `description`, `contributor`, `subjects`, `resourceTypeGeneral`, `publicationYear` |
| fylr Field Path | Dot-separated path to the field in the fylr object, e.g. `haustieranatomie.titel` |
| Default Value | Fallback value if the field path resolves to nothing |

## Webhook URL

Configure the webhook URL in the fylr admin UI under **Tags & Workflows**:

```
https://<your-fylr-instance>/api/v1/plugin/base/fylr-plugin-datacite/webhook/register-doi?repository=<profile-id>
```

The `?repository=` parameter selects which profile to use.

## Publish collector

Before the webhook can post publish entries back to fylr, a collector must be configured in the fylr base config under **Publish**. The **Internal Name** must match the **Collector Name** set in the profile.

## Requirements

- fylr with Node.js exec service
- A DataCite account with a registered repository and DOI prefix
- The API user configured in the plugin must have the `system.api.publish.post` system right

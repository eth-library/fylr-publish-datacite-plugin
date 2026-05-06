# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-05-06

### Added
- Possibility to choose DOI suffix between `systemobjectid`, `uuid` and custom fylr field

## [1.0.0] - 2026-04-14

### Added
- Initial release
- Multi-repository support: configure multiple DataCite repositories as profiles; select via `?repository=<id>` webhook URL parameter
- Configurable field mappings per profile linking fylr object fields to DataCite metadata fields
- Automatic DOI registration via DataCite REST API (JSON:API, kernel-4 schema)
- Idempotent create-or-update: POST on first registration, PUT on subsequent calls (422 → retry as PUT)
- Draft and Findable DOI modes (controlled by `publish_as_findable` profile flag)
- Automatic write-back of the registered DOI to the fylr publish tab
- Configurable DOI resolver URL per profile (default: `https://doi.org`)
- Linked-object traversal: field paths can cross object references, fetching the linked object from the fylr API as needed
- Configurable landing page URL template with `%system_object_id%` placeholder

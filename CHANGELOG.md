# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-11

### Added
- Expression syntax for `fylr Field Path`: combine multiple fields and static strings using `+` (e.g. `"Label: " + objecttype.field1 + "\n" + objecttype.field2`)
- String literals with escape sequences (`\n` newline, `\t` tab) in field path expressions
- Conditional groups `(...)`: if any field inside a group is empty, the entire group — including its static labels — is omitted from the output
- `|decimal2` format specifier for fixed-point integer fields stored as ×100 (e.g. `2030` → `20.30`)
- Support for nested table fields in dot-path resolution: paths now traverse through fylr's `_nested:<objecttype>__<fieldname>` array keys automatically

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

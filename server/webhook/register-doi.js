const https = require('https');
const http = require('http');

// Parse info.json from command line argument
let info;
if (process.argv.length >= 3) {
    try {
        info = JSON.parse(process.argv[2]);
    } catch (e) {
        console.error('Unable to parse info.json argument:', e.message);
        process.exit(1);
    }
}

// Read stdin
let input = '';
process.stdin.on('data', d => {
    try {
        input += d.toString();
    } catch (e) {
        console.error(`Could not read input into string: ${e.message}`, e.stack);
        process.exit(1);
    }
});

process.stdin.on('end', () => {
    (async () => {
        try {
            await main();
        } catch (e) {
            console.error('Unhandled error:', e.message, e.stack);
            console.log(JSON.stringify({
                "error": {
                    "code": "datacite.unhandled_error",
                    "description": e.message
                }
            }));
            process.exit(1);
        }
    })();
});

async function main() {
    // Parse stdin payload
    let data;
    try {
        data = JSON.parse(input);
    } catch (e) {
        console.error('Could not parse stdin input:', e.message);
        console.log(JSON.stringify({ "error": { "code": "datacite.invalid_input", "description": "Invalid JSON input" } }));
        process.exit(1);
    }

    // Merge config from info.json if not present in stdin (webhook pattern)
    if (!data.info) {
        data.info = {};
    }
    if (!data.info.config && info && info.config) {
        data.info.config = info.config;
    }

    // Extract plugin config
    const pluginConfig = getNestedValue(info || data.info, 'config.plugin.fylr-plugin-datacite.config');
    if (!pluginConfig) {
        console.error('Plugin config not found in info.json');
        console.log(JSON.stringify({ "error": { "code": "datacite.config.not_found", "description": "Plugin configuration not found" } }));
        process.exit(0);
    }

    const dataciteConfig = pluginConfig.datacite || {};
    const mappingConfig = pluginConfig.datacite_mapping || {};
    const fieldMappings = mappingConfig.field_mapping || [];

    // Validate required config
    if (!dataciteConfig.repository_id || !dataciteConfig.password || !dataciteConfig.doi_prefix) {
        console.error('Missing required DataCite config (repository_id, password, doi_prefix)');
        console.log(JSON.stringify({
            "error": {
                "code": "datacite.config.missing",
                "description": "Required configuration missing: repository_id, password, and doi_prefix must be set"
            }
        }));
        process.exit(0);
    }

    const apiUrl = dataciteConfig.api_url || 'https://api.test.datacite.org';
    const collectorName = dataciteConfig.collector_name || 'datacite';
    const publishAsFindable = dataciteConfig.publish_as_findable || false;
    const detailUrlTemplate = dataciteConfig.detail_url_template || '';

    // Validate findable requires detail URL
    if (publishAsFindable && !detailUrlTemplate) {
        console.error('publish_as_findable requires detail_url_template to be set');
        console.log(JSON.stringify({
            "error": {
                "code": "datacite.config.missing_url",
                "description": "Publishing as Findable requires a Detail URL Template"
            }
        }));
        process.exit(0);
    }

    // Get access tokens for fylr API callbacks
    const fylrApiUrl = (info && info.api_url) || '';
    const accessToken = (info && info.plugin_user_access_token) || (info && info.api_user_access_token) || '';

    // DataCite Basic Auth header
    const dataciteAuth = 'Basic ' + Buffer.from(dataciteConfig.repository_id + ':' + dataciteConfig.password).toString('base64');

    const objects = data.objects || [];
    if (objects.length === 0) {
        console.error('No objects to process');
        console.log(JSON.stringify({ "objects": [] }));
        process.exit(0);
    }

    console.error(`Processing ${objects.length} object(s) for DOI registration`);

    const results = [];
    const errors = [];
    const fetchDebugLog = [];

    for (const obj of objects) {
        const systemObjectId = obj._system_object_id;
        const objecttype = obj._objecttype;

        if (!systemObjectId || !objecttype) {
            console.error('Object missing _system_object_id or _objecttype, skipping');
            errors.push({ system_object_id: systemObjectId, error: 'Missing _system_object_id or _objecttype' });
            continue;
        }

        console.error(`Processing object ${systemObjectId} (type: ${objecttype})`);

        // Resolve field mappings
        const mappedFields = {};
        for (const mapping of fieldMappings) {
            const dataciteField = mapping.datacite_field;
            const fylrPath = mapping.fylr_field_path;
            const defaultValue = mapping.default_value;

            if (!dataciteField) continue;

            // Strip objecttype prefix if present (e.g. "haustieranatomie.titel" -> "titel")
            let resolvedPath = fylrPath;
            if (resolvedPath && resolvedPath.startsWith(objecttype + '.')) {
                resolvedPath = resolvedPath.slice(objecttype.length + 1);
            }

            // Prefer _current which contains the full field data; fall back to top-level obj
            const sourceObj = (obj._current && obj._current[objecttype]) ? obj._current : obj;
            const resolvedValue = await resolveFieldPathAsync(sourceObj, objecttype, resolvedPath, fylrApiUrl, accessToken, fetchDebugLog);
            mappedFields[dataciteField] = resolvedValue || defaultValue || '';
        }

        // Construct DOI
        const doi = dataciteConfig.doi_prefix + systemObjectId;
        const doiPrefix = doi.split('/')[0];

        // Construct landing URL
        const landingUrl = detailUrlTemplate.replace(/%system_object_id%/g, systemObjectId);

        // Build DataCite JSON:API payload
        const datacitePayload = {
            data: {
                type: "dois",
                attributes: {
                    doi: doi,
                    prefix: doiPrefix,
                    creators: [{ name: mappedFields.creator || "Unknown" }],
                    titles: [{ title: mappedFields.title || "Untitled" }],
                    publisher: { name: mappedFields.publisher || "Unknown" },
                    publicationYear: (() => { const s = mappedFields.publicationYear || mappedFields.date || ''; return parseInt(s) || (s ? new Date(s).getFullYear() : null) || new Date().getFullYear(); })(),
                    types: { resourceTypeGeneral: mappedFields.resourceTypeGeneral || mappedFields.type || "Dataset" },
                    schemaVersion: "http://datacite.org/schema/kernel-4"
                }
            }
        };

        // Set URL if available
        if (landingUrl) {
            datacitePayload.data.attributes.url = landingUrl;
        }

        // Set event for findable DOIs
        if (publishAsFindable) {
            datacitePayload.data.attributes.event = "publish";
        }

        // Optional description
        if (mappedFields.description) {
            datacitePayload.data.attributes.descriptions = [
                { description: mappedFields.description, descriptionType: "Abstract" }
            ];
        }

        // Optional contributor
        if (mappedFields.contributor) {
            datacitePayload.data.attributes.contributors = [
                { name: mappedFields.contributor, contributorType: "Other" }
            ];
        }

        // Optional subjects
        if (mappedFields.subjects) {
            const subjects = String(mappedFields.subjects).split(',').map(s => ({ subject: s.trim() }));
            datacitePayload.data.attributes.subjects = subjects;
        }

        console.error(`Creating DOI ${doi} at ${apiUrl}/dois`);

        // POST to DataCite REST API
        let dataciteResponse;
        try {
            dataciteResponse = await httpRequest({
                url: apiUrl + '/dois',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/vnd.api+json',
                    'Authorization': dataciteAuth
                },
                body: JSON.stringify(datacitePayload)
            });
        } catch (e) {
            console.error(`DataCite API request failed for object ${systemObjectId}: ${e.message}`);
            errors.push({ system_object_id: systemObjectId, error: `DataCite request failed: ${e.message}` });
            continue;
        }

        // If DOI already exists (422), try PUT to update
        if (dataciteResponse.statusCode === 422) {
            console.error(`DOI ${doi} already exists, attempting update via PUT`);
            try {
                dataciteResponse = await httpRequest({
                    url: apiUrl + '/dois/' + encodeURIComponent(doi),
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/vnd.api+json',
                        'Authorization': dataciteAuth
                    },
                    body: JSON.stringify(datacitePayload)
                });
            } catch (e) {
                console.error(`DataCite PUT update failed for object ${systemObjectId}: ${e.message}`);
                errors.push({ system_object_id: systemObjectId, error: `DataCite update failed: ${e.message}` });
                continue;
            }
        }

        if (dataciteResponse.statusCode >= 200 && dataciteResponse.statusCode < 300) {
            console.error(`DOI ${doi} registered successfully (status: ${dataciteResponse.statusCode})`);
        } else {
            console.error(`DataCite API error for object ${systemObjectId}: ${dataciteResponse.statusCode} ${dataciteResponse.body}`);
            errors.push({
                system_object_id: systemObjectId,
                error: `DataCite API returned ${dataciteResponse.statusCode}: ${dataciteResponse.body}`
            });
            continue;
        }

        // POST publish entry back to fylr
        if (fylrApiUrl && accessToken) {
            const publishPayload = [{
                system_object_id: systemObjectId,
                collector: collectorName,
                publish_uri: 'https://doi.org/' + doi,
                easydb_uri: landingUrl
            }];

            console.error(`Posting publish entry to ${fylrApiUrl}/api/v1/publish`);

            try {
                const publishResponse = await httpRequest({
                    url: fylrApiUrl + '/api/v1/publish',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + accessToken
                    },
                    body: JSON.stringify(publishPayload)
                });

                if (publishResponse.statusCode >= 200 && publishResponse.statusCode < 300) {
                    console.error(`Publish entry created for object ${systemObjectId}`);
                    results.push({
                        system_object_id: systemObjectId,
                        doi: doi,
                        publish_uri: 'https://doi.org/' + doi
                    });
                } else {
                    console.error(`fylr publish API error: ${publishResponse.statusCode} ${publishResponse.body}`);
                    // DOI was already created at DataCite, so still count as partial success
                    results.push({
                        system_object_id: systemObjectId,
                        doi: doi,
                        publish_uri: 'https://doi.org/' + doi,
                        warning: 'DOI created but fylr publish entry failed'
                    });
                }
            } catch (e) {
                console.error(`fylr publish API request failed: ${e.message}`);
                results.push({
                    system_object_id: systemObjectId,
                    doi: doi,
                    publish_uri: 'https://doi.org/' + doi,
                    warning: 'DOI created but fylr publish entry failed: ' + e.message
                });
            }
        } else {
            console.error('No fylr API URL or access token available, skipping publish entry');
            results.push({
                system_object_id: systemObjectId,
                doi: doi,
                publish_uri: 'https://doi.org/' + doi,
                warning: 'No API URL or access token for publish callback'
            });
        }
    }

    // Log summary
    console.error(`Done. ${results.length} DOI(s) registered, ${errors.length} error(s)`);
    if (errors.length > 0) {
        console.error('Errors:', JSON.stringify(errors));
    }

    // Output result summary (objects array is always empty as we don't modify objects)
    console.log(JSON.stringify({ "objects": [], "processed": results.length, "errors": errors, "fetch_debug": fetchDebugLog }));
    process.exit(0);
}

/**
 * Like resolveFieldPath but handles fylr date objects ({value: "..."})
 * and fetches linked objects from the fylr API when the path goes deeper
 * than what the webhook payload includes.
 */
async function resolveFieldPathAsync(obj, objecttype, dotPath, fylrApiUrl, accessToken, debugLog) {
    if (!dotPath || dotPath.trim() === '') return undefined;
    if (!obj || !objecttype || !obj[objecttype]) return undefined;

    const parts = dotPath.split('.');
    let current = obj[objecttype];

    for (let i = 0; i < parts.length; i++) {
        if (current === null || current === undefined) return undefined;

        const part = parts[i];

        if (typeof current !== 'object') return undefined;

        // If current is a linked object wrapper and we're navigating into its type-keyed
        // inner object (e.g. hersteller.hersteller.name), fetch the full object first
        // because the inner object only has {_id, _version} in standard format.
        if (current._objecttype && current._system_object_id && part === current._objecttype && fylrApiUrl && accessToken) {
            const innerId = current[current._objecttype] && current[current._objecttype]._id;
            const fetchUrl = `${fylrApiUrl}/api/v1/db/${current._objecttype}/_all_fields/${innerId}?format=long`;
            try {
                const resp = await httpRequest({
                    url: fetchUrl,
                    method: 'GET',
                    headers: { 'Authorization': 'Bearer ' + accessToken }
                });
                if (debugLog) debugLog.push({ fetch_url: fetchUrl, status: resp.statusCode, body_snippet: resp.body.slice(0, 300) });
                if (resp.statusCode === 200) {
                    const fetched = JSON.parse(resp.body);
                    const fetchedObj = (fetched.objects || [])[0] || fetched;
                    const inner = fetchedObj && fetchedObj[current._objecttype];
                    if (inner) {
                        current = inner;
                        continue;
                    }
                }
            } catch (e) {
                if (debugLog) debugLog.push({ fetch_error: e.message, fetch_url: fetchUrl });
            }
        }

        if (!(part in current)) {
            // If current is a linked object wrapper, fetch the full object and retry
            if (current._objecttype && current._system_object_id && fylrApiUrl && accessToken) {
                const innerId = current[current._objecttype] && current[current._objecttype]._id;
            const fetchUrl = `${fylrApiUrl}/api/v1/db/${current._objecttype}/_all_fields/${innerId}?format=long`;
                try {
                    const resp = await httpRequest({
                        url: fetchUrl,
                        method: 'GET',
                        headers: { 'Authorization': 'Bearer ' + accessToken }
                    });
                    if (debugLog) debugLog.push({ fetch_url: fetchUrl, status: resp.statusCode, body_snippet: resp.body.slice(0, 300) });
                    if (resp.statusCode === 200) {
                        const fetched = JSON.parse(resp.body);
                        const fetchedObj = (fetched.objects || [])[0] || fetched;
                        const inner = fetchedObj && fetchedObj[current._objecttype];
                        if (inner && part in inner) {
                            current = inner[part];
                            continue;
                        }
                        if (debugLog) debugLog.push({ fetch_inner_keys: inner ? Object.keys(inner).join(',') : 'null', looking_for: part });
                    }
                } catch (e) {
                    if (debugLog) debugLog.push({ fetch_error: e.message, fetch_url: fetchUrl });
                }
            }
            return undefined;
        }

        current = current[part];
    }

    if (current === null || current === undefined) return undefined;
    // Unwrap fylr date objects: { value: "2025-04-05" }
    if (typeof current === 'object' && 'value' in current) return current.value != null ? String(current.value) : undefined;
    return String(current);
}

/**
 * Get a nested value from an object using a dot-separated path.
 */
function getNestedValue(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        if (typeof current === 'object' && part in current) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

/**
 * Make an HTTP/HTTPS request using built-in Node.js modules.
 * Returns a Promise resolving to {statusCode, body}.
 */
function httpRequest({ url, method, headers, body }) {
    return new Promise((resolve, reject) => {
        const parsedURL = new URL(url);
        const client = parsedURL.protocol === 'https:' ? https : http;
        const options = {
            method: method || 'GET',
            headers: headers || {},
            timeout: 60000
        };

        const req = client.request(url, options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    body: responseData
                });
            });
            res.on('error', reject);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.on('error', reject);

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

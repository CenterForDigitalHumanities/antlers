/**
 * @module rerum The only core module that touches the network.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Consolidates the fetches scattered across the 0.11 runtime
 * (deer-render.js, deer-record.js, deer-utils.js) behind one surface.
 * Reads go straight to RERUM; writes go through the deployment's TinyNode
 * proxy (config.URLS).  HTTP contract, confirmed against the 0.11 runtime:
 * CREATE is POST, UPDATE/OVERWRITE are PUT, and tiny proxy responses wrap
 * the result in `new_obj_state`.
 */

import config from './config.js'

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }

const fetcher = (...args) => (config.fetch ?? globalThis.fetch)(...args)

/**
 * Pull a usable URI out of a string or an object bearing `@id`/`id`.
 * @param {String|Object} entity the id string or an object carrying one.
 * @returns {String} the URI.
 * @throws {TypeError} when no URI can be found.
 */
export function idOf(entity) {
    const id = (typeof entity === "string") ? entity : entity?.["@id"] ?? entity?.id
    if (typeof id !== "string" || id.length === 0) {
        throw new TypeError(`Unable to find URI in ${JSON.stringify(entity)}`)
    }
    return id
}

/**
 * The canonical (https) form of an id.  RERUM records ids with whichever
 * protocol the writing proxy sent, so every comparison, request, and map key
 * must normalize through this first.
 * @param {String} id the URI to normalize.
 * @returns {String} the https form.
 */
export function canonicalId(id) {
    return (typeof id === "string") ? id.replace(/^https?:/, 'https:') : id
}

/**
 * RERUM records ids with whichever protocol the writing proxy sent, so queries
 * must match both forms.
 * @param {String} id the URI to vary.
 * @returns {Object} a Mongo-style `$in` clause over the http and https forms.
 */
export function httpsIdArray(id) {
    return { $in: [canonicalId(id), id.replace(/^https?:/, 'http:')] }
}

/**
 * Is this id hosted by RERUM (and so eligible for the server `/expanded` path)?
 * Independent of which TinyNode proxy handles writes — proxies write into
 * RERUM, so entity ids stay on config.ID_BASES.
 * @param {String} id the URI to test.
 * @returns {Boolean}
 */
export function isRerumId(id) {
    if (typeof id !== "string") { return false }
    const httpsId = canonicalId(id)
    return config.ID_BASES.some(base => httpsId.startsWith(base))
}

function handleResponse(response) {
    if (!response.ok) {
        throw Object.assign(
            new Error(`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""}`),
            { status: response.status }
        )
    }
    return response.json()
}

/**
 * GET a single document by URI.
 * @param {String|Object} id the document URI (or an object carrying one).
 * @param {Object} options `fresh: true` busts the HTTP cache — required for any
 * read that follows a write and for form prefill.
 * @returns {Promise<Object>} the document.
 */
export function resolve(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    return fetcher(uri, fresh ? { cache: "reload" } : {}).then(handleResponse)
}

/**
 * GET the server-side annotation merge for a RERUM-hosted entity.
 * `generator` is REQUIRED: the server applies no default filter, and an
 * unfiltered request merges annotations from every application that ever
 * targeted the entity.  Resolution order: explicit argument, else
 * config.GENERATOR.  Do not simplify this requirement away.
 * @param {String|Object} id the entity URI (or an object carrying one).
 * @param {Object} options `generator` (RERUM agent URI), `fresh` (bust HTTP cache).
 * @returns {Promise<Object>} the entity with annotations merged in.  The server
 * drops every annotation `@id`, so this response has no provenance.
 */
export async function expanded(id, { generator = config.GENERATOR, fresh = false } = {}) {
    if (!generator) {
        throw new TypeError("expanded() requires a generator. Pass { generator } or set config.GENERATOR — the server applies no default filter and would merge annotations from every application.")
    }
    const uri = canonicalId(idOf(id))
    const url = `${uri}/expanded?generator=${encodeURIComponent(generator)}`
    return fetcher(url, fresh ? { cache: "reload" } : {}).then(handleResponse)
}

/**
 * POST a Mongo-style query to the deployment's TinyNode proxy.
 * @param {Object} body the query document.
 * @param {Object} options `limit`/`skip` paging (config defaults), `fresh`.
 * @returns {Promise<Array<Object>>} matching documents.
 */
export async function query(body, { limit = config.LIMIT, skip = config.SKIP, fresh = false } = {}) {
    // URL-object building replaces (not duplicates) any limit/skip already baked
    // into an implementer's configured QUERY URL.  The document base matters:
    // the 0.11 config shape is protocol-relative ("//tinydev.rerum.io/app/query",
    // deer-config.js:31) and a same-origin proxy is configured as "/app/query" —
    // fetch() accepts both, and new URL() without a base rejects both.
    const url = new URL(config.URLS.QUERY, globalThis.location?.href)
    url.searchParams.set("limit", limit)
    url.searchParams.set("skip", skip)
    return fetcher(url.toString(), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        ...(fresh ? { cache: "reload" } : {})
    }).then(handleResponse)
}

/**
 * Query for the leaf-version annotations targeting an id, matching every
 * target style the 0.11 runtime matched (`target`, `target.@id`, `target.id`)
 * in both protocol forms.
 * @param {String|Object} id URI of the targeted entity.
 * @param {Object} options passed through to query().
 * @returns {Promise<Array<Object>>} targeting documents (callers filter to Annotation types).
 */
export function findByTargetId(id, options = {}) {
    const uris = httpsIdArray(idOf(id))
    const body = {
        "$or": [{ "target": uris }, { "target.@id": uris }, { "target.id": uris }],
        "__rerum.history.next": { "$exists": true, "$size": 0 }
    }
    return query(body, options)
}

function write(url, method, obj) {
    return fetcher(url, {
        method,
        headers: JSON_HEADERS,
        body: JSON.stringify(obj)
    })
        .then(handleResponse)
        .then(data => data.new_obj_state ?? data)
}

/**
 * Create a new document through the TinyNode proxy.
 * @param {Object} obj the document to create.
 * @returns {Promise<Object>} the created document (unwrapped from `new_obj_state`).
 */
export function create(obj) {
    return write(config.URLS.CREATE, "POST", obj)
}

/**
 * Update a document through the TinyNode proxy, creating a new version.
 * @param {Object} obj the document, carrying the `@id` to update.
 * @returns {Promise<Object>} the new version (unwrapped from `new_obj_state`).
 */
export function update(obj) {
    return write(config.URLS.UPDATE, "PUT", obj)
}

/**
 * Overwrite a document in place through the TinyNode proxy.
 * @param {Object} obj the document, carrying the `@id` to overwrite.
 * @returns {Promise<Object>} the overwritten document (unwrapped from `new_obj_state`).
 */
export function overwrite(obj) {
    return write(config.URLS.OVERWRITE, "PUT", obj)
}

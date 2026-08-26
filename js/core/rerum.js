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
 *
 * This module also owns the cache-mode policy.  A write records every URI it
 * invalidated -- the document itself, and for an Annotation every entity it
 * targets, whose `/expanded` merge just changed.  The next read of each
 * affected URL forces `{cache: 'reload'}` once, so read-after-write is correct
 * without every call site having to remember to ask for it.
 */

import config from './config.js'

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }

const fetcher = (...args) => (config.fetch ?? globalThis.fetch)(...args)

/**
 * URIs invalidated by a write, mapped to the request URLs already refreshed for
 * them.  One id can be read through several URLs (the document itself and its
 * `/expanded` merge are separate cache entries), so each gets its own forced
 * reload rather than the first read consuming the invalidation for all of them.
 */
const staleIds = new Map()

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

/**
 * Resolve a configured URL to an absolute one.  Every URL this module requests
 * goes through here, so a deployment may configure URLS relative as long as it
 * sets config.BASE.  Relying on an ambient document base is the fallback, not
 * the contract — outside a browser there is none, and a relative value would
 * otherwise fail deep inside fetch with an opaque message.
 * @param {String} url the configured URL, absolute or relative.
 * @returns {String} the absolute URL.
 * @throws {TypeError} when a relative URL has no base to resolve against.
 */
function absoluteUrl(url) {
    const base = config.BASE ?? globalThis.location?.href
    try {
        return new URL(url, base).toString()
    } catch (err) {
        throw new TypeError(`Cannot resolve '${url}' to an absolute URL${base ? ` against '${base}'` : " (no config.BASE and no document base)"}. Configure an absolute URL or set config.BASE.`)
    }
}

/**
 * Record that a write invalidated these URIs.  Existing refresh bookkeeping for
 * a URI is discarded, so a second write re-invalidates every URL again.
 */
function markStale(...ids) {
    for (const id of ids.flat(3)) {
        const uri = (typeof id === "string") ? id : (id?.["@id"] ?? id?.id)
        if (typeof uri === "string" && uri.length > 0) { staleIds.set(canonicalId(uri), new Set()) }
    }
}

/**
 * Does this read need to bust the HTTP cache?  True once per request URL per
 * write, so the first read after a write revalidates and later reads are served
 * from the refreshed cache entry.
 */
function needsReload(uri, url) {
    const refreshed = staleIds.get(canonicalId(uri))
    if (refreshed === undefined || refreshed.has(url)) { return false }
    refreshed.add(url)
    return true
}

async function handleResponse(response) {
    if (!response.ok) {
        throw Object.assign(
            new Error(`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""} — ${response.url}`),
            { status: response.status, url: response.url }
        )
    }
    try {
        return await response.json()
    } catch (err) {
        // A foreign URI is not obliged to serve JSON.  Say which URI and what it
        // sent instead of surfacing the parser's "Unexpected token '<'".
        throw Object.assign(
            new Error(`Expected JSON from ${response.url} but the body could not be parsed (content-type: ${response.headers.get("content-type") ?? "none"}).`),
            { status: response.status, url: response.url, cause: err }
        )
    }
}

/**
 * GET a single document by URI.
 * @param {String|Object} id the document URI (or an object carrying one).
 * @param {Object} options `fresh: true` busts the HTTP cache.  A read that
 * follows a write of this URI busts it automatically.
 * @returns {Promise<Object>} the document.
 */
export function resolve(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    const reload = fresh || needsReload(uri, uri)
    return fetcher(uri, reload ? { cache: "reload" } : {}).then(handleResponse)
}

/**
 * GET the server-side annotation merge for a RERUM-hosted entity.
 * `generator` is REQUIRED: the server applies no default filter, and an
 * unfiltered request merges annotations from every application that ever
 * targeted the entity.  Resolution order: explicit argument, else
 * config.GENERATOR.  Do not simplify this requirement away.
 * @param {String|Object} id the entity URI (or an object carrying one).
 * @param {Object} options `generator` (RERUM agent URI), `fresh` (bust HTTP cache).
 * @returns {Promise<Object>} `{document, gathered, merged}`.  The counts come
 * from the `Annotations-Gathered` / `Annotations-Merged` response headers and
 * are NaN if a deployment does not send them.  They disagree when the server
 * declined to merge something it found, which callers must handle — the server
 * merges only single-key object bodies.  The document itself carries no
 * annotation `@id`s, so this read has no provenance.
 */
export async function expanded(id, { generator = config.GENERATOR, fresh = false } = {}) {
    if (!generator) {
        throw new TypeError("expanded() requires a generator. Pass { generator } or set config.GENERATOR — the server applies no default filter and would merge annotations from every application.")
    }
    const uri = canonicalId(idOf(id))
    const url = `${uri}/expanded?generator=${encodeURIComponent(generator)}`
    const reload = fresh || needsReload(uri, url)
    const response = await fetcher(url, reload ? { cache: "reload" } : {})
    const document = await handleResponse(response)
    return {
        document,
        gathered: Number(response.headers.get("Annotations-Gathered")),
        merged: Number(response.headers.get("Annotations-Merged"))
    }
}

/**
 * POST a Mongo-style query to the deployment's TinyNode proxy.
 * There is no `fresh` option: a POST response is never served from the HTTP
 * cache, so every query is already a live read.
 * @param {Object} body the query document.
 * @param {Object} options `limit`/`skip` paging (config defaults).
 * @returns {Promise<Array<Object>>} matching documents.
 */
export async function query(body, { limit = config.LIMIT, skip = config.SKIP } = {}) {
    // URL-object building replaces (not duplicates) any limit/skip already baked
    // into an implementer's configured QUERY URL.
    const url = new URL(absoluteUrl(config.URLS.QUERY))
    url.searchParams.set("limit", limit)
    url.searchParams.set("skip", skip)
    return fetcher(url.toString(), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body)
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
export async function findByTargetId(id, options = {}) {
    const uri = idOf(id)
    const uris = httpsIdArray(uri)
    const body = {
        "$or": [{ "target": uris }, { "target.@id": uris }, { "target.id": uris }],
        "__rerum.history.next": { "$exists": true, "$size": 0 }
    }
    const limit = options.limit ?? config.LIMIT
    const finds = await query(body, { ...options, limit })
    if (Array.isArray(finds) && finds.length >= limit) {
        // Not gated behind DEBUG: a dropped annotation costs the editing path a
        // citationSource, and a missing citationSource makes the next save POST
        // a duplicate assertion instead of updating the existing one.
        console.warn(`${uri}: annotation query returned a full page (limit ${limit}). Annotations beyond the limit are not merged and their provenance is lost — a form prefilled from this read may create duplicate assertions.`)
    }
    return finds
}

function write(url, method, obj) {
    return fetcher(absoluteUrl(url), {
        method,
        headers: JSON_HEADERS,
        body: JSON.stringify(obj)
    })
        .then(handleResponse)
        .then(data => data.new_obj_state ?? data)
        .then(saved => {
            // The written document's own cached read is stale, and so is every
            // entity it targets — writing an Annotation changes the `/expanded`
            // merge of its target.
            markStale(saved, obj, saved?.target, obj?.target)
            return saved
        })
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

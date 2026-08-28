/**
 * @module rerum The only core module that touches the network.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Consolidates the fetches behind one surface.
 * Reads go straight to RERUM; writes go through the deployment's TinyNode
 * proxy (config.URLS).
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
 * URIs invalidated by a write.  An entry expires on a TIMESTAMP.
 */
const staleIds = new Map()

/**
 * How long a write's invalidation is honored.  
 * RERUM sends `Cache-Control: max-age=86400, must-revalidate`.
 *
 * `GET /v1/id/:_id` and its `/expanded` merge.  That is the window.
 */
const STALE_TTL_MS = 86_400_000

/**
 * Backstop for a session that writes more distinct URIs within one TTL than it
 * reads back.  Every entry shares one TTL, so insertion order IS expiry order
 * and the soonest-expiring entry goes first.
 */
const STALE_LIMIT = 500

/**
 * Pull a usable URI out of a string or an object bearing `@id`/`id`.
 *
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
 *
 * @param {String} id the URI to normalize.
 * @returns {String} the https form.
 */
export function canonicalId(id) {
    return (typeof id === "string") ? id.replace(/^https?:/, 'https:') : id
}

/**
 * RERUM records ids with whichever protocol the writing proxy sent, so queries
 * must match both forms.
 *
 * @param {String} id the URI to vary.
 * @returns {Object} a Mongo-style `$in` clause over the http and https forms.
 */
export function httpsIdArray(id) {
    return { $in: [canonicalId(id), id.replace(/^https?:/, 'http:')] }
}

/**
 * The second URI a record with a RERUM Slug answers to — the record's own URI up to
 * its last slash, plus the slug.
 *
 * @param {Object} doc a resolved RERUM document.
 * @returns {String|undefined} the slug URI as spelled by the document's own
 * URI, or undefined when there is no slug or no usable URI.  NOT canonicalized;
 * callers that key on it normalize through canonicalId like any other key.
 */
export function slugUriOf(doc) {
    const slug = doc?.__rerum?.slug
    if (typeof slug !== "string" || slug.length === 0) { return undefined }
    const own = doc?.["@id"] ?? doc?.id
    const lastSlash = (typeof own === "string") ? own.lastIndexOf("/") : -1
    return (lastSlash === -1) ? undefined : own.slice(0, lastSlash + 1) + slug
}

/**
 * The deployment's RERUM agent, or a clear failure.  DEER has exactly ONE:
 * config.GENERATOR.  Every read filters annotations by it.
 *
 * @returns {String} the generator URI.
 * @throws {TypeError} when no generator is configured.
 */
function requireGenerator() {
    if (!config.GENERATOR) {
        throw new TypeError("A generator is required. Set config.GENERATOR — no read applies a default filter, and an unfiltered read merges annotations from every application that ever targeted the entity.")
    }
    return config.GENERATOR
}

/**
 * The query clause matching this deployment's annotations, in both protocol
 * forms.
 *
 * @returns {Object} a Mongo-style `$in` clause over the http and https forms.
 * @throws {TypeError} when no generator is configured.
 */
export function generatedBy() {
    return httpsIdArray(requireGenerator())
}

/**
 * DEER only supports data hosted by RERUM and nothing else, so this is the
 * support gate.  Entity ids stay on config.ID_BASES.
 *
 * @param {String} id the URI to test.
 * @returns {Boolean}
 */
export function isRerumId(id) {
    if (typeof id !== "string") { return false }
    let url
    try {
        url = new URL(canonicalId(id))
    } catch {
        return false
    }
    if (url.search || url.hash) { return false }
    if (url.pathname.endsWith("/")) { return false }
    return config.ID_BASES.some(base => url.href.startsWith(base) && url.href.length > base.length)
}

/**
 * Resolve a configured URL to an absolute one.  Every URL this module requests
 * goes through here, so a deployment may configure URLS relative as long as it
 * sets config.BASE.  Relying on an ambient document base is the fallback, not
 * the contract — outside a browser there is none, and a relative value would
 * otherwise fail deep inside fetch with an opaque message.
 *
 * @param {String} url the configured URL, absolute or relative.
 * @returns {String} the absolute URL.
 * @throws {TypeError} when a relative URL has no base to resolve against.
 */
function absoluteUrl(url) {
    const base = config.BASE ?? globalThis.document?.baseURI ?? globalThis.location?.href
    try {
        return new URL(url, base).toString()
    } catch (err) {
        throw new TypeError(`Cannot resolve '${url}' to an absolute URL${base ? ` against '${base}'` : " (no config.BASE and no document base)"}. Configure an absolute URL or set config.BASE.`, { cause: err })
    }
}

/**
 * Record that a write invalidated these URIs.  Existing refresh bookkeeping for
 * a URI is discarded, so a second write re-invalidates every URL again.
 * Non-RERUM URIs are skipped.
 */
function markStale(...ids) {
    const expires = Date.now() + STALE_TTL_MS
    for (const id of ids.flat(3)) {
        const uri = (typeof id === "string") ? id
            : (id?.["@id"] ?? id?.id
                ?? ((typeof id?.source === "string") ? id.source : id?.source?.["@id"] ?? id?.source?.id))
        if (typeof uri !== "string" || uri.length === 0) { continue }
        if (!isRerumId(uri)) { continue }
        const key = canonicalId(uri)
        staleIds.delete(key)
        staleIds.set(key, { expires, refreshed: new Set() })
    }
    sweepStale()
}

/** Drop invalidations that have outlived any cache entry they could apply to. */
function sweepStale() {
    const now = Date.now()
    for (const [key, entry] of staleIds) {
        // One shared TTL means insertion order is expiry order, so the first
        // entry still in date ends the sweep.
        if (entry.expires > now) { break }
        staleIds.delete(key)
    }
    while (staleIds.size > STALE_LIMIT) { staleIds.delete(staleIds.keys().next().value) }
}

/**
 * Checks if this read should bust the HTTP cache.  True until a read of this
 * request URL comes back USABLE after the write — ok and parsed, which is what
 * markRefreshed records — so neither an HTTP failure nor an unparseable body
 * spends the invalidation.
 */
function needsReload(uri, url) {
    const key = canonicalId(uri)
    const entry = staleIds.get(key)
    if (entry === undefined) { return false }
    if (entry.expires <= Date.now()) {
        staleIds.delete(key)
        return false
    }
    return !entry.refreshed.has(url)
}

/**
 * Record that a cache-busting read of this request URL succeeded, so later
 * reads are served from the refreshed cache entry.
 */
function markRefreshed(uri, url) {
    staleIds.get(canonicalId(uri))?.refreshed.add(url)
}

/**
 * Drop every write invalidation.  For teardown and tests only.
 */
export function clearStale() {
    staleIds.clear()
}

/**
 * Read a non-negative integer count header.  `headers.get()` returns null for a
 * header the deployment never sent.
 *
 * @param {Headers} headers the response headers.
 * @param {String} name the header to read.
 * @returns {Number|null} the count, or null when it cannot be known.
 */
function countHeader(headers, name) {
    const raw = headers.get(name)
    if (raw === null || raw.trim() === "") { return null }
    const count = Number(raw)
    return (Number.isInteger(count) && count >= 0) ? count : null
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
        // A misrouted proxy or an error page serves HTML, not JSON.  Say which
        // URI and what it sent instead of the parser's "Unexpected token '<'".
        throw Object.assign(
            new Error(`Expected JSON from ${response.url} but the body could not be parsed (content-type: ${response.headers.get("content-type") ?? "none"}).`),
            { status: response.status, url: response.url, cause: err }
        )
    }
}

/**
 * GET a single document by URI.
 *
 * @param {String|Object} id the document URI (or an object carrying one).
 * @param {Object} options `fresh: true` busts the HTTP cache.  A read that
 * follows a write of this URI busts it automatically.
 * @returns {Promise<Object>} the document.  Rejects rather than throwing
 * synchronously on an unusable id, matching every other read on this module —
 * a mixed contract is what breaks a caller batching these under Promise.all.
 */
export async function resolve(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    const reload = needsReload(uri, uri) || fresh
    const response = await fetcher(uri, reload ? { cache: "reload" } : {})
    const document = await handleResponse(response)
    if (reload) { markRefreshed(uri, uri) }
    return document
}

/**
 * GET the server-side annotation merge for a RERUM-hosted entity.
 * `generator` is REQUIRED and is always config.GENERATOR.

 * @param {String|Object} id the entity URI (or an object carrying one).
 * @param {Object} options `fresh` (bust HTTP cache).
 * @returns {Promise<Object>} `{document, gathered, merged}`.  The counts come
 * from the `Annotations-Gathered` / `Annotations-Merged` response headers, and
 * are `null` when the deployment did not send them or sent something
 * unparseable.
 */
export async function expanded(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    if (!isRerumId(uri)) {
        throw new TypeError(`${uri} is not a RERUM document id, so it has no /expanded merge. Ids must be bare URIs on config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}) — no query string, no fragment, no trailing slash.`)
    }
    const url = `${uri}/expanded?generator=${encodeURIComponent(requireGenerator())}`
    const reload = needsReload(uri, url) || fresh
    const response = await fetcher(url, reload ? { cache: "reload" } : {})
    const document = await handleResponse(response)
    if (reload) { markRefreshed(uri, url) }
    return {
        document,
        gathered: countHeader(response.headers, "Annotations-Gathered"),
        merged: countHeader(response.headers, "Annotations-Merged")
    }
}

/**
 * POST a Mongo-style query to the deployment's TinyNode proxy.
 * There is no `fresh` option: a POST response is never served from the HTTP
 * cache, so every query is already a live read.
 *
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

async function write(url, method, obj) {
    return fetcher(absoluteUrl(url), {
        method,
        headers: JSON_HEADERS,
        body: JSON.stringify(obj)
    })
        .then(handleResponse)
        .then(data => {
            // RERUM attaches `new_obj_state`, a self-copy of the response body, to
            // every write response.  It is deprecated and slated for removal.
            delete data?.new_obj_state
            return data
        })
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
 *
 * @param {Object} obj the document to create.
 * @returns {Promise<Object>} the created document.
 */
export function create(obj) {
    return write(config.URLS.CREATE, "POST", obj)
}

/**
 * Update a document through the TinyNode proxy, creating a new version.
 *
 * @param {Object} obj the document, carrying the `@id` to update.  When the
 * update RETARGETS an Annotation, the abandoned target's `/expanded` merge also
 * changed but cannot be known from this document — the caller that retargets
 * must re-read the old target with `fresh: true` itself.
 * @returns {Promise<Object>} the new version.
 */
export function update(obj) {
    return write(config.URLS.UPDATE, "PUT", obj)
}

/**
 * Overwrite a document in place through the TinyNode proxy.
 *
 * @param {Object} obj the document, carrying the `@id` to overwrite.  As with
 * update(), an overwrite that retargets an Annotation leaves the abandoned
 * target for the caller to re-read with `fresh: true`.
 * @returns {Promise<Object>} the overwritten document.
 */
export function overwrite(obj) {
    return write(config.URLS.OVERWRITE, "PUT", obj)
}

/**
 * Mark a document deleted through the TinyNode proxy.
 *
 * An un-busted cache would keep serving the live document.  A
 * deleted record cannot be updated, un-deleted, or deleted a second time.
 *
 * @param {String|Object} entity the document URI, or a document carrying one.
 * Pass the whole document when you have it — deleting an Annotation changes the
 * `/expanded` merge of its target, and the target can only be invalidated from
 * a document that still names it.  The tombstone does not.
 * @returns {Promise<String>} the canonical URI of the deleted record.
 * @throws {TypeError} when the id is not a RERUM document id.
 * @throws {Error} carrying TinyNode's `status`, which is TinyNode's own: it
 * reports a refusal from RERUM as a 502.
 */
export async function remove(entity) {
    const uri = canonicalId(idOf(entity))
    const recordId = isRerumId(uri) ? uri.slice(uri.lastIndexOf("/") + 1) : ""
    if (recordId === "") {
        throw new TypeError(`${uri} is not a RERUM document id, so there is nothing to delete. Ids must be bare URIs on config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}) — no query string, no fragment, no trailing slash.`)
    }
    const base = absoluteUrl(config.URLS.DELETE).replace(/\/+$/, "")
    const url = `${base}/${encodeURIComponent(recordId)}`
    const response = await fetcher(url, { method: "DELETE" })
    if (!response.ok) {
        let detail = ""
        try {
            detail = (await response.text()).trim()
        } catch {
            // A body that cannot be read leaves the status line to speak alone.
        }
        const failedUrl = response.url || url
        throw Object.assign(
            new Error(`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""} — ${failedUrl}${detail ? ` — ${detail}` : ""}`),
            { status: response.status, url: failedUrl }
        )
    }
    markStale(uri, entity, entity?.target)
    return uri
}

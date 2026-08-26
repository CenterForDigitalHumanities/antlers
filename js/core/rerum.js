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
 * How many distinct request URLs one invalidated URI is read through: the
 * document itself, and its `/expanded` merge.  Once both have been refreshed
 * the invalidation is spent and the entry is dropped.
 *
 * INVARIANT: exactly two, and that holds only because the generator is fixed at
 * config.GENERATOR with no per-call override (see requireGenerator).  A second
 * generator would mint a third `/expanded` URL, the count would be spent before
 * that one revalidated, and the first read after a write would be served from a
 * stale cache entry.  If the generator ever becomes per-call, this constant is
 * wrong and the bookkeeping has to expire on a timestamp instead of a count.
 */
const STALE_URL_FORMS = 2

/**
 * Backstop for a session that only ever reads one URL form per id, so its
 * invalidations are never fully spent.  Most sessions are that session: a
 * forms-only app never issues the `/expanded` read, and since forDisplay
 * stopped fetching the entity document alongside the merge, a display-only app
 * never issues the plain GET.  Oldest entries are evicted past this many.
 */
const STALE_LIMIT = 500

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
 * The deployment's RERUM agent, or a clear failure.  DEER has exactly ONE:
 * config.GENERATOR.  Every read filters annotations by it — `/expanded` through
 * `?generator=`, the client query through `__rerum.generatedBy` — and there is
 * deliberately no per-call override.  A read that could be filtered by some
 * other agent is a read whose two paths can disagree about whose annotations
 * they merged: the server path would honour the override and the client
 * fallback would not, so the same call would return two different documents
 * depending on a branch the caller cannot see.  An unfiltered read is worse
 * still — it merges annotations from every application that ever touched the
 * entity.  Do not reintroduce an override parameter.
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
 * forms.  The client-path equivalent of the server's `?generator=`, and applied
 * in the QUERY rather than after it: RERUM is shared, so another application's
 * annotations targeting the same entity would otherwise fill the page and crowd
 * out the ones this deployment actually merges.
 * @returns {Object} a Mongo-style `$in` clause over the http and https forms.
 * @throws {TypeError} when no generator is configured.
 */
export function generatedBy() {
    return httpsIdArray(requireGenerator())
}

/**
 * Is this id hosted by RERUM?  DEER supports nothing else, so this is the
 * support gate, not a branch selector — expand.js refuses an id that fails it.
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
        throw new TypeError(`Cannot resolve '${url}' to an absolute URL${base ? ` against '${base}'` : " (no config.BASE and no document base)"}. Configure an absolute URL or set config.BASE.`, { cause: err })
    }
}

/**
 * Record that a write invalidated these URIs.  Existing refresh bookkeeping for
 * a URI is discarded, so a second write re-invalidates every URL again.
 *
 * Non-RERUM URIs are skipped.  DEER writes annotations targeting the RERUM
 * entities it created, so this should never fire; it costs one comparison to
 * make sure an anomalous target cannot take a STALE_LIMIT slot that can never
 * be spent — this module would never read that URI — and eventually evict a
 * real invalidation.
 */
function markStale(...ids) {
    for (const id of ids.flat(3)) {
        const uri = (typeof id === "string") ? id : (id?.["@id"] ?? id?.id)
        if (typeof uri !== "string" || uri.length === 0) { continue }
        if (!isRerumId(uri)) { continue }
        staleIds.set(canonicalId(uri), new Set())
        // Map preserves insertion order, so the first key is the oldest.
        if (staleIds.size > STALE_LIMIT) { staleIds.delete(staleIds.keys().next().value) }
    }
}

/**
 * Does this read need to bust the HTTP cache?  True once per request URL per
 * write, so the first read after a write revalidates and later reads are served
 * from the refreshed cache entry.
 */
function needsReload(uri, url) {
    const key = canonicalId(uri)
    const refreshed = staleIds.get(key)
    if (refreshed === undefined || refreshed.has(url)) { return false }
    refreshed.add(url)
    // Every read shape for this URI has now revalidated, so the invalidation is
    // spent.  Holding the entry any longer only grows the Map for the life of
    // the session.
    if (refreshed.size >= STALE_URL_FORMS) { staleIds.delete(key) }
    return true
}

/**
 * Read a non-negative integer count header.  `headers.get()` returns null for a
 * header the deployment never sent and `Number(null)` is 0, so coercing
 * directly turns "the server told me nothing" into "it merged 0 of 0" — which
 * is indistinguishable from a clean merge, and silently disarms the only check
 * the display read has.  Absent, blank, and unparseable all return null so a
 * caller can tell unknown from known.
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
 * @param {String|Object} id the document URI (or an object carrying one).
 * @param {Object} options `fresh: true` busts the HTTP cache.  A read that
 * follows a write of this URI busts it automatically.
 * @returns {Promise<Object>} the document.  Rejects rather than throwing
 * synchronously on an unusable id, matching every other read on this module —
 * a mixed contract is what breaks a caller batching these under Promise.all.
 */
export async function resolve(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    // needsReload first: short-circuiting past it on an explicit fresh read
    // leaves the invalidation unspent, so the NEXT ordinary read of this URL
    // revalidates again for no reason.
    const reload = needsReload(uri, uri) || fresh
    return fetcher(uri, reload ? { cache: "reload" } : {}).then(handleResponse)
}

/**
 * GET the server-side annotation merge for a RERUM-hosted entity.
 * `generator` is REQUIRED and is always config.GENERATOR: the server applies no
 * default filter, and an unfiltered request merges annotations from every
 * application that ever targeted the entity.  Do not simplify this requirement
 * away, and do not add a per-call override — see requireGenerator.
 * @param {String|Object} id the entity URI (or an object carrying one).
 * @param {Object} options `fresh` (bust HTTP cache).
 * @returns {Promise<Object>} `{document, gathered, merged}`.  The counts come
 * from the `Annotations-Gathered` / `Annotations-Merged` response headers, and
 * are `null` when the deployment did not send them or sent something
 * unparseable — the caller must treat that as unknown, never as agreement.
 * They disagree when the server declined to merge something it found, which
 * callers must handle — the server merges only single-key object bodies.  The
 * document itself carries no annotation `@id`s, so this read has no
 * provenance.
 */
export async function expanded(id, { fresh = false } = {}) {
    const uri = canonicalId(idOf(id))
    const url = `${uri}/expanded?generator=${encodeURIComponent(requireGenerator())}`
    const reload = needsReload(uri, url) || fresh
    const response = await fetcher(url, reload ? { cache: "reload" } : {})
    const document = await handleResponse(response)
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

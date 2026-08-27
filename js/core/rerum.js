/**
 * @module rerum The only core module that touches the network.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Consolidates the fetches scattered across the 0.11 runtime
 * (deer-render.js, deer-record.js, deer-utils.js) behind one surface.
 * Reads go straight to RERUM; writes go through the deployment's TinyNode
 * proxy (config.URLS).  HTTP contract, confirmed against the 0.11 runtime:
 * CREATE is POST, UPDATE/OVERWRITE are PUT, and the response body is the
 * written document itself.
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
 * URIs invalidated by a write: canonical URI -> `{expires, refreshed}`, where
 * `refreshed` holds the request URLs already reloaded for that URI.  One id is
 * read through several URLs (the document itself and its `/expanded` merge are
 * separate cache entries), so each gets its own forced reload rather than the
 * first read consuming the invalidation for all of them.
 *
 * An entry expires on a TIMESTAMP.  It used to be spent by counting read forms,
 * which was wrong three ways at once.  The count assumed exactly two forms per
 * id, true only while the generator stays fixed at config.GENERATOR.  It was
 * almost never reached: an Annotation's own @id is never read back through this
 * module, a display-only app never issues the plain GET, and a forms-only app
 * reads through `POST /query`, which does not consult this at all — so entries
 * survived until eviction. And eviction dropped them in FIRST-SEEN order, which
 * `Map.set` preserves for an existing key, so re-invalidating an entity never
 * moved it back and the entity written most often was the first to lose its
 * invalidation — the exact opposite of what the eviction is for.
 */
const staleIds = new Map()

/**
 * How long a write's invalidation is honored.  Derived, not tuned: a cached read
 * can only serve a pre-write body while the browser still considers it fresh,
 * and RERUM sends `Cache-Control: max-age=86400, must-revalidate` on both
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
    let url
    try {
        url = new URL(canonicalId(id))
    } catch {
        return false
    }
    // A RERUM id is a bare document URI.  A query string or fragment on one is
    // not a variant of it, and letting one through corrupts the read: expanded()
    // appends `/expanded?generator=` by concatenation, so `…/id/abc?x=1` builds
    // `…/id/abc?x=1/expanded?generator=…` — the `/expanded` segment lands inside
    // the QUERY STRING and the request silently resolves the plain entity
    // instead of its merge, with no merge-count headers to notice it by.
    if (url.search || url.hash) { return false }
    // Tested against the NORMALIZED href, never the raw string.  `new URL`
    // resolves `..` segments, so a raw prefix test accepts
    // `…/v1/id/../../v1/query`, which fetch then sends to a different endpoint
    // on the same host.  RERUM is open — an annotation `target` is attacker-
    // supplied data, and Annotation#registerTargets reads ids straight out of
    // one — so the id that passes this gate must be the id that gets requested.
    // Something must follow the base.  The base itself carries no `_id`, and
    // expanded() builds its URL by concatenation, so it would produce
    // `…/v1/id//expanded?generator=` -- a request against the wrong resource
    // rather than a refusal, which is the failure this gate exists to prevent.
    return config.ID_BASES.some(base => url.href.startsWith(base) && url.href.length > base.length)
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
    // document.baseURI, not location.href: they differ on any page carrying a
    // `<base href>`, and a deployment behind a same-origin proxy -- the one case
    // relative URLS values exist for -- is the most likely to set one.
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
 *
 * Non-RERUM URIs are skipped.  DEER writes annotations targeting the RERUM
 * entities it created, so this should never fire; it costs one comparison to
 * make sure an anomalous target cannot take a STALE_LIMIT slot that can never
 * be spent — this module would never read that URI — and eventually evict a
 * real invalidation.
 */
function markStale(...ids) {
    const expires = Date.now() + STALE_TTL_MS
    for (const id of ids.flat(3)) {
        const uri = (typeof id === "string") ? id : (id?.["@id"] ?? id?.id)
        if (typeof uri !== "string" || uri.length === 0) { continue }
        if (!isRerumId(uri)) { continue }
        const key = canonicalId(uri)
        // Deleted before set: `Map.set` on an existing key updates the value but
        // KEEPS the key's original position.  Re-invalidating has to move it to
        // the back, or insertion order stops matching expiry order and the sweep
        // below evicts the most-written entity first.
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
 * Does this read need to bust the HTTP cache?  True once per request URL per
 * write, so the first read after a write revalidates and later reads are served
 * from the refreshed cache entry.
 */
function needsReload(uri, url) {
    const key = canonicalId(uri)
    const entry = staleIds.get(key)
    if (entry === undefined) { return false }
    if (entry.expires <= Date.now()) {
        staleIds.delete(key)
        return false
    }
    if (entry.refreshed.has(url)) { return false }
    entry.refreshed.add(url)
    return true
}

/**
 * Drop every write invalidation.  For teardown and tests only — entity.js
 * clearEntities() calls this, because bookkeeping left behind here outlives the
 * Entity state it belongs to and makes the next session's first read of an
 * affected URI force a reload for no reason.
 */
export function clearStale() {
    staleIds.clear()
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
    // Gate here, not only in expand.forDisplay: this is exported, and the URL
    // below is built by concatenation, so an id carrying a query string or a
    // `..` segment would produce a request that succeeds against the WRONG
    // resource rather than failing.  Only a RERUM id has an `/expanded` merge
    // at all, so refusing anything else costs nothing.
    if (!isRerumId(uri)) {
        throw new TypeError(`${uri} is not a RERUM document id, so it has no /expanded merge. Ids must be bare URIs on config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}) — no query string, no fragment.`)
    }
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

// `async` for the same reason every read on this module is: absoluteUrl throws
// on a relative URL with no base, and a surface where some failures reject and
// others throw synchronously is what breaks a caller batching these under
// Promise.all.  A browser borrows location.href, so this only bites the Node and
// worker hosts the core layer is meant to be importable from.
async function write(url, method, obj) {
    return fetcher(absoluteUrl(url), {
        method,
        headers: JSON_HEADERS,
        body: JSON.stringify(obj)
    })
        .then(handleResponse)
        .then(data => {
            // RERUM attaches `new_obj_state`, a self-copy of the response body, to
            // every write response.  It is deprecated and slated for removal, and
            // it is stripped rather than read so it can never round-trip back into
            // a stored document.
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
 * @param {Object} obj the document to create.
 * @returns {Promise<Object>} the created document.
 */
export function create(obj) {
    return write(config.URLS.CREATE, "POST", obj)
}

/**
 * Update a document through the TinyNode proxy, creating a new version.
 * @param {Object} obj the document, carrying the `@id` to update.
 * @returns {Promise<Object>} the new version.
 */
export function update(obj) {
    return write(config.URLS.UPDATE, "PUT", obj)
}

/**
 * Overwrite a document in place through the TinyNode proxy.
 * @param {Object} obj the document, carrying the `@id` to overwrite.
 * @returns {Promise<Object>} the overwritten document.
 */
export function overwrite(obj) {
    return write(config.URLS.OVERWRITE, "PUT", obj)
}

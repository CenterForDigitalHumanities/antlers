/**
 * @module config Core-layer configuration for DEER 2.0.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Shipped defaults talk to the public sandbox proxy (tinydev.rerum.io) and the
 * RERUM sandbox (devstore.rerum.io).  Implementers who stand up their own
 * TinyNode instance (https://github.com/CenterForDigitalHumanities/TinyNode)
 * repoint URLS at it and set GENERATOR to their deployment's RERUM agent URI.
 */

const config = {
    URLS: {
        CREATE: "https://tinydev.rerum.io/app/create",
        UPDATE: "https://tinydev.rerum.io/app/update",
        OVERWRITE: "https://tinydev.rerum.io/app/overwrite",
        QUERY: "https://tinydev.rerum.io/app/query"
    },

    // URI prefixes that mark an id as RERUM-hosted.  DEER reads and writes RERUM
    // entities only, so this is the support boundary: an id outside these bases
    // is refused, not served by a fallback.  A deployment on its own RERUM host
    // MUST list it here.  TinyNode proxies write *into* RERUM, so entity ids
    // stay on these bases no matter which proxy a deployment uses.
    ID_BASES: [
        "https://store.rerum.io/v1/id/",
        "https://devstore.rerum.io/v1/id/"
    ],

    // The RERUM agent this deployment writes with — a public identifier, safe to
    // ship.  Used as the required `?generator=` filter on `/expanded` so one
    // DEER app never merges annotations created by another.  The server compares
    // it protocol-insensitively.  Default is the shared tinydev agent.
    GENERATOR: "https://devstore.rerum.io/v1/id/5afeebf3e4b0b0d588705d90",

    // Base for resolving any relative value in URLS.  Prefer absolute URLS
    // values; set this when a deployment must configure them relative (a
    // same-origin proxy path, say) so resolution never depends on an ambient
    // document.  Falls back to the document base in a browser, and is REQUIRED
    // outside one -- there is no location to borrow.
    BASE: undefined,

    // Query paging defaults, matching the 0.11 QUERY URL parameters.
    LIMIT: 50,
    SKIP: 0,

    // Verbose library logging (missing-value lookups, skipped assertions).
    DEBUG: false,

    // Injectable fetch for non-browser hosts and live instrumentation; falls back to globalThis.fetch.
    fetch: undefined
}

/**
 * Merge deployment overrides into the shipped defaults.
 * @param {Object} overrides partial config; URLS merges key-by-key, ID_BASES
 * replaces wholesale and is normalized to trailing-slash form.
 * @returns {Object} the live config object.
 */
export function configure(overrides = {}) {
    const { URLS, ID_BASES, ...rest } = overrides
    if (URLS) { Object.assign(config.URLS, URLS) }
    // Normalized to end in "/": isRerumId and forDisplay's deployment lookup
    // are prefix tests, and a base missing its trailing slash accepts sibling
    // endpoints -- "…/v1/id" lets "…/v1/idiot/…" through the support gate that
    // screens attacker-supplied annotation targets.
    if (ID_BASES) { config.ID_BASES = ID_BASES.map(base => base.endsWith("/") ? base : `${base}/`) }
    Object.assign(config, rest)
    return config
}

export default config

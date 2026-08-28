/**
 * @module config Core-layer configuration for DEER 2.0.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Shipped defaults talk to the public sandbox proxy (tinydev.rerum.io) and the
 * RERUM sandbox (devstore.rerum.io).  Implementers who stand up their own
 * TinyNode instance repoint URLS at it and set GENERATOR to their deployment's RERUM agent URI.
 */

/**
 * The agent the shipped default writes with — the SHARED public sandbox agent.
 * Exported so rerum.js can tell "this deployment chose the sandbox agent" from
 * "this deployment never set one".
 */
export const SHIPPED_GENERATOR = "https://devstore.rerum.io/v1/id/5afeebf3e4b0b0d588705d90"

/**
 * The proxy the shipped default writes through — the SHARED public sandbox.
 * GENERATOR and URLS are ONE unified decision.
 */
export const SHIPPED_URLS = Object.freeze({
    CREATE: "https://tinydev.rerum.io/create",
    UPDATE: "https://tinydev.rerum.io/update",
    OVERWRITE: "https://tinydev.rerum.io/overwrite",
    DELETE: "https://tinydev.rerum.io/delete",
    QUERY: "https://tinydev.rerum.io/query"
})

const config = {
    URLS: { ...SHIPPED_URLS },

    // URI prefixes that mark an id as RERUM-hosted.  DEER reads and writes RERUM
    // entities only, so this is the support boundary: an id outside these bases
    // is refused, not served by a fallback.
    ID_BASES: [
        "https://store.rerum.io/v1/id/",
        "https://devstore.rerum.io/v1/id/"
    ],

    // The RERUM agent this deployment writes with — a public identifier.
    // Default is the shared tinydev agent.
    GENERATOR: SHIPPED_GENERATOR,

    // Base for resolving any relative value in URLS.  Read by absoluteUrl,
    // which falls back to the document base in a browser and has nothing to
    // borrow outside one — so a host with no document MUST set this.
    BASE: undefined,

    // Query paging defaults
    // LIMIT must be 500 or less
    LIMIT: 50,
    SKIP: 0,

    // The most documents one read pages through before it refuses.
    // A runaway backstop rather than a tuning knob.
    MAX_RESULTS: 1000,

    // Verbose library logging (missing-value lookups, skipped assertions).
    DEBUG: false,

    // Injectable fetch for non-browser hosts and live instrumentation; falls back to globalThis.fetch.
    fetch: undefined
}

/**
 * Merge deployment overrides into the shipped defaults.
 *
 * @param {Object} overrides partial config; URLS merges key-by-key, ID_BASES
 * replaces wholesale and is normalized to trailing-slash, https form.
 * @returns {Object} the live config object.
 */
export function configure(overrides = {}) {
    const { URLS, ID_BASES, ...rest } = overrides
    if (URLS) { Object.assign(config.URLS, URLS) }
    if (ID_BASES) {
        config.ID_BASES = ID_BASES.map(base => {
            if (typeof base !== "string" || base.length === 0) {
                throw new TypeError(`config.ID_BASES members must be non-empty URI prefix strings, and got ${JSON.stringify(base)}. ID_BASES is the support boundary — it decides which URIs DEER will read at all.`)
            }
            const https = base.replace(/^http:/, "https:")
            return https.endsWith("/") ? https : `${https}/`
        })
    }
    Object.assign(config, rest)
    return config
}

export default config

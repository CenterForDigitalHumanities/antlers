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

    // URI prefixes that mark an id as RERUM-hosted, and so eligible for the
    // server-side `/expanded` read path.  TinyNode proxies write *into* RERUM,
    // so entity ids stay on these bases no matter which proxy a deployment uses.
    ID_BASES: [
        "https://store.rerum.io/v1/id/",
        "https://devstore.rerum.io/v1/id/"
    ],

    // The RERUM agent this deployment writes with — a public identifier, safe to
    // ship.  Used as the required `?generator=` filter on `/expanded` so one
    // DEER app never merges annotations created by another.  The server compares
    // it protocol-insensitively.  Default is the shared tinydev agent.
    GENERATOR: "https://devstore.rerum.io/v1/id/5afeebf3e4b0b0d588705d90",

    // Query paging defaults, matching the 0.11 QUERY URL parameters.
    LIMIT: 50,
    SKIP: 0,

    // Verbose library logging (missing-value lookups, incomplete checkMatch matches).
    DEBUG: false,

    // Injectable fetch for non-browser hosts and live instrumentation; falls back to globalThis.fetch.
    fetch: undefined
}

/**
 * Merge deployment overrides into the shipped defaults.
 * @param {Object} overrides partial config; URLS merges key-by-key, ID_BASES replaces wholesale.
 * @returns {Object} the live config object.
 */
export function configure(overrides = {}) {
    const { URLS, ID_BASES, ...rest } = overrides
    if (URLS) { Object.assign(config.URLS, URLS) }
    if (ID_BASES) { config.ID_BASES = [...ID_BASES] }
    Object.assign(config, rest)
    return config
}

export default config

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

    // The agents whose Annotations a read gathers.  A list, because a
    // deployment commonly sits between two: its own agent, plus the agents of
    // the applications it consumes (antlers#9 cites a Manifest Builder reading
    // TPEN transcriptions, and a Dunbar installation crossing poems, books,
    // and OHC collections).
    //
    //  - undefined (default): wrap the single GENERATOR, preserving DEER's law
    //    ("it only cares about the data it generates") out of the box.
    //  - an Array (or a single URI): gather exactly those agents.  An empty
    //    Array gathers nothing — a deliberate choice, not a misconfiguration.
    //  - null: EXHIBIT MODE — gather every generator's Annotations.  The
    //    DEER-with-no-config exhibit case: render a hosted Manifest many
    //    applications have annotated.
    READ_GENERATORS: undefined,

    // URI prefixes an entity may live at for DEER to READ or ANNOTATE it,
    // beyond the RERUM bases it writes to (antlers#9: foreign targets are
    // legal; the Annotations are still sought only in RERUM).  The read
    // boundary is ID_BASES ∪ READ_ID_BASES; the WRITE boundary stays
    // ID_BASES alone.
    //
    // A target outside the read boundary is refused rather than silently
    // annotated, which keeps a form from asserting onto the open web.
    READ_ID_BASES: [],

    // The properties an Annotation can carry the URI of its target under.
    // Choice, Composite, and List target constructs whose members sit in an
    // `items` Array are not supported on either side (the server's
    // findLeafAnnotationsFor carries the same note).
    //
    // A deployment annotating through other vocabularies (`on`, `partOf`,
    // `dc:subject`…) configures the list rather than forking the read.
    TARGET_KEYS: ["target", "target.@id", "target.id",
        "target.source", "target.source.@id", "target.source.id"],

    // Base for resolving any relative value in URLS.  Read by absoluteUrl,
    // which falls back to the document base in a browser and has nothing to
    // borrow outside one — so a host with no document MUST set this.
    BASE: undefined,

    // Query paging defaults.  Integers, always — see INTEGER_DEFAULTS.
    // LIMIT must not exceed RERUM API's max allowed limit and should be greater than 0.
    LIMIT: 50,
    SKIP: 0,

    // RERUM API's max allowed limit, which is 500 at the time of writing.
    // Used as a guard.  Do not increase without verifying against RERUM API.
    MAX_LIMIT: 500,

    // The most documents one read pages through before it refuses.
    // A runaway backstop rather than a tuning knob.
    MAX_RESULTS: 1000,

    // Verbose library logging (missing-value lookups, skipped assertions).
    DEBUG: false,

    // The verbosity gate for the structured logger (js/core/log.js, antlers#8):
    // "debug" | "info" | "warn" | "error" | "silent".  Unset follows DEBUG —
    // DEBUG:true means "debug", DEBUG:false means "info" (warn/error still
    // print either way, so a shipped exhibit only quiets down, never goes mute
    // on failures).
    LOG_LEVEL: undefined,

    // Injectable log sink, called with every record that clears the gate:
    // ({ level, code, message, detail, at }) => void.  Falls back to the
    // console with a "DEER <code>:" prefix.  The instrumentation point a host
    // points at Sentry, a debug panel, or a noop.
    log: undefined,

    // Injectable fetch for non-browser hosts and live instrumentation; falls back to globalThis.fetch.
    fetch: undefined
}

/**
 * The config values that are counts, and what each falls back to.
 */
export const INTEGER_DEFAULTS = Object.freeze({ LIMIT: 50, MAX_LIMIT: 500, SKIP: 0, MAX_RESULTS: 1000 })

/**
 * A config count, always an integer.  A fraction drops its decimal; anything
 * that is not a finite number is the shipped default.
 *
 * @param {any} value the configured value.
 * @param {Number} fallback the default for this key.
 * @returns {Number} an integer.
 */
export function asInteger(value, fallback) {
    const number = (typeof value === "string" && value.trim() !== "") ? Number(value) : value
    return (typeof number === "number" && Number.isFinite(number)) ? Math.trunc(number) : fallback
}

/**
 * The config values that are lists of URI strings, and what each falls back to.
 */
const LIST_DEFAULTS = Object.freeze({ TARGET_KEYS: undefined, READ_GENERATORS: undefined, READ_ID_BASES: undefined })

/** A URI string, canonicalized to https and freed of trailing whitespace. */
const httpsUri = (uri) => (typeof uri === "string" && uri.trim() !== "")
    ? uri.trim().replace(/^http:/, "https:") : undefined/**
 * A config list of URI strings: a single URI is accepted as a one-element
 * list, and `null` passes through as a distinct "special meaning" signal —
 * READ_GENERATORS: null is exhibit mode (gather every generator's
 * annotations, antlers#9).  An explicit `undefined` resets the key to its
 * shipped default.
 *
 * @param {any} value the configured value.
 * @returns {Array<String>|null|undefined} the list, null, or undefined.
 * @throws {TypeError} when the value is not a URI, an Array of URIs, null, or
 * undefined.
 */
export function asUriList(value) {
    if (value === null) { return null }
    if (value === undefined) { return undefined }
    const members = (Array.isArray(value)) ? value : [value]
    const uris = members.map(httpsUri)
    if (uris.some(u => u === undefined)) {
        throw new TypeError("Expected a URI string or an Array of URI strings (empty strings and non-strings are refused), and got " + JSON.stringify(value)?.slice(0, 120))
    }
    return uris
}

/**
 * Merge deployment overrides into the shipped defaults.
 *
 * @param {Object} overrides partial config; URLS merges key-by-key, ID_BASES
 * replaces wholesale and is normalized to trailing-slash https form as the URL
 * parser spells it.  TARGET_KEYS, READ_GENERATORS, and READ_ID_BASES are URI
 * lists (see asUriList): a single URI is accepted as a one-element list, and
 * `null` passes through so READ_GENERATORS: null can mean exhibit mode.
 * @returns {Object} the live config object.
 * @throws {TypeError} when ID_BASES is not an Array, or when one of its members
 * is not a non-empty absolute URL string.
 */
export function configure(overrides = {}) {
    const { URLS, ID_BASES, ...rest } = overrides
    if (ID_BASES !== undefined && !Array.isArray(ID_BASES)) {
        throw new TypeError(`config.ID_BASES must be an Array of URI prefix strings, and got ${JSON.stringify(ID_BASES)}. ID_BASES is the support boundary — it decides which URIs DEER will read at all.`)
    }
    const normalizedBases = ID_BASES?.map(base => {
        if (typeof base !== "string" || base.length === 0) {
            throw new TypeError(`config.ID_BASES members must be non-empty URI prefix strings, and got ${JSON.stringify(base)}. ID_BASES is the support boundary — it decides which URIs DEER will read at all.`)
        }
        const https = base.replace(/^http:/, "https:")
        let href
        try {
            href = new URL(https).href
        } catch (err) {
            throw new TypeError(`config.ID_BASES member ${JSON.stringify(base)} is not an absolute URL, so no id could ever sit on it. ID_BASES is the support boundary — it decides which URIs DEER will read at all.`, { cause: err })
        }
        return href.endsWith("/") ? href : `${href}/`
    })
    for (const [key, fallback] of Object.entries(INTEGER_DEFAULTS)) {
        if (Object.hasOwn(rest, key)) { rest[key] = asInteger(rest[key], fallback) }
    }
    for (const key of Object.keys(LIST_DEFAULTS)) {
        if (Object.hasOwn(rest, key)) { rest[key] = asUriList(rest[key]) }
    }
    if (URLS) { Object.assign(config.URLS, URLS) }
    if (normalizedBases) { config.ID_BASES = normalizedBases }
    Object.assign(config, rest)
    return config
}

export default config

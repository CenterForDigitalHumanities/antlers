/**
 * @module assertions Annotation-merge logic and DEER value shaping.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * checkMatch and buildValueObject are lifted from the 0.11 UTILS.expand
 * internals; applyAssertions is ported from releases/rc-1.0/js/entities.js
 * with two fixes: the checkMatch guard is un-inverted (rc-1.0 skipped the
 * annotations that DID match) and matching happens against the annotation
 * document, which carries __rerum.generatedBy / creator — the body does not.
 *
 * shapeValues lives here because both read paths finish with it: the client
 * merge below and the server `/expanded` response in ./expand.js come out
 * identically shaped, so `source.citationSource` is the only thing that differs
 * between them.  Keeping that true means matching the server's body-reading
 * rules, not just its output shape — see TEXTUAL_BODY_TYPES and the bodyValue
 * handling in applyAssertions.
 */

import config from './config.js'
import { canonicalId } from './rerum.js'
import { getValue } from './normalize.js'

/**
 * The client-path filter, and the exact client-side equivalent of the server's
 * `?generator=`.  checkMatch short-circuits on the first property both
 * documents carry, and every RERUM document carries `__rerum.generatedBy`, so
 * anything listed after it is unreachable for RERUM-hosted annotations — which
 * is why this is a single entry rather than the 0.11 pair.  A deployment that
 * genuinely wants to match on `creator` sets config.MATCH_ON; see config.js.
 */
export const DEFAULT_MATCH_ON = ["__rerum.generatedBy"]

/**
 * The filter actually in force: the deployment's override, else the default.
 * Read per call so configure() takes effect without re-importing anything.
 * @returns {Array<String>} dot-separated property paths for checkMatch.
 */
export function activeMatchOn() {
    return config.MATCH_ON ?? DEFAULT_MATCH_ON
}

/**
 * First-class properties of the entity itself — passed through shaping
 * untouched, and never merged into.  An annotation asserting one of these is
 * ignored: a DEER app declares `type`, `@type`, and `@context` directly on the
 * entity it creates and never relies on an Annotation to assert them, so an
 * annotation that tries to is either a mistake or someone else redefining what
 * your entity IS and what its properties MEAN.  RERUM is open, so that is not a
 * hypothetical.  checkMatch reads `__rerum` off the document, and `@id`/`id`
 * are the primary key, so those must never be wrapped either.
 *
 * Note the server does NOT protect `type`/`@type` — it merges an annotation
 * that asserts them.  forDisplay in ./expand.js therefore reads the entity
 * document alongside the merge and restores these keys from it, so the policy
 * holds on both read paths rather than only on this one.
 *
 * isAnnotationType reads type off RAW fetched documents, never shaped ones, so
 * it is unaffected by anything here.
 */
export const IDENTITY_KEYS = ["@id", "id", "@type", "type", "@context", "__rerum"]

/**
 * Keys an Annotation may never assert onto an entity and that never survive
 * shaping, mirroring the server's PROTECTED_EXPANSION_KEYS
 * (rerum_server_nodejs/controllers/crud.js).  structuredClone plus
 * Object.entries already absorb a `__proto__` body in practice, but that safety
 * is incidental — a document parsed straight from JSON carries `__proto__` as
 * an OWN property, which Object.entries does yield.  One Set membership test
 * makes the guard deliberate instead of lucky.
 */
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Body types the server folds whole into a single `bodyValue` assertion rather
 * than reading key by key (rerum_server_nodejs/controllers/crud.js
 * TEXTUAL_BODY_TYPES).  Mirrored here so the two read paths agree on the KEY a
 * TextualBody lands under, not merely on the shape of the value.
 */
export const TEXTUAL_BODY_TYPES = new Set([
    "TextualBody", "oa:TextualBody",
    "http://www.w3.org/ns/oa#TextualBody", "https://www.w3.org/ns/oa#TextualBody"
])

/**
 * Objects this module has already shaped.  Identity-based, so a value object is
 * recognized because THIS module made it — never because it happens to carry a
 * `source` or `value` key.  Sniffing for those keys silently mistook ordinary
 * vocabulary (`{source: "Book A", value: "p. 12"}`) for an already-shaped value
 * and dropped its citationSource, which makes the next form save POST a
 * duplicate assertion instead of updating the existing one.
 */
const SHAPED = new WeakSet()

/**
 * Is this `type`/`@type` value an Annotation?  Accepts a string or an array of
 * strings; matches the bare and namespace-prefixed forms exactly ("Annotation",
 * "oa:Annotation") — deliberately NOT a substring match, so "AnnotationPage"
 * does not qualify.
 * @param {String|Array<String>} typeValue the document's type or @type.
 * @returns {Boolean}
 */
export function isAnnotationType(typeValue) {
    return [typeValue].flat().some(t =>
        typeof t === "string" && (t === "Annotation" || t.endsWith(":Annotation")))
}

/**
 * Does this annotation body assert itself whole, as the server's `bodyValue`?
 * @param {Object} body one body of an annotation.
 * @returns {Boolean}
 */
function isTextualBody(body) {
    return [body.type ?? body["@type"]].flat().some(t => TEXTUAL_BODY_TYPES.has(t))
}

/**
 * Both read paths must fail the same way on a document that came back empty.
 * Before this existed the display path threw a bare TypeError out of
 * Object.entries while the client path silently resolved to null.
 * @param {any} doc the fetched document.
 * @param {String} context what was being resolved, for the message.
 * @returns {Object} the document.
 * @throws {TypeError} when the document is not a usable object.
 */
export function requireDocument(doc, context = "This read") {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        const got = (doc === null) ? "null" : (Array.isArray(doc) ? "an array" : typeof doc)
        throw new TypeError(`${context} did not produce a usable document (got ${got}).`)
    }
    return doc
}

/**
 * Match on criteria (if exists) and return true if it appears to match on the
 * values specified.  A true result means the incoming assertion is likely to be
 * relevant and authorized to augment the original object.  This is the client
 * fallback for the filtering the server performs with `?generator=` on the
 * display path.
 *
 * Note the short-circuit: the FIRST listed property that both documents carry
 * decides the outcome, and a mismatch there ends the comparison.  Order in
 * matchOn is therefore significant.
 * @param {Object} expanding existing object with values to check.
 * @param {Object} asserting annotation document to compare.
 * @param {Array<String>} matchOn dot-separated property paths to compare.
 * @returns {Boolean} whether the annotation should augment the object.
 */
export function checkMatch(expanding, asserting, matchOn = activeMatchOn()) {
    for (const m of matchOn) {
        let obj_match = m.split('.').reduce((o, i) => o?.[i], expanding)
        let anno_match = m.split('.').reduce((o, i) => o?.[i], asserting)
        if (obj_match === undefined || anno_match === undefined) {
            // Matching is not violated if one of the checked values is missing from a comparator,
            // but it is not a match without any positive matches.
            continue
        }
        // check for match within Arrays as well
        if (!Array.isArray(obj_match)) { obj_match = [obj_match] }
        if (!Array.isArray(anno_match)) { anno_match = [anno_match] }
        // Agent URIs are recorded with whichever protocol the writing proxy
        // sent, so compare them the canonical way every other id comparison in
        // the core layer does.  The server's `?generator=` filter is likewise
        // protocol-insensitive; this keeps the client fallback in step with it.
        obj_match = obj_match.map(canonicalId)
        anno_match = anno_match.map(canonicalId)
        if (!anno_match.every(item => obj_match.includes(item))) {
            // Any mismatch (generous typecasting) will return a false result.
            if (anno_match.some(item => obj_match.includes(item))) {
                // NOTE: this mismatches if some of the Anno assertion is missing, which
                // may lead to duplicates downstream.
                if (config.DEBUG) { console.warn("Incomplete match may require additional handling. ", obj_match, anno_match) }
            }
            break
        }
        // High confidence this match is affirmative.
        return true
    }
    return false
}

/**
 * Regularizes assertions to enforce the existence of a `source` key.
 * The return is only the value of the assertion, so the desired key must be
 * applied upstream from the scope of this function.  Survives the heterogeneous
 * arrays `/expanded` produces (raw strings and `{value}` objects mixed), and is
 * idempotent — a value object this module already built is returned unchanged,
 * which is what lets shapeValues run over a partly merged document.
 *
 * Idempotency is by object identity (the SHAPED WeakSet), never by inspecting
 * the value's keys.  `source` and `value` are ordinary vocabulary terms; a body
 * asserting `{citation: {source: "Book A", value: "p. 12"}}` is real data, not a
 * value object, and must keep its citationSource.
 * @param {any} val asserted value of the incoming annotation.
 * @param {Object} fromAnno parent annotation of the asserted value, as a handy metadata container.
 * @returns {Object} with `value`, `source`, and `evidence` keys.
 */
export function buildValueObject(val, fromAnno = {}) {
    if (val !== null && typeof val === "object" && SHAPED.has(val)) { return val }
    const valueObject = {
        source: { citationSource: fromAnno["@id"] ?? fromAnno.id },
        value: getValue(val),
        evidence: fromAnno.evidence ?? ""
    }
    SHAPED.add(valueObject)
    return valueObject
}

/**
 * Wrap every asserted value on a document in DEER's `{value, source, evidence}`
 * shape, leaving identity keys alone.  Both read paths end here, so consumers
 * get one rule: a non-identity value is a value object, or an array of value
 * objects.  Values already shaped during the merge pass through unchanged.
 * @param {Object} obj a resolved or merged entity document.  Not mutated.
 * @returns {Object} the DEER-shaped document.
 */
export function shapeValues(obj) {
    const shaped = {}
    for (const [key, val] of Object.entries(requireDocument(obj, "Shaping"))) {
        // Never let a reserved key reach an assignment — `shaped["__proto__"] = …`
        // rewrites the prototype instead of setting a property.
        if (FORBIDDEN_KEYS.has(key)) { continue }
        if (IDENTITY_KEYS.includes(key)) {
            shaped[key] = val
            continue
        }
        // A null value asserts nothing — the server passes annotation nulls
        // straight through, and shaping one would be a crash, not a value.
        if (val === undefined || val === null) { continue }
        shaped[key] = Array.isArray(val)
            ? val.filter(v => v !== undefined && v !== null).map(v => buildValueObject(v))
            : buildValueObject(val)
    }
    return shaped
}

/**
 * Merge targeting annotations onto an entity and DEER-shape the result.
 * Merged values carry `source.citationSource` = the asserting annotation's @id,
 * which is what keeps the create-vs-update trigger working on the editing path.
 * The entity's own values are preserved alongside annotation values, matching
 * the server's `/expanded` merge behavior.
 * @param {Object} entity the resolved entity document, RAW — pass the fetched
 * document, never an already-shaped one, or `creator` would be a value object
 * where checkMatch expects a URI.
 * @param {Array<Object>} annotations annotation documents targeting the entity.
 * @param {Array<String>} matchOn dot-separated property paths for checkMatch.
 * @returns {Object} a new, DEER-shaped object with the assertions applied.
 */
export function applyAssertions(entity, annotations = [], matchOn = activeMatchOn()) {
    const assertOn = structuredClone(requireDocument(entity, "applyAssertions"))
    for (const anno of annotations) {
        // A superseded annotation asserts nothing.  RERUM mints a new @id on
        // update, so a stale version merged beside its replacement would yield
        // two conflicting values and two citationSources.  The queries filter
        // to leaves, but Entity.Annotations can outlive a write.  0.11 guarded
        // this the same way (deer-utils.js:150).
        if (anno?.__rerum?.history?.next?.length) { continue }
        if (!checkMatch(entity, anno, matchOn)) { continue }
        // The server emits an assertion for a bare `bodyValue` string, which
        // this path read nothing from at all.  Nothing reported the gap either:
        // the server counts such an annotation as merged, so gathered === merged
        // and forDisplay's divergence guard never fired.  A view showed the
        // value and a form editing the same entity was blind to it.
        if (typeof anno.bodyValue === "string") {
            mergeAssertion(assertOn, "bodyValue", buildValueObject(anno.bodyValue, anno))
        }
        let bodies = anno.body ?? []
        if (!Array.isArray(bodies)) { bodies = [bodies] }
        for (const body of bodies.flat(2)) {
            if (!body || typeof body !== "object") { continue }
            // 0.11 hoisted body.evidence onto the entity itself
            // (deer-utils.js:141), where the last annotation carrying one
            // silently won.  Attach it to the values this body asserts
            // instead — that is what buildValueObject's evidence slot is for.
            const evidence = body.evidence?.["@id"] ?? body.evidence
            const from = (evidence === undefined) ? anno : { ...anno, evidence }
            // A TextualBody asserts itself whole under `bodyValue`, the way the
            // server does.  Reading its keys instead would land the text under
            // `value`, so the two paths would disagree on the KEY — and again
            // with no signal, since the server merges it and the counts match.
            if (isTextualBody(body)) {
                mergeAssertion(assertOn, "bodyValue", buildValueObject(body, from))
                continue
            }
            for (const [key, val] of Object.entries(body)) {
                if (key === "evidence") { continue }
                if (val === undefined || val === null) { continue }
                if (FORBIDDEN_KEYS.has(key)) {
                    console.warn(`Annotation ${anno["@id"] ?? anno.id} asserts the reserved key '${key}'; ignoring.`)
                    continue
                }
                if (IDENTITY_KEYS.includes(key)) {
                    // Identity belongs to the entity, not to anything asserting
                    // about it.  Merging here would leave a shaped value under a
                    // key shapeValues passes through untouched, so the two read
                    // paths would disagree on it.
                    if (config.DEBUG) { console.warn(`Annotation ${anno["@id"] ?? anno.id} asserts identity key '${key}'; ignoring.`) }
                    continue
                }
                // An array body asserts N values, not one array-shaped value.
                // The server merge flattens these onto the entity; matching that
                // here is what keeps forDisplay and forEditing agreeing on shape
                // for every multi-value property.
                for (const one of (Array.isArray(val) ? val : [val])) {
                    if (one === undefined || one === null) { continue }
                    mergeAssertion(assertOn, key, buildValueObject(one, from))
                }
            }
        }
    }
    return shapeValues(assertOn)
}

/**
 * Attach one shaped assertion to the object under `key`, preserving any value
 * that is already there the way the server merge does: an existing value
 * becomes the first element of an array the assertion is appended to.  Raw
 * values left here are shaped by the shapeValues pass that follows.
 */
function mergeAssertion(target, key, assertion) {
    const existing = target[key]
    if (existing === undefined || existing === null || existing === "") {
        target[key] = assertion
        return
    }
    if (Array.isArray(existing)) {
        existing.push(assertion)
        return
    }
    target[key] = [existing, assertion]
}

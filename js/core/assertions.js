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
 * between them.
 */

import config from './config.js'
import { canonicalId } from './rerum.js'
import { getValue } from './normalize.js'

const DEFAULT_MATCH_ON = ["__rerum.generatedBy", "creator"]

/**
 * Identity, not assertion — passed through shaping untouched.  checkMatch reads
 * `__rerum` off the document, so these must never be wrapped.
 */
export const IDENTITY_KEYS = ["@id", "id", "@type", "type", "@context", "__rerum"]

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
 * @param {Object} expanding existing object with values to check.
 * @param {Object} asserting annotation document to compare.
 * @param {Array<String>} matchOn dot-separated property paths to compare.
 * @returns {Boolean} whether the annotation should augment the object.
 */
export function checkMatch(expanding, asserting, matchOn = DEFAULT_MATCH_ON) {
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
 * idempotent — shaping an already-shaped value returns it unchanged, which is
 * what lets shapeValues run over a partly merged document.
 * @param {any} val asserted value of the incoming annotation.
 * @param {Object} fromAnno parent annotation of the asserted value, as a handy metadata container.
 * @returns {Object} with `value`, `source`, and `evidence` keys.
 */
export function buildValueObject(val, fromAnno = {}) {
    const valueObject = {}
    valueObject.source = val?.source ?? {
        citationSource: fromAnno["@id"] ?? fromAnno.id,
        // `||` here on purpose: an empty label should fall through to the default.
        citationNote: fromAnno.label || fromAnno.name || "Composed object from DEER",
        comment: "Learn about the assembler for this object at https://github.com/CenterForDigitalHumanities/deer"
    }
    valueObject.value = val?.value ?? getValue(val)
    valueObject.evidence = val?.evidence ?? fromAnno.evidence ?? ""
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
export function applyAssertions(entity, annotations = [], matchOn = DEFAULT_MATCH_ON) {
    const assertOn = structuredClone(requireDocument(entity, "applyAssertions"))
    for (const anno of annotations) {
        // A superseded annotation asserts nothing.  RERUM mints a new @id on
        // update, so a stale version merged beside its replacement would yield
        // two conflicting values and two citationSources.  The queries filter
        // to leaves, but Entity.Annotations can outlive a write.  0.11 guarded
        // this the same way (deer-utils.js:150).
        if (anno?.__rerum?.history?.next?.length) { continue }
        if (!checkMatch(entity, anno, matchOn)) { continue }
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
            for (const [key, val] of Object.entries(body)) {
                if (key === "evidence") { continue }
                if (val === undefined || val === null) { continue }
                mergeAssertion(assertOn, key, buildValueObject(val, from))
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

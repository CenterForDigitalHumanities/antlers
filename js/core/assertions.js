/**
 * @module assertions Annotation-merge logic for the client read path.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * checkMatch and buildValueObject are lifted from the 0.11 UTILS.expand
 * internals; applyAssertions is ported from releases/rc-1.0/js/entities.js
 * with two fixes: the checkMatch guard is un-inverted (rc-1.0 skipped the
 * annotations that DID match) and matching happens against the annotation
 * document, which carries __rerum.generatedBy / creator — the body does not.
 */

import config from './config.js'
import { getValue } from './normalize.js'

const DEFAULT_MATCH_ON = ["__rerum.generatedBy", "creator"]

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
 * arrays `/expanded` produces (raw strings and `{value}` objects mixed).
 * @param {any} val asserted value of the incoming annotation.
 * @param {Object} fromAnno parent annotation of the asserted value, as a handy metadata container.
 * @returns {Object} with `value`, `source`, and `evidence` keys.
 */
export function buildValueObject(val, fromAnno = {}) {
    const valueObject = {}
    valueObject.source = val?.source || {
        citationSource: fromAnno["@id"] || fromAnno.id,
        citationNote: fromAnno.label || fromAnno.name || "Composed object from DEER",
        comment: "Learn about the assembler for this object at https://github.com/CenterForDigitalHumanities/deer"
    }
    valueObject.value = val?.value || getValue(val)
    valueObject.evidence = val?.evidence || fromAnno.evidence || ""
    return valueObject
}

/**
 * Merge targeting annotations onto an entity, DEER-shaping each asserted value.
 * Merged values carry `source.citationSource` = the asserting annotation's @id,
 * which is what keeps the create-vs-update trigger working on the editing path.
 * The entity's own literal values are preserved alongside annotation values,
 * matching the server's `/expanded` merge behavior.
 * @param {Object} entity the resolved entity document.  Not mutated.
 * @param {Array<Object>} annotations leaf-version annotation documents targeting the entity.
 * @param {Array<String>} matchOn dot-separated property paths for checkMatch.
 * @returns {Object} a new object with the assertions applied.
 */
export function applyAssertions(entity, annotations = [], matchOn = DEFAULT_MATCH_ON) {
    const assertOn = structuredClone(entity)
    for (const anno of annotations) {
        if (!checkMatch(entity, anno, matchOn)) { continue }
        let bodies = anno.body ?? []
        if (!Array.isArray(bodies)) { bodies = [bodies] }
        for (const body of bodies.flat(2)) {
            if (!body || typeof body !== "object") { continue }
            for (const [key, val] of Object.entries(body)) {
                if (val === undefined || val === null) { continue }
                mergeAssertion(assertOn, key, buildValueObject(val, anno))
            }
        }
    }
    return assertOn
}

/**
 * Attach one shaped assertion to the object under `key`, preserving any value
 * that is already there the way the server merge does: an existing value
 * becomes the first element of an array the assertion is appended to.
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

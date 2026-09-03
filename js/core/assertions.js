/**
 * @module assertions Annotation-merge logic and DEER value shaping.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * buildValueObject is lifted from the 0.11 UTILS.expand internals;
 * applyAssertions is ported from releases/rc-1.0/js/entities.js.
 *
 * Neither this module nor its callers decide WHOSE annotations to merge.  That
 * filter is part of the read on BOTH paths — `?generator=` on the server one,
 * the `__rerum.generatedBy` clause in expand.clientRead's query on the client.
 *
 * DEER emulates RERUM and so the decisions on how to format Annotations for expansion
 * mirrors what the RERUM API does.  These need to be kept in sync for the best functional
 * experience.
 */

import config from './config.js'
import { getValue } from './normalize.js'

/**
 * First-class properties of the entity itself — passed through shaping
 * untouched, and never merged into.  An annotation asserting one of these is
 * ignored: a DEER app declares `type`, `@type`, and `@context` directly on the
 * entity it creates and never relies on an Annotation to assert them.
 *
 * This list is the client half of the server's PROTECTED_EXPANSION_KEYS.
 * Since the server refuses these too, forDisplay can trust its merge for identity and
 * read it with a single request.
 */
export const IDENTITY_KEYS = ["@id", "id", "_id", "@type", "type", "@context", "__rerum", "__deleted"]

/**
 * Keys an Annotation may never assert onto an entity and that never survive
 * shaping.  A SUPERSET of the server's prototype-pollution guard: the server's
 * PROTECTED_EXPANSION_KEYS protects only `__proto__`, while DEER also refuses
 * `constructor` and `prototype` — so for those two keys the server merges (and
 * counts) an assertion the client declines, and its Annotations-Merged header
 * can run one over the client's citation count.
 */
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Body types the server folds whole into a single `bodyValue` assertion rather
 * than reading key by key.  Mirrored here so the two read paths agree on the KEY a
 * TextualBody lands under, not merely on the shape of the value.
 */
export const TEXTUAL_BODY_TYPES = new Set([
    "TextualBody", "oa:TextualBody",
    "http://www.w3.org/ns/oa#TextualBody", "https://www.w3.org/ns/oa#TextualBody"
])

/**
 * Objects this module has already shaped.  Identity-based, so a value object is
 * recognized because this module made it.
 */
const SHAPED = new WeakSet()

/**
 * The Annotation type spellings the server anticipates.  Mirrored here
 * because this list decides which documents the CLIENT read merges.
 */
const ANNOTATION_TYPES = new Set([
    "Annotation", "oa:Annotation",
    "http://www.w3.org/ns/oa#Annotation", "https://www.w3.org/ns/oa#Annotation"
])

/**
 * Accepts a string, an array of strings, or an array whose members are
 * themselves arrays
 *
 * @param {String|Array} typeValue the document's type or @type, or both.
 * @returns {Boolean}
 */
export function isAnnotationType(typeValue) {
    return [typeValue].flat(2).some(t => typeof t === "string" && ANNOTATION_TYPES.has(t))
}

/**
 * The same type list as query clauses, for a Mongo-style `$or`.  Nothing but an
 * Annotation asserts anything.
 *
 * @returns {Array<Object>} clauses for a Mongo-style `$or`.
 */
export function annotationTypeClauses() {
    return [...ANNOTATION_TYPES].flatMap(t => [{ "type": t }, { "@type": t }])
}

/**
 * Checks if an annotation body asserts itself whole as the server's `bodyValue`.
 *
 * @param {Object} body one body of an annotation.
 * @returns {Boolean}
 */
function isTextualBody(body) {
    return [body.type ?? body["@type"]].flat().some(t => TEXTUAL_BODY_TYPES.has(t))
}

/**
 * Both read paths must fail the same way on a document that came back empty.
 *
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
 * Regularizes assertions to enforce the existence of a `source` key.
 * The return is only the value of the assertion, so the desired key must be
 * applied upstream from the scope of this function.  Survives the heterogeneous
 * arrays `/expanded` produces, and is idempotent.  A value object this module
 * already built is returned unchanged, which is what lets shapeValues run over
 * a partly merged document.
 *
 * @param {any} val asserted value of the incoming annotation.
 * @param {Object} fromAnno parent annotation of the asserted value, as a handy metadata container.
 * @returns {Object} with `value`, `source`, and `evidence` keys.
 */
export function buildValueObject(val, fromAnno = {}) {
    if (val !== null && typeof val === "object" && SHAPED.has(val)) { return val }
    // An empty string is a value someone chose, not a missing one such as a field
    // a user deliberately cleared.
    const value = getValue(val)
    const citationSource = fromAnno["@id"] ?? fromAnno.id
    const valueObject = {
        source: (citationSource === undefined || citationSource === null) ? {} : { citationSource },
        value,
        evidence: fromAnno.evidence ?? ""
    }
    SHAPED.add(valueObject)
    return valueObject
}

/**
 * Re-register an already-shaped document's value objects after a
 * structuredClone, which produces new objects the SHAPED WeakSet has never
 * seen.
 *
 * Idempotence here is by object IDENTITY, deliberately — `source` and `value`
 * are ordinary vocabulary terms, so sniffing for them mistakes real data for a
 * value object.  The cost is that identity does not survive a clone, and
 * Entity#assertions memoizes a structuredClone of the shaped document.
 *
 * @param {Object} shaped a document this module produced, then cloned.
 * @returns {Object} the same document.
 */
export function markShaped(shaped) {
    for (const [key, val] of Object.entries(requireDocument(shaped, "Marking shaped"))) {
        if (IDENTITY_KEYS.includes(key)) { continue }
        for (const v of [val].flat()) {
            if (v !== null && typeof v === "object") { SHAPED.add(v) }
        }
    }
    return shaped
}

/**
 * The RERUM `_id` a document is stored under: the last path segment of its URI.
 * That is literally what the server matches on — `GET /v1/id/:_id/expanded`
 * looks the record up by this segment.
 *
 * @param {Object} doc a raw RERUM document.
 * @returns {String} the storage id, or "" when there is no usable URI.
 */
function storageId(doc) {
    const id = doc?.["@id"] ?? doc?.id
    return (typeof id === "string") ? id.slice(id.lastIndexOf("/") + 1) : ""
}

/**
 * Merge annotations oldest assertion first.
 *
 * The reason is chronology, not agreement with the server. A RERUM `_id` is a
 * Mongo ObjectId, whose leading four bytes are a creation timestamp.
 *
 * Sorting the bare storage id rather than the whole URI is deliberate: the
 * server compares bare `_id`s.
 *
 * @param {Array<Object>} annotations annotation documents, unordered.
 * @returns {Array<Object>} a new array, oldest assertion first.
 */
function inAssertionOrder(annotations) {
    return [...annotations].sort((a, b) => {
        const left = storageId(a)
        const right = storageId(b)
        if (left < right) { return -1 }
        return (left > right) ? 1 : 0
    })
}

/**
 * Wrap every asserted value on a document in DEER's `{value, source, evidence}`
 * shape, leaving identity keys alone.  Both read paths end here, so consumers
 * get one rule: a non-identity value is a value object, or an array of value
 * objects.  Values already shaped during the merge pass through unchanged.
 *
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
 * Merge targeting annotations onto an entity, WITHOUT shaping the result.
 *
 * This is the client's port of the server's `applyExpansionAnnotations`, and
 * with `provenance: false` it produces the same kind of document `/expanded`
 * returns: raw merged values, no `{value, source, evidence}` wrapper anywhere.
 *
 * @param {Object} entity the resolved entity document, RAW — pass the fetched
 * document, never an already-shaped one.
 * @param {Array<Object>} annotations annotation documents targeting the entity,
 * already filtered to this deployment's.
 * @param {Object} options `provenance` (default true) wraps each merged value in
 * a value object carrying `source.citationSource`. Pass false for a display-strategy
 * merge.
 * @returns {Object} a new object with the assertions applied.  Not shaped.
 */
export function mergeAssertions(entity, annotations = [], { provenance = true } = {}) {
    const assertOn = structuredClone(requireDocument(entity, "mergeAssertions"))
    // A deleted record accepts no assertions.
    if (Object.hasOwn(assertOn, "__deleted")) { return assertOn }
    // The raw value is merged as-is — exactly what the server hands back.
    const contribute = provenance
        ? (val, anno) => buildValueObject(val, anno)
        : (val) => val
    for (const anno of inAssertionOrder(annotations)) {
        // An annotation with no id has no citationSource to contribute
        const annoId = anno?.["@id"] ?? anno?.id
        if (annoId === undefined || annoId === null) { continue }
        // A superseded annotation asserts nothing.
        if (anno?.__rerum?.history?.next?.length) { continue }
        const hasBodyValue = typeof anno.bodyValue === "string"
        if (hasBodyValue) {
            mergeAssertion(assertOn, "bodyValue", contribute(anno.bodyValue, anno))
        }
        // In JSON-LD a one-element Array and the bare value are the same body, so
        // unwrap it before counting bodies.  What follows is about how many
        // bodies the Annotation carries, not how they were serialized.
        const body = (Array.isArray(anno.body) && anno.body.length === 1) ? anno.body[0] : anno.body
        // Multiple bodies, no body, and a bare IRI string body referencing an
        // external resource all assert nothing the server would merge.  Any
        // bodyValue assertion above still stands.
        if (Array.isArray(body) || !body || typeof body !== "object") { continue }
        // A TextualBody asserts itself whole under `bodyValue`, the way the
        // server does.
        if (isTextualBody(body)) {
            mergeAssertion(assertOn, "bodyValue", contribute(body, anno))
            continue
        }
        const keys = Object.keys(body)
        // Any other multi-key body is structural rather than assertional and
        // cannot be attributed to a single entity property.  This is what skips
        // the Choice, Composite, and List multiplicity constructs.
        if (keys.length !== 1) { continue }
        const key = keys[0]
        const val = body[key]
        if (FORBIDDEN_KEYS.has(key)) {
            if (config.DEBUG) { console.warn(`Annotation ${anno["@id"] ?? anno.id} asserts the reserved key '${key}'; ignoring.`) }
            continue
        }
        if (IDENTITY_KEYS.includes(key)) {
            if (config.DEBUG) { console.warn(`Annotation ${anno["@id"] ?? anno.id} asserts identity key '${key}'; ignoring.`) }
            continue
        }
        // A null or undefined member is merged RAW either way and dropped later by shapeValues.
        const shapeOne = (one) => (one === undefined || one === null) ? one : contribute(one, anno)
        mergeAssertion(assertOn, key, Array.isArray(val) ? val.map(shapeOne) : shapeOne(val))
    }
    return assertOn
}

/**
 * Merge targeting annotations onto an entity and DEER-shape the result — the
 * editing path's read, provenance intact.
 *
 * @param {Object} entity the resolved entity document, RAW.
 * @param {Array<Object>} annotations annotation documents targeting the entity.
 * @returns {Object} a new, DEER-shaped object with the assertions applied.
 */
export function applyAssertions(entity, annotations = []) {
    return shapeValues(mergeAssertions(entity, annotations))
}

/**
 * Attach one annotation's contribution to the object under `key`, preserving any
 * value already there: an existing value becomes the first element of an array
 * the contribution is appended to.  Raw values left here are shaped by the
 * shapeValues pass that follows.
 *
 * A port of the server's applyExpansionAnnotations.
 *
 * @param {Object} target the document being merged onto, mutated in place.
 * @param {String} key the property the annotation asserts.
 * @param {any} contributed the contributed value, or an array of them.
 */
function mergeAssertion(target, key, contributed) {
    if (!Object.hasOwn(target, key)) {
        target[key] = contributed
        return
    }
    const existing = Array.isArray(target[key]) ? target[key] : [target[key]]
    target[key] = [...existing, ...(Array.isArray(contributed) ? contributed : [contributed])]
}

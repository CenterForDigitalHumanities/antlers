/**
 * @module assertions Annotation-merge logic and DEER value shaping.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * buildValueObject is lifted from the 0.11 UTILS.expand internals;
 * applyAssertions is ported from releases/rc-1.0/js/entities.js.
 *
 * Neither this module nor its callers decide WHOSE annotations to merge.  That
 * filter is part of the read — `?generator=` on the server path, the
 * `__rerum.generatedBy` clause in expand.clientRead's query on the client one —
 * so applyAssertions merges exactly what it is handed.  0.11 and rc-1.0 filtered
 * here instead, with a checkMatch that compared the annotation's generator to
 * the ENTITY's; that silently disagreed with the server, which has always
 * compared against the deployment's own agent, whenever an app read an entity
 * some other app created.
 *
 * shapeValues lives here because both read paths finish with it: the client
 * merge below and the server `/expanded` response in ./expand.js come out
 * identically shaped, so `source.citationSource` is the only thing that differs
 * between them.  Keeping that true means matching the server's body-reading
 * rules, not just its output shape — see TEXTUAL_BODY_TYPES and the bodyValue
 * handling in applyAssertions.
 */

import config from './config.js'
import { getValue } from './normalize.js'

/**
 * First-class properties of the entity itself — passed through shaping
 * untouched, and never merged into.  An annotation asserting one of these is
 * ignored: a DEER app declares `type`, `@type`, and `@context` directly on the
 * entity it creates and never relies on an Annotation to assert them, so an
 * annotation that tries to is either a mistake or someone else redefining what
 * your entity IS and what its properties MEAN.  RERUM is open, so that is not a
 * hypothetical.  `__rerum` carries the record's provenance, and `@id`/`id`
 * are the primary key, so those must never be wrapped either.  `_id` and
 * `__deleted` are here for the same reason: an Annotation asserting either is
 * claiming to rewrite the record's primary key or to bury it.
 *
 * This list is the client half of the server's PROTECTED_EXPANSION_KEYS
 * (rerum_server_nodejs/controllers/utils.js) — same membership, minus
 * `__proto__`, which FORBIDDEN_KEYS below handles more strictly.  Because the
 * server refuses these too, forDisplay can trust its merge for identity and
 * read it with a single request; keep the two lists in step or the read paths
 * will disagree about what an Annotation is allowed to say.
 *
 * isAnnotationType reads type off RAW fetched documents, never shaped ones, so
 * it is unaffected by anything here.
 */
export const IDENTITY_KEYS = ["@id", "id", "_id", "@type", "type", "@context", "__rerum", "__deleted"]

/**
 * Keys an Annotation may never assert onto an entity and that never survive
 * shaping.  The prototype-pollution corner of the server's
 * PROTECTED_EXPANSION_KEYS (rerum_server_nodejs/controllers/utils.js);
 * IDENTITY_KEYS above covers the rest of that list.  structuredClone plus
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
 * The Annotation type spellings the server anticipates
 * (rerum_server_nodejs/controllers/utils.js annoTypeConditions).  Mirrored here
 * because this list decides which documents the CLIENT read merges: a spelling
 * the server gathers and this set does not is an annotation `/expanded` merges
 * and the client path silently drops — and the merge counts agree, so
 * forDisplay's divergence guard never fires.
 */
const ANNOTATION_TYPES = new Set([
    "Annotation", "oa:Annotation",
    "http://www.w3.org/ns/oa#Annotation", "https://www.w3.org/ns/oa#Annotation"
])

/**
 * Is this `type`/`@type` value an Annotation?  Accepts a string or an array of
 * strings; matches the spellings the server matches, plus any namespace-prefixed
 * form — deliberately NOT a substring match, so "AnnotationPage" does not
 * qualify.  The `:Annotation` clause is deliberately BROADER than the server's
 * fixed `oa:` spelling: erring wide costs a merge the server declined, which the
 * counts guard catches, while erring narrow drops an assertion silently.
 * @param {String|Array<String>} typeValue the document's type or @type.
 * @returns {Boolean}
 */
export function isAnnotationType(typeValue) {
    return [typeValue].flat().some(t =>
        typeof t === "string" && (ANNOTATION_TYPES.has(t) || t.endsWith(":Annotation")))
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
    // An empty string is a value someone chose, not a missing one — a field a
    // user deliberately cleared.  getValue reports a BARE "" as undefined (0.11
    // treats it as "no value" and every other consumer of getValue still depends
    // on that, so normalize is left alone) while reporting a WRAPPED one —
    // {value: ""} — as "".  Restoring it here settles that disagreement and
    // keeps the documented contract true: a non-identity value is always a
    // value object, and a value object always has a `value` key.  Without it a
    // cleared field shaped to {source, evidence} with no `value` at all.
    const value = (val === "") ? "" : getValue(val)
    const valueObject = {
        source: { citationSource: fromAnno["@id"] ?? fromAnno.id },
        value,
        evidence: fromAnno.evidence ?? ""
    }
    SHAPED.add(valueObject)
    return valueObject
}

/**
 * The RERUM `_id` a document is stored under: the last path segment of its URI.
 * That is literally what the server matches on — `GET /v1/id/:_id/expanded`
 * looks the record up by this segment.
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
 * Mongo ObjectId, whose leading four bytes are a creation timestamp, and
 * `@id` is minted as `RERUM_ID_PREFIX + _id` (crud.js), so the last path
 * segment of an annotation's URI sorts it by when it was asserted. "In the
 * order someone said it" is the only ordering this data actually carries, and
 * a merged property is otherwise a set with an accidental order.
 *
 * Merging in raw `POST /query` order got this measurably wrong, not merely
 * differently: on `5d7ba417e4b07f0c56c0f539`, `doubling` came back
 * `["The second of two", "The first of two"]` — values that name their own
 * order, reversed. Mongo promises no order, and it is worth being precise about
 * what that means here: the unsorted order proved STABLE across repeated reads
 * and across page limits, so this was never flapping between renders. It was
 * consistently arbitrary, which is harder to notice.
 *
 * Cross-path agreement then follows as a consequence rather than a goal.
 * `findLeafAnnotationsFor` (rerum_server_nodejs/controllers/utils.js) sorts its
 * matches by `String(_id)` for a reason of its own — a stable ETag, so a
 * revalidation can answer 304 — and `crud.js` merges that array in order. Both
 * sides independently choose creation order, so the two reads assemble the same
 * document.
 *
 * That independence is the point, and it is why this is NOT written as "keep in
 * step with the server". If `/expanded` ever reorders its gather, DEER's output
 * stays chronological, stable, and self-consistent; only agreement with the
 * server degrades, and it degrades into a visible ordering difference rather
 * than into corrupted values. Do not change this rule to chase the server's.
 *
 * Sorting the bare storage id rather than the whole URI is deliberate: the
 * server compares bare `_id`s, so on a deployment listing more than one entry
 * in config.ID_BASES a full-URI sort would group by host before it sorted by
 * time.
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
 * Every annotation handed in IS merged: whose annotations to merge is settled
 * by the read (see the module note), so pass the annotations a read returned,
 * never an unfiltered query result.
 * @param {Object} entity the resolved entity document, RAW — pass the fetched
 * document, never an already-shaped one.
 * @param {Array<Object>} annotations annotation documents targeting the entity,
 * already filtered to this deployment's.
 * @returns {Object} a new, DEER-shaped object with the assertions applied.
 */
export function applyAssertions(entity, annotations = []) {
    const assertOn = structuredClone(requireDocument(entity, "applyAssertions"))
    // Oldest assertion first, not the order the query happened to return them
    // in — see inAssertionOrder.  Sorted here rather than in expand.clientRead
    // because this is the single funnel both editing consumers reach:
    // clientMerge, and Entity#assertions re-merging from Entity.Annotations.
    // That Map is keyed by version chain and preserves INSERTION order, so an
    // updated annotation would otherwise hold the position its superseded
    // version had — its edit would sort as though it were the original.
    for (const anno of inAssertionOrder(annotations)) {
        // An annotation with no id has no citationSource to contribute, and a
        // value merged without one makes the next form save POST a duplicate
        // assertion instead of updating.  Entity#attachAnnotation already
        // refuses these for the same reason, so skipping here is what keeps the
        // two editing entry points — expand.forEditing and Entity#assertions —
        // returning the same document.  `@id` or `id`: RERUM negotiates which
        // one it returns from the document's own @context.
        const annoId = anno?.["@id"] ?? anno?.id
        if (annoId === undefined || annoId === null) { continue }
        // A superseded annotation asserts nothing.  RERUM mints a new @id on
        // update, so a stale version merged beside its replacement would yield
        // two conflicting values and two citationSources.  The queries filter
        // to leaves, but Entity.Annotations can outlive a write.  0.11 guarded
        // this the same way (deer-utils.js:150).
        if (anno?.__rerum?.history?.next?.length) { continue }
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
 *
 * Only undefined and null count as absent.  An existing "" is a value — the
 * same rule buildValueObject follows — so an assertion arrives BESIDE it rather
 * than overwriting it.  The two treating "" differently is how a cleared field
 * silently lost the entity's own value on one path and kept it on the other.
 */
function mergeAssertion(target, key, assertion) {
    const existing = target[key]
    if (existing === undefined || existing === null) {
        target[key] = assertion
        return
    }
    if (Array.isArray(existing)) {
        existing.push(assertion)
        return
    }
    target[key] = [existing, assertion]
}

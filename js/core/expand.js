/**
 * @module expand Entity resolution strategy — two read paths, chosen by consumer.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * forDisplay: the server-side merge (`GET …/expanded?generator=`) — cacheable,
 * no provenance.  Views and lists use this.
 *
 * forEditing: the client path — the entity document and its targeting
 * annotations, merged with applyAssertions.  Every merged value carries
 * `source.citationSource` = the asserting annotation's @id, which is what
 * deer-form prefills from and what keeps the create-vs-update trigger working.
 * Forms use this.
 *
 * clientRead is the read underneath both of those, exposed because Entity needs
 * the PARTS rather than the merge: it keys annotations by version chain and
 * re-merges whenever one changes, which a merged document cannot support.  One
 * read, two consumers — Entity does not re-derive it.
 *
 * Both merged paths return the same shape — every non-identity value is a
 * `{value, source, evidence}` object, or an array of them — because both finish
 * in assertions.shapeValues.  Provenance is the only difference:
 * `source.citationSource` and `evidence` are annotation-level, so the server
 * read carries neither.
 *
 * Views must never call forEditing; forms must never call forDisplay.
 * (Enforced by the elements in a later PR; recorded here as the contract.)
 */

import config from './config.js'
import * as rerum from './rerum.js'
import { IDENTITY_KEYS, applyAssertions, isAnnotationType, requireDocument, shapeValues } from './assertions.js'

/** Keep only the documents that are actually Annotations. */
const onlyAnnotations = (finds) => (Array.isArray(finds) ? finds : [])
    .filter(doc => isAnnotationType(doc.type ?? doc["@type"]))

/**
 * The client read path: an entity document and the Annotation documents
 * targeting it, RAW.  Both editing consumers share this — forEditing() below,
 * which merges immediately, and Entity, which holds the annotations so it can
 * key them by version chain and re-merge whenever one changes.  Returning the
 * parts instead of the merge is what lets those two share one read: an Entity
 * handed a merged document could no longer tell its own values from asserted
 * ones, and re-merging over it duplicates every value.
 *
 * Default (`lazy: false`) is ONE round trip — a compound `$or` query matching
 * the entity's own @id alongside every targeting style.  The leaf filter
 * excludes an entity that has since been updated, and a full page can crowd it
 * out, so the entity is recovered with a direct GET when the query did not
 * return it.
 *
 * `lazy: true` issues the entity GET and the targeting query in parallel
 * instead: two requests, but the GET is an ordinary cacheable read.  Used for
 * foreign URIs, which a RERUM `@id` query can never resolve.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh` busts the HTTP cache on the entity GET;
 * `lazy` chooses the parallel reads; `entity` supplies an already-fetched
 * entity document, which skips the compound query.
 * @returns {Promise<{entity: Object, annotations: Array<Object>}>} raw documents.
 */
export async function clientRead(id, { fresh = false, lazy = false, entity: known } = {}) {
    const uri = rerum.idOf(id)
    if (!lazy && known === undefined) {
        const uris = rerum.httpsIdArray(uri)
        const finds = await rerum.query({
            "$or": [{ "@id": uris }, { "target": uris }, { "target.@id": uris }, { "target.id": uris }],
            "__rerum.history.next": { "$exists": true, "$size": 0 }
        })
        const list = Array.isArray(finds) ? finds : []
        if (list.length >= config.LIMIT) {
            // Not gated behind DEBUG: a dropped annotation costs the editing
            // path a citationSource, and a missing citationSource makes the next
            // save POST a duplicate assertion instead of updating.
            console.warn(`${uri}: compound query returned a full page (limit ${config.LIMIT}). Annotations beyond the limit are not merged and their provenance is lost — a form prefilled from this read may create duplicate assertions.`)
        }
        // `@id` or `id` — RERUM negotiates which one it returns from the
        // document's own @context, so a document authored against
        // anno.jsonld comes back keyed `id`.  Matching only `@id` would miss
        // the entity in its own query result and pay for a needless GET.
        const isSelf = (doc) => rerum.canonicalId(doc?.["@id"] ?? doc?.id) === rerum.canonicalId(uri)
        const entity = list.find(isSelf) ?? await rerum.resolve(uri, { fresh })
        return {
            entity: requireDocument(entity, `The read of ${uri}`),
            annotations: onlyAnnotations(list.filter(doc => !isSelf(doc)))
        }
    }
    const [entity, finds] = await Promise.all([
        // The display path has already fetched this when it falls back here.
        known ?? rerum.resolve(uri, { fresh }),
        rerum.findByTargetId(uri)
    ])
    return {
        entity: requireDocument(entity, `The read of ${uri}`),
        annotations: onlyAnnotations(finds)
    }
}

/**
 * Resolve an entity for display: server-side annotation merge for RERUM-hosted
 * ids, client query fallback for foreign URIs and non-RERUM deployments.
 * Cacheable (the server sends max-age=86400, must-revalidate) and carries no
 * annotation provenance.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `generator` overrides config.GENERATOR;
 * `fresh: true` busts the HTTP cache (read-after-write).
 * @returns {Promise<Object>} DEER-shaped entity: asserted properties become
 * `{value, source, evidence}` objects (arrays thereof when multivalued).
 */
export async function forDisplay(id, { generator, fresh = false } = {}) {
    const uri = rerum.idOf(id)
    if (!rerum.isRerumId(uri)) { return clientMerge(uri, { fresh, lazy: true }) }
    // Two parallel cacheable GETs.  The merge cannot be trusted for the keys in
    // IDENTITY_KEYS -- the server merges an annotation-asserted `type`/`@type`
    // and nothing in its response says which values were the entity's own -- so
    // the entity document comes along to restore them.  Issued together, both
    // served from the HTTP cache on repeat loads.
    const [expansion, entity] = await Promise.all([
        rerum.expanded(uri, { generator, fresh }),
        rerum.resolve(uri, { fresh })
    ])
    const { document, gathered, merged } = expansion
    if (Number.isFinite(gathered) && Number.isFinite(merged) && gathered !== merged) {
        // The server merges a body only when it is an object with exactly one
        // key; multi-key bodies and array bodies are gathered and then dropped.
        // Whatever it declined is absent from this document and unrecoverable
        // from it, so re-read the client way and let the two paths agree.
        // DEER writes one key per annotation, so its own data never trips this.
        if (config.DEBUG) { console.warn(`${uri}: server merged ${merged} of ${gathered} annotations. Falling back to the client read path so no asserted property is silently dropped.`) }
        return clientMerge(uri, { fresh, lazy: true, entity })
    }
    return shapeValues(authoritativeIdentity(
        requireDocument(document, `The expanded read of ${uri}`),
        requireDocument(entity, `The read of ${uri}`)
    ))
}

/**
 * Restore the entity's own first-class properties over the server's merge.
 * A DEER app declares `type`, `@type`, and `@context` on the entity it creates
 * and never asserts them through an Annotation, so the entity document is the
 * only authority for them -- and the server does not protect them the way it
 * protects `@id` and `__rerum`.  Without this, any annotation carrying `@type`
 * would append to the entity's type on the display path while the client path
 * (which refuses the same assertion) kept it clean.
 * @param {Object} merged the server's expanded document.  Not mutated.
 * @param {Object} entity the entity document as stored.
 * @returns {Object} the merge, with every identity key taken from the entity.
 */
function authoritativeIdentity(merged, entity) {
    const reconciled = { ...merged }
    for (const key of IDENTITY_KEYS) {
        if (Object.hasOwn(entity, key)) { reconciled[key] = entity[key] }
        else { delete reconciled[key] }
    }
    return reconciled
}

/**
 * Resolve an entity for editing: always the client path, always cache-busted —
 * a form prefill must never show a stale read after a write.  Merged values
 * carry `source.citationSource` so the form knows which annotation to update.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `lazy: true` reads the entity and its annotations in
 * parallel instead of through the one-round-trip compound query.
 * @returns {Promise<Object>} DEER-shaped entity with full annotation provenance.
 */
export async function forEditing(id, { lazy = false } = {}) {
    return clientMerge(rerum.idOf(id), { fresh: true, lazy })
}

/** clientRead plus the merge — what every consumer that wants a document uses. */
async function clientMerge(uri, options) {
    const { entity, annotations } = await clientRead(uri, options)
    return applyAssertions(entity, annotations)
}

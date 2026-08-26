/**
 * @module expand Entity resolution strategy — two read paths, chosen by consumer.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * forDisplay: the server-side merge (`GET …/expanded?generator=`) — one
 * cacheable request, no provenance.  Views and lists use this.
 *
 * forEditing: the client path — the entity document and its targeting
 * annotations fetched in parallel, merged with applyAssertions.  Every merged
 * value carries `source.citationSource` = the asserting annotation's @id, which
 * is what deer-form prefills from and what keeps the create-vs-update trigger
 * working.  Forms use this.
 *
 * Both paths return the same shape — every non-identity value is a
 * `{value, source, evidence}` object, or an array of them — because both
 * finish in assertions.shapeValues.  Provenance is the only difference:
 * `source.citationSource` and `evidence` are annotation-level, so the server
 * read carries neither.
 *
 * Views must never call forEditing; forms must never call forDisplay.
 * (Enforced by the elements in a later PR; recorded here as the contract.)
 */

import config from './config.js'
import * as rerum from './rerum.js'
import { DEFAULT_MATCH_ON, IDENTITY_KEYS, applyAssertions, isAnnotationType, requireDocument, shapeValues } from './assertions.js'

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
    if (!rerum.isRerumId(uri)) { return clientExpand(uri, { fresh }) }
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
        return clientExpand(uri, { fresh, entity })
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
 * @returns {Promise<Object>} DEER-shaped entity with full annotation provenance.
 */
export async function forEditing(id) {
    return clientExpand(rerum.idOf(id), { fresh: true })
}

/**
 * The client read path: entity document and targeting annotations fetched in
 * parallel (the 0.11 runtime serialized these — most of the perceived cost),
 * then merged.  The annotation query is a POST and so is never cached; only the
 * entity GET has a cache mode to choose.
 */
async function clientExpand(uri, { fresh = false, entity: known } = {}) {
    const [entity, finds] = await Promise.all([
        // The display path has already fetched this when it falls back here.
        known ?? rerum.resolve(uri, { fresh }),
        rerum.findByTargetId(uri)
    ])
    const annotations = (Array.isArray(finds) ? finds : [])
        .filter(a => isAnnotationType(a.type ?? a['@type']))
    return applyAssertions(requireDocument(entity, `The read of ${uri}`), annotations, DEFAULT_MATCH_ON)
}

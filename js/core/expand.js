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
 * Views must never call forEditing; forms must never call forDisplay.
 * (Enforced by the elements in a later PR; recorded here as the contract.)
 */

import * as rerum from './rerum.js'
import { applyAssertions, buildValueObject, isAnnotationType } from './assertions.js'

// Client-path filter: an annotation augments the entity when its
// __rerum.generatedBy or creator matches the entity's own.  Self-adapting to
// proprietary TinyNode agents — no configuration needed on this path.
const MATCH_ON = ["__rerum.generatedBy", "creator"]

// Passed through untouched by the display shaping — identity, not assertion.
const IDENTITY_KEYS = ["@id", "id", "@type", "type", "@context", "__rerum"]

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
    if (rerum.isRerumId(uri)) {
        const merged = await rerum.expanded(uri, { generator, fresh })
        return shapeExpanded(merged)
    }
    return clientExpand(uri, { fresh })
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
 * then merged.
 */
async function clientExpand(uri, { fresh = false } = {}) {
    const [entity, finds] = await Promise.all([
        rerum.resolve(uri, { fresh }),
        rerum.findByTargetId(uri, { fresh })
    ])
    const annotations = (Array.isArray(finds) ? finds : [])
        .filter(a => isAnnotationType(a.type ?? a['@type']))
    return applyAssertions(entity, annotations, MATCH_ON)
}

/**
 * Shape a raw `/expanded` response into DEER form: every asserted property
 * becomes a `{value, source, evidence}` object.  The server drops annotation
 * @ids, so `source.citationSource` is undefined on this path — the documented
 * divergence from the editing path.
 */
function shapeExpanded(merged) {
    const shaped = {}
    for (const [key, val] of Object.entries(merged)) {
        if (IDENTITY_KEYS.includes(key)) {
            shaped[key] = val
            continue
        }
        // A null merged value asserts nothing — the server passes annotation
        // nulls straight through, and shaping one would be a crash, not a value.
        if (val === undefined || val === null) { continue }
        shaped[key] = Array.isArray(val)
            ? val.filter(v => v !== undefined && v !== null).map(v => buildValueObject(v))
            : buildValueObject(val)
    }
    return shaped
}

/**
 * @module expand Entity resolution strategy — two read paths, chosen by consumer.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Controls the expand logic that gathers Annotation objects targeting an
 * entity.  Annotation bodies are gathered and placed onto the entity
 * results in a single assembled and described entity.  This is a combined
 * effort with RERUM API services and DEER client functionality.
 */

import config from './config.js'
import * as rerum from './rerum.js'
import { annotationTypeClauses, applyAssertions, isAnnotationType, mergeAssertions, requireDocument, shapeValues } from './assertions.js'

/**
 * RERUM deployments already reported as sending no merge-count headers.  The
 * defect is per-deployment and permanent for the session, so warning per read
 * would bury the console under one real problem.
 */
const uncountedDeployments = new Set()

/**
 * Drop the per-deployment warning bookkeeping.  For teardown and tests only —
 * entity.js clearEntities() calls this, because a Set left populated here
 * outlives the session it belongs to and silently suppresses a warning the next
 * one should see.
 */
export function clearWarnings() {
    uncountedDeployments.clear()
}

/**
 * Keep only the documents that are actually Annotations.
 */
const onlyAnnotations = (finds) => (Array.isArray(finds) ? finds : [])
    .filter(doc => doc && isAnnotationType([doc.type, doc["@type"]]))

/**
 * Refuse an id DEER cannot work with.  DEER creates entities in RERUM and
 * annotates them through the RERUM API; an entity outside RERUM has no
 * `/expanded` merge, no queryable annotations, and nothing DEER could write
 * back to.
 *
 * The common cause is not foreign data at all but a RERUM deployment on a host
 * config.ID_BASES does not list, so the message names that first.
 *
 * @param {String} uri the entity URI.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
function requireRerumId(uri) {
    if (rerum.isRerumId(uri)) { return }
    throw new TypeError(`${uri} is not hosted by RERUM, and DEER reads and writes RERUM entities only. Ids must be bare URIs — no query string, no fragment, no trailing slash. If this IS your RERUM deployment, add its id base to config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}).`)
}

/**
 * The properties an Annotation can carry the URI of its target under.
 * KEEP IN STEP WITH THE SERVER: a key the server matches and this list does not
 * is an annotation `/expanded` merges and the client read never sees.
 */
const TARGET_KEYS = ["target", "target.@id", "target.id",
    "target.source", "target.source.@id", "target.source.id"]

/** Escape the RegExp metacharacters in a literal so it matches only itself. */
const escapeRegex = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A paged query for every document matching a query.
 *
 * @param {Object} body the query document.
 * @param {String} label what is being read, for the refusal message.
 * @returns {Promise<Array<Object>>} every matching document.
 * @throws {RangeError} past config.MAX_RESULTS, rather than returning a partial merge.
 */
async function queryAll(body, label) {
    // Guarded: a deployment that configures LIMIT at 0 or below would otherwise
    // page forever, asking for nothing each time.
    let page = Math.max(1, config.LIMIT)
    // This stops clients from silently truncating.
    // It is a guard against a known RERUM setting that keeps paging mechanics honest.
    if (page > config.MAX_LIMIT) page = Math.max(1, config.MAX_LIMIT)
    const all = []
    const seen = new Set()
    // Counts RAW documents fetched, not deduped ones.
    let fetched = 0
    for (let skip = 0; ; skip += page) {
        const finds = await rerum.query(body, { limit: page, skip })
        const list = Array.isArray(finds) ? finds : []
        fetched += list.length
        for (const doc of list) {
            const key = rerum.canonicalId(doc?.["@id"] ?? doc?.id)
            // A document with no id has no identity to dedupe on.  It is kept —
            // the reads downstream discard it on their own terms.
            if (typeof key !== "string") { all.push(doc); continue }
            if (seen.has(key)) { continue }
            seen.add(key)
            all.push(doc)
        }
        if (list.length < page) { return all }
        if (fetched > config.MAX_RESULTS) {
            throw new RangeError(`${label}: more than ${config.MAX_RESULTS} documents fetched without reaching the end of this read.`)
        }
    }
}

/**
 * Every way an Annotation can name this entity as its target: each target key
 * against both protocol spellings, and each against a FRAGMENT of the URI
 * (`…#xywh=0,0,100,100`), which is the other W3C way to target part of a
 * resource and which an exact match does not catch.  `target.source` is the
 * W3C SpecificResource.
 *
 * @param {String} uri the entity URI.
 * @returns {Array<Object>} clauses for a Mongo-style `$or`.
 */
function targetingClauses(uri) {
    const uris = rerum.httpsIdArray(uri)
    const fragments = ["http", "https"]
        .map(scheme => `^${escapeRegex(uri.replace(/^https?/, scheme))}#`)
    return TARGET_KEYS.flatMap(key => [
        { [key]: uris },
        ...fragments.map(pattern => ({ [key]: { "$regex": pattern } }))
    ])
}

/**
 * The one query both client reads issue: every leaf Annotation this deployment
 * wrote against any URI the record answers to.
 *
 * The client's mirror of the server's findLeafAnnotationsFor.
 *
 * @param {Array<String>} uris every URI to match as a target.
 * @returns {Object} the query document.
 * @throws {TypeError} when no generator is configured.
 */
function targetingQuery(uris) {
    return {
        "$and": [
            { "$or": uris.flatMap(targetingClauses) },
            // Nothing but an Annotation asserts anything.
            { "$or": annotationTypeClauses() }
        ],
        "__rerum.generatedBy": rerum.generatedBy(),
        "__rerum.history.next": { "$exists": true, "$size": 0 }
    }
}

/**
 * The client read path: an entity document and the Annotation documents
 * targeting it, RAW.
 *
 * TWO requests, issued in PARALLEL, so the cost is the slower of the pair: a
 * direct GET for the entity and one paged query for the annotations targeting
 * it.  A record with a RERUM Slug costs one further query.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh` busts the HTTP cache on the entity GET.
 * @returns {Promise<{entity: Object, annotations: Array<Object>}>} raw documents:
 * the entity, and the annotations THIS deployment wrote against it.  The
 * generator filter is part of the query, so a merge never has to re-check who
 * asserted what.
 * @throws {TypeError} when the id is not RERUM-hosted, or no generator is configured.
 */
export async function clientRead(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireRerumId(uri)
    // An unconfigured generator must refuse this read without leaving the entity GET in flight.
    const annotationQuery = targetingQuery([uri])
    // Both reads are independent, so neither waits on the other.
    const [resolved, list] = await Promise.all([
        rerum.resolve(uri, { fresh }),
        queryAll(annotationQuery, uri)
    ])
    const entity = requireDocument(resolved, `The read of ${uri}`)
    // The entity cannot assert about itself.  It reaches the annotation list
    // only by targeting its own URI, which would otherwise merge it onto itself.
    const isSelf = (doc) => rerum.canonicalId(doc?.["@id"] ?? doc?.id) === rerum.canonicalId(uri)
    const annotations = onlyAnnotations(list.filter(doc => !isSelf(doc)))
    return {
        entity,
        annotations: annotations.concat(await aliasTargetedAnnotations(entity, uri, annotations))
    }
}

/**
 * Every URI this record answers to: its own `@id` and, when it has one, its
 * RERUM Slug URI.
 *
 * @param {Object} entity the raw entity document.
 * @returns {Array<String>} the URIs, in no particular order.
 */
function recordUris(entity) {
    const own = entity?.["@id"] ?? entity?.id
    return [own, rerum.slugUriOf(entity)].filter(u => typeof u === "string" && u.length > 0)
}

/**
 * The annotations targeting a URI this record answers to that the FIRST query
 * did not cover. Costs nothing for a record with no slug.
 *
 * A SECOND round trip, and unavoidable: the server knows every URI before it
 * queries because it has already loaded the record, while a client cannot learn
 * the others until the first read hands it the document.
 *
 * @param {Object} entity the raw entity document.
 * @param {String} requestedUri the URI clientRead was called with, already covered.
 * @param {Array<Object>} found the annotations the first query already returned.
 * @returns {Promise<Array<Object>>} the additional annotations, deduplicated.
 */
async function aliasTargetedAnnotations(entity, requestedUri, found) {
    const requested = rerum.canonicalId(requestedUri)
    const aliases = recordUris(entity).filter(u => rerum.canonicalId(u) !== requested)
    if (aliases.length === 0) { return [] }
    const list = await queryAll(targetingQuery(aliases), aliases.join(", "))
    // An annotation can name the entity by BOTH URIs, and the entity itself can
    // come back here when the slug resolves to it, so dedupe on what the first
    // query already produced rather than trusting the two result sets to be
    // disjoint.
    const seen = new Set([...found, entity]
        .map(doc => rerum.canonicalId(doc?.["@id"] ?? doc?.id))
        .filter(k => typeof k === "string"))
    return onlyAnnotations(list).filter(doc => !seen.has(rerum.canonicalId(doc["@id"] ?? doc.id)))
}

/**
 * Resolve an entity for display, RAW — the server-side annotation merge exactly
 * as `/expanded` returns it.  Cacheable (the server sends max-age=86400,
 * must-revalidate) and carries no annotation provenance.
 * DEER filters every read by the one agent in config.GENERATOR, so the server request
 * and the client fallback below always merge the same annotations.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
 * @returns {Promise<Object>} the merged entity document, unshaped.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
export async function forDisplayRaw(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireRerumId(uri)
    const { document, gathered, merged } = await rerum.expanded(uri, { fresh })
    if (gathered === null || merged === null) {
        const deployment = config.ID_BASES.find(base => rerum.canonicalId(uri).startsWith(base)) ?? uri
        if (!uncountedDeployments.has(deployment)) {
            uncountedDeployments.add(deployment)
            console.warn(`${deployment} does not send the Annotations-Gathered/Annotations-Merged headers on /expanded, so the completeness of the server merge cannot be verified. Every display read falls back to the client path: correct, but the cacheable read path is effectively disabled and each read now costs three requests instead of one. Upgrade the RERUM deployment.`)
        }
        const { entity, annotations } = await clientRead(uri, { fresh })
        return mergeAssertions(entity, annotations, { provenance: false })
    }
    if (gathered !== merged && config.DEBUG) {
        console.debug(`${uri}: server merged ${merged} of ${gathered} annotations. The rest assert nothing DEER reads (multi-key, multi-body, or protected-key bodies); the client path declines them too — and declines slightly more, refusing 'constructor' and 'prototype' bodies the server merges.`)
    }
    return requireDocument(document, `The expanded read of ${uri}`)
}

/**
 * Resolve an entity for display, DEER-shaped.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
 * @returns {Promise<Object>} DEER-shaped entity: asserted properties become
 * `{value, source, evidence}` objects (arrays thereof when multivalued).  No
 * value carries a `citationSource` — the display path never has one to carry.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
export async function forDisplay(id, options) {
    return shapeValues(await forDisplayRaw(id, options))
}

/**
 * Resolve an entity for editing: always the client path, always cache-busted —
 * a form prefill must never show a stale read after a write.  Merged values
 * carry `source.citationSource` so the form knows which annotation to update.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @returns {Promise<Object>} DEER-shaped entity with full annotation provenance.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
export async function forEditing(id) {
    const { entity, annotations } = await clientRead(rerum.idOf(id), { fresh: true })
    return applyAssertions(entity, annotations)
}

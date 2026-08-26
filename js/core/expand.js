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
 * Both paths are RERUM-only.  DEER creates entities in RERUM and annotates them
 * through the RERUM API; it does not read entities or Annotations from anywhere
 * else, so an id outside config.ID_BASES is refused rather than served by some
 * degraded path.  That is why neither read has a non-RERUM branch, and why
 * clientRead has no `lazy` option — the parallel entity-GET-plus-query shape
 * existed only for foreign URIs, which a RERUM `@id` query cannot resolve.
 *
 * Both merged paths return the same shape — every non-identity value is a
 * `{value, source, evidence}` object, or an array of them — because both finish
 * in assertions.shapeValues.  Provenance is the only difference:
 * `source.citationSource` and `evidence` are annotation-level, so the server
 * read carries neither.
 *
 * Views must never call forEditing; forms must never call forDisplay.  Called
 * directly, both are safe by construction — neither has a strategy to be wrong
 * about.  The hazard is a form holding an Entity, whose strategy it did not
 * choose, and that is closed in code: Entity#assertionsForEditing upgrades
 * before it answers.  The view half stays a convention — a view handed an
 * editing Entity is merely paying too much, not corrupting anything.
 *
 * CONSEQUENCE FOR THE TEMPLATE PHASE: because `/expanded` carries no annotation
 * `@id`s and (by deployment decision) never will, a display-strategy render
 * cannot emit `deer-source`.  The 0.11 default template stamps it on every
 * rendered value (deer-render.js:170, 179, 197).  A template that genuinely
 * needs provenance in its output must ask for the editing strategy and give up
 * the cacheable read; that is a per-template choice, not something this layer
 * can decide.
 */

import config from './config.js'
import * as rerum from './rerum.js'
import { applyAssertions, isAnnotationType, requireDocument, shapeValues } from './assertions.js'

/**
 * RERUM deployments already reported as sending no merge-count headers.  The
 * defect is per-deployment and permanent for the session, so warning per read
 * would bury the console under one real problem.
 */
const uncountedDeployments = new Set()

/**
 * Entities already reported as forcing the client fallback.  Deduplicated per
 * ENTITY rather than per deployment (the way uncountedDeployments is): the
 * divergence is a property of one entity's annotations, not of the server, so a
 * list of 200 must not print 200 lines — but two different entities diverging
 * are two different things to look at.
 */
const divergentEntities = new Set()

/** Keep only the documents that are actually Annotations. */
const onlyAnnotations = (finds) => (Array.isArray(finds) ? finds : [])
    .filter(doc => doc && isAnnotationType(doc.type ?? doc["@type"]))


/**
 * Refuse an id DEER cannot work with.  DEER creates entities in RERUM and
 * annotates them through the RERUM API; an entity outside RERUM has no
 * `/expanded` merge, no queryable annotations, and nothing DEER could write
 * back to.  Failing here is the honest answer — the alternative is a read that
 * appears to succeed and produces a document no form can ever save.
 *
 * The common cause is not foreign data at all but a RERUM deployment on a host
 * config.ID_BASES does not list, so the message names that first.
 * @param {String} uri the entity URI.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
function requireRerumId(uri) {
    if (rerum.isRerumId(uri)) { return }
    throw new TypeError(`${uri} is not hosted by RERUM, and DEER reads and writes RERUM entities only. If this IS your RERUM deployment, add its id base to config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}).`)
}

/**
 * The properties an Annotation can carry the URI of its target under, mirroring
 * findLeafAnnotationsFor's TARGET_KEYS
 * (rerum_server_nodejs/controllers/utils.js).  KEEP IN STEP WITH THE SERVER: a
 * key the server matches and this list does not is an annotation `/expanded`
 * merges and the client read never sees.  The merge counts agree in that case,
 * so forDisplay's divergence guard cannot notice it — a view shows the value,
 * the form editing the same entity is blind to it, and the next save POSTs a
 * duplicate assertion instead of updating.
 */
const TARGET_KEYS = ["target", "target.@id", "target.id",
    "target.source", "target.source.@id", "target.source.id"]

/** Escape the RegExp metacharacters in a literal so it matches only itself. */
const escapeRegex = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Every way an Annotation can name this entity as its target: each target key
 * against both protocol spellings, and each against a FRAGMENT of the URI
 * (`…#xywh=0,0,100,100`), which is the other W3C way to target part of a
 * resource and which an exact match does not catch.  `target.source` is the
 * W3C SpecificResource.
 *
 * KNOWN DIVERGENCE: the server also gathers annotations targeting the entity's
 * Slug URI, which the client cannot build until it already holds the document.
 * An entity annotated by slug therefore reads complete on the display path and
 * short on the editing path.
 * @param {String} uri the entity URI.
 * @returns {Array<Object>} clauses for a Mongo-style `$or`.
 */
function targetingClauses(uri) {
    const uris = rerum.httpsIdArray(uri)
    const fragments = ["http", "https"]
        .map(scheme => `^${escapeRegex(uri.replace(/^https?/, scheme))}#`)
        .join("|")
    return TARGET_KEYS.flatMap(key => [
        { [key]: uris },
        { [key]: { "$regex": fragments } }
    ])
}

/**
 * The client read path: an entity document and the Annotation documents
 * targeting it, RAW.  Both editing consumers share this — forEditing() below,
 * which merges immediately, and Entity, which holds the annotations so it can
 * key them by version chain and re-merge whenever one changes.  Returning the
 * parts instead of the merge is what lets those two share one read: an Entity
 * handed a merged document could no longer tell its own values from asserted
 * ones, and re-merging over it duplicates every value.
 *
 * ONE round trip — a compound `$or` query matching the entity's own @id
 * alongside every targeting style.  The leaf filter excludes an entity that has
 * since been updated, and a full page can crowd it out, so the entity is
 * recovered with a direct GET when the query did not return it.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh` busts the HTTP cache on the recovery GET.
 * @returns {Promise<{entity: Object, annotations: Array<Object>}>} raw documents:
 * the entity, and the annotations THIS deployment wrote against it.  The
 * generator filter is part of the query, so a merge never has to re-check who
 * asserted what.
 * @throws {TypeError} when the id is not RERUM-hosted, or no generator is configured.
 */
export async function clientRead(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireRerumId(uri)
    const uris = rerum.httpsIdArray(uri)
    // The generator filter belongs on the TARGETING branch only.  RERUM is
    // shared: another application's annotations on this entity are not ours to
    // merge, and filtering them here rather than after the read is what stops
    // them filling the page and crowding out the ones that are.  It must not
    // reach the `@id` branch — the entity itself may well have been created by
    // a different application, and it is still the entity we asked for.
    const finds = await rerum.query({
        "$or": [
            { "@id": uris },
            {
                "$and": [
                    { "$or": targetingClauses(uri) },
                    { "__rerum.generatedBy": rerum.generatedBy() }
                ]
            }
        ],
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
    const entity = requireDocument(list.find(isSelf) ?? await rerum.resolve(uri, { fresh }), `The read of ${uri}`)
    return {
        entity,
        annotations: onlyAnnotations(list.filter(doc => !isSelf(doc)))
    }
}

/**
 * Resolve an entity for display: the server-side annotation merge.  Cacheable
 * (the server sends max-age=86400, must-revalidate) and carries no annotation
 * provenance.
 * There is no `generator` option.  DEER filters every read by the one agent in
 * config.GENERATOR, so the server request and the client fallback below always
 * merge the same annotations — an override would let those two branches
 * disagree, and which branch runs is not something the caller controls.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
 * @returns {Promise<Object>} DEER-shaped entity: asserted properties become
 * `{value, source, evidence}` objects (arrays thereof when multivalued).
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
export async function forDisplay(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireRerumId(uri)
    // ONE cacheable GET.  The server's PROTECTED_EXPANSION_KEYS now covers
    // every key in IDENTITY_KEYS, so an Annotation can no longer append to the
    // entity's `type`/`@type` and the merge is authoritative for identity as it
    // stands.  Before that (rerum_server_nodejs, Aug 2026) this path had to
    // fetch the entity document alongside the merge and restore those keys from
    // it, which cost a second request on every display read.
    const { document, gathered, merged } = await rerum.expanded(uri, { fresh })
    if (gathered === null || merged === null) {
        // Unknown is not agreement.  Without the counts nothing can tell a
        // complete merge from one that silently dropped assertions, and the
        // display path has no other safety net, so the read has to be redone
        // the client way.  Loud and ungated: every display read against this
        // deployment now costs the `/expanded` GET *and* the client read, and
        // the cacheable path — the whole reason this branch exists — is off.
        const deployment = config.ID_BASES.find(base => rerum.canonicalId(uri).startsWith(base)) ?? uri
        if (!uncountedDeployments.has(deployment)) {
            uncountedDeployments.add(deployment)
            console.warn(`${deployment} does not send the Annotations-Gathered/Annotations-Merged headers on /expanded, so the completeness of the server merge cannot be verified. Every display read falls back to the client path: correct, but the cacheable read path is effectively disabled and each read now costs two requests. Upgrade the RERUM deployment.`)
        }
        // The compound query resolves the entity and its annotations in ONE
        // round trip, on top of the `/expanded` GET already wasted getting here.
        return clientMerge(uri, { fresh })
    }
    if (gathered !== merged) {
        // The server merges a body only when it is an object with exactly one
        // key; multi-key bodies, array bodies, and bodies asserting a protected
        // key are gathered and then dropped.  Whatever it declined is absent
        // from this document and unrecoverable from it, so re-read the client
        // way and let the two paths agree.  DEER writes one key per annotation
        // and never asserts a protected key, so its own data never trips this.
        // Ungated, like the missing-headers branch above and for the same
        // reason: the consequence is identical — two requests per display read
        // and no cacheable path, which is the whole reason forDisplay exists.
        // Gating it behind DEBUG let a deployment lose that path on a subset of
        // its entities with nothing printed at all.
        if (!divergentEntities.has(uri)) {
            divergentEntities.add(uri)
            console.warn(`${uri}: server merged ${merged} of ${gathered} annotations, so the cacheable read cannot be trusted for this entity and every display read of it now costs two requests. Falling back to the client read path so no asserted property is silently dropped.`)
        }
        return clientMerge(uri, { fresh })
    }
    return shapeValues(requireDocument(document, `The expanded read of ${uri}`))
}

/**
 * Resolve an entity for editing: always the client path, always cache-busted —
 * a form prefill must never show a stale read after a write.  Merged values
 * carry `source.citationSource` so the form knows which annotation to update.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @returns {Promise<Object>} DEER-shaped entity with full annotation provenance.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
export async function forEditing(id) {
    return clientMerge(rerum.idOf(id), { fresh: true })
}

/** clientRead plus the merge — what every consumer that wants a document uses. */
async function clientMerge(uri, options) {
    const { entity, annotations } = await clientRead(uri, options)
    return applyAssertions(entity, annotations)
}

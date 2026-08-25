import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../../js/core/config.js'
import { forDisplay, forEditing } from '../../js/core/expand.js'
import { fixture, stubFetch, withConfig, ADA } from './helpers.js'

const entityDoc = await fixture('ada-entity')
const annotationDocs = await fixture('ada-annotations')
const expandedDoc = await fixture('ada-expanded')

const FOREIGN = "https://example.org/thing/1"

/** Serves the server path (/expanded) AND the client path (GET + query). */
function bothPathsRouter() {
    return stubFetch((url, options) => {
        if (url.startsWith(`${ADA}/expanded`)) { return expandedDoc }
        if (url === ADA && !options.method) { return entityDoc }
        if (url.startsWith(config.URLS.QUERY) && options.method === "POST") { return annotationDocs }
    })
}

/** Unwrap a DEER-shaped property to its comparable value(s). */
function extractValues(prop) {
    const list = Array.isArray(prop) ? prop : [prop]
    return list.map(v => (v && typeof v === "object" && "value" in v) ? v.value : v)
}

/** Collect every source.citationSource in a shaped entity. */
function collectCitations(shaped) {
    const citations = []
    for (const val of Object.values(shaped)) {
        for (const v of (Array.isArray(val) ? val : [val])) {
            if (v && typeof v === "object" && "source" in v) { citations.push(v.source.citationSource) }
        }
    }
    return citations
}

test('forDisplay takes the server path for RERUM ids', async () => {
    const stub = bothPathsRouter()
    await withConfig({ fetch: stub }, () => forDisplay(ADA))
    assert.equal(stub.calls.length, 1)
    assert.ok(stub.calls[0].url.startsWith(`${ADA}/expanded?generator=`))
})

test('forDisplay falls back to the client path for foreign URIs', async () => {
    const stub = stubFetch((url, options) => {
        if (url === FOREIGN && !options.method) {
            return { "@id": FOREIGN, name: "Foreign Thing", creator: "tag" }
        }
        if (url.startsWith(config.URLS.QUERY)) {
            return [{
                "@id": "https://example.org/anno/f1", type: "Annotation", target: FOREIGN,
                creator: "tag", body: { note: { value: "described elsewhere" } }
            }]
        }
    })
    const shaped = await withConfig({ fetch: stub }, () => forDisplay(FOREIGN))
    assert.equal(stub.calls.length, 2)
    assert.ok(stub.calls.every(c => !c.url.includes("/expanded")))
    assert.equal(shaped.note.value, "described elsewhere")
})

test('forDisplay rejects when no generator is configured', async () => {
    const stub = bothPathsRouter()
    await withConfig({ fetch: stub, GENERATOR: undefined }, async () => {
        await assert.rejects(() => forDisplay(ADA), /requires a generator/)
    })
    assert.equal(stub.calls.length, 0)
})

test('forEditing always takes the client path and busts the cache (prefill)', async () => {
    const stub = bothPathsRouter()
    await withConfig({ fetch: stub }, () => forEditing(ADA))
    assert.equal(stub.calls.length, 2)
    const entityGet = stub.calls.find(c => c.url === ADA)
    assert.equal(entityGet.options.cache, "reload")
    assert.ok(stub.calls.every(c => !c.url.includes("/expanded")))
})

test('cross-path agreement: forDisplay and forEditing extract to the same values', async () => {
    const stub = bothPathsRouter()
    const [display, editing] = await withConfig({ fetch: stub }, () =>
        Promise.all([forDisplay(ADA), forEditing(ADA)]))
    const asserted = ["name", "creator", "description", "email", "targetCollection",
        "address", "telephone", "note", "jobTitle", "depiction"]
    for (const key of asserted) {
        assert.deepEqual(extractValues(display[key]), extractValues(editing[key]), `divergence on '${key}'`)
    }
    // identity carries through both paths untouched
    assert.equal(display["@id"], ADA)
    assert.equal(editing["@id"], ADA)
    assert.equal(display["@type"], "Person")
    assert.equal(editing["@type"], "Person")
})

test('tested divergence: the server path has zero annotation @ids, the editing path has full provenance', async () => {
    const stub = bothPathsRouter()
    const [display, editing] = await withConfig({ fetch: stub }, () =>
        Promise.all([forDisplay(ADA), forEditing(ADA)]))

    // Server path: the server drops every annotation @id — no provenance anywhere.
    assert.ok(collectCitations(display).every(c => c === undefined))
    const annoIds = annotationDocs.map(a => a["@id"])
    for (const id of annoIds) {
        assert.ok(!JSON.stringify(display).includes(id), `server path leaked ${id}`)
    }

    // Editing path: every merged value cites the annotation that asserted it.
    const citations = collectCitations(editing).filter(c => c !== undefined)
    assert.equal(citations.length, 10)
    for (const citation of citations) {
        assert.ok(annoIds.includes(citation), `unknown citation ${citation}`)
    }
})

test('tested divergence: client matchOn admits creator-only matches the server generator filter would drop', async () => {
    // An annotation with no __rerum (never RERUM-saved, so invisible to
    // ?generator=) but a matching creator merges on the client path.
    const local = {
        "@id": "https://example.org/anno/unsaved", type: "Annotation", target: ADA,
        creator: "ANTLERS_2_0_TEST_AGENT", body: { nickname: { value: "Countess" } }
    }
    const stub = stubFetch((url, options) => {
        if (url === ADA && !options.method) { return entityDoc }
        if (url.startsWith(config.URLS.QUERY)) { return [...annotationDocs, local] }
    })
    const editing = await withConfig({ fetch: stub }, () => forEditing(ADA))
    assert.equal(editing.nickname.value, "Countess")
    assert.equal(editing.nickname.source.citationSource, "https://example.org/anno/unsaved")
})

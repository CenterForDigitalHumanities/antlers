import test from 'node:test'
import assert from 'node:assert/strict'
import { checkMatch, buildValueObject, applyAssertions } from '../../js/core/assertions.js'
import { fixture } from './helpers.js'

const entity = await fixture('ada-entity')
const annotations = await fixture('ada-annotations')

test('checkMatch affirms a shared __rerum.generatedBy', () => {
    assert.equal(checkMatch(entity, annotations[0]), true)
})

test('checkMatch falls through to creator when generatedBy is missing', () => {
    // A local or foreign-hosted annotation has no __rerum but can share a creator.
    const anno = { creator: "ANTLERS_2_0_TEST_AGENT", body: { x: { value: 1 } } }
    assert.equal(checkMatch(entity, anno), true)
})

test('checkMatch rejects a foreign annotation', () => {
    const foreign = {
        creator: "SOMEONE_ELSE",
        __rerum: { generatedBy: "https://example.org/otherAgent" }
    }
    assert.equal(checkMatch(entity, foreign), false)
})

test('checkMatch is not a match without any positive matches', () => {
    assert.equal(checkMatch({}, {}), false)
})

test('buildValueObject survives the heterogeneous arrays /expanded produces', () => {
    const anno = { "@id": "https://example.org/anno/1", label: "heterogeneous" }
    const shaped = ["Squiggly Floater In My Eye", { value: "Ritter Hall" }]
        .map(v => buildValueObject(v, anno))
    assert.equal(shaped[0].value, "Squiggly Floater In My Eye")
    assert.equal(shaped[1].value, "Ritter Hall")
    for (const vo of shaped) {
        assert.equal(vo.source.citationSource, "https://example.org/anno/1")
        assert.equal(vo.evidence, "")
    }
})

test('buildValueObject keeps Set containers whole', () => {
    const container = { "@type": "Set", items: ["a@example.org", "b@example.org"] }
    const vo = buildValueObject(container, { "@id": "https://example.org/anno/2" })
    assert.deepEqual(vo.value, container)
})

test('applyAssertions merges the fixture annotations with provenance', () => {
    const merged = applyAssertions(entity, annotations)
    assert.equal(merged.description.value, "Test entity created by the antlers 2.0 test bench.")
    assert.equal(merged.description.source.citationSource, "https://devstore.rerum.io/v1/id/6a8deb57e339d7e147aaaf5b")
    assert.equal(merged.jobTitle.value, "Mathematician")
    assert.equal(merged.targetCollection.value, "AntlersTestPeople")
    assert.deepEqual(merged.email.value, { "@type": "Set", items: ["ada@example.org", "lovelace@example.org"] })
})

test('applyAssertions preserves the entity\'s own literal alongside the annotation value (server-merge parity)', () => {
    const merged = applyAssertions(entity, annotations)
    assert.ok(Array.isArray(merged.name))
    assert.equal(merged.name[0], "Ada Lovelace")
    assert.equal(merged.name[1].value, "Ada Lovelace")
    assert.ok(merged.name[1].source.citationSource.includes("devstore.rerum.io"))
})

test('applyAssertions does not mutate the entity it was given', () => {
    const before = JSON.stringify(entity)
    applyAssertions(entity, annotations)
    assert.equal(JSON.stringify(entity), before)
})

test('applyAssertions excludes annotations that fail checkMatch', () => {
    const foreign = {
        "@id": "https://example.org/anno/evil",
        type: "Annotation",
        creator: "SOMEONE_ELSE",
        __rerum: { generatedBy: "https://example.org/otherAgent" },
        body: { hacked: { value: "nope" } }
    }
    const merged = applyAssertions(entity, [foreign])
    assert.equal(merged.hacked, undefined)
})

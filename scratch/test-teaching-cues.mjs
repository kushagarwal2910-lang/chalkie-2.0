import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTargetPositions } from '../lib/target-matcher.ts';
import { playDeviceNarrationChunks } from '../lib/playback-sync.ts';
import { formatNarrationForSpeech } from '../lib/speech-formatter.ts';

const objects = [
  { id: 'browser', label: 'Browser', role: 'component' },
  { id: 'api', label: 'API', role: 'component' },
  { id: 'database', label: 'PostgreSQL', role: 'component' },
  { id: 'worker', label: 'Background worker', role: 'component' },
];
const connections = [
  { id: 'request', from: 'browser', to: 'api', label: 'sends a request' },
  { id: 'query', from: 'api', to: 'database', label: 'reads saved data' },
];
const positions = (narration, ids = ['request'], edges = connections) => {
  const text = formatNarrationForSpeech(narration);
  return { text, cues: computeTargetPositions(text, ids, objects, edges) };
};

test('a narrated handoff points to its source, the selected connection, then the recipient', () => {
  const { text, cues } = positions('The Browser sends a request to the API.');
  assert.deepEqual(cues.map(c => c.targetId), ['browser', 'request', 'api']);
  assert.equal(cues[1].charIndex, text.indexOf('sends'));
  assert.equal(cues[2].charIndex, text.indexOf('A P I'));
});

test('a paraphrased action still traces the declared handoff without another model request', () => {
  const { text, cues } = positions('The API queries PostgreSQL to find the saved record.', ['query']);
  assert.deepEqual(cues.map(c => c.targetId), ['api', 'query', 'database']);
  assert.equal(cues[1].charIndex, text.indexOf('queries'));
});

test('exact Compose service names trace api to startup dependency to two-letter db', () => {
  const text = formatNarrationForSpeech('api depends on db during startup.');
  const nodes = [{ id: 'napi', label: 'api', role: 'component' }, { id: 'ndb', label: 'db', role: 'component' }];
  const edges = [{ id: 'startup', from: 'napi', to: 'ndb', label: 'Startup dependency' }];
  const cues = computeTargetPositions(text, ['startup'], nodes, edges);
  assert.deepEqual(cues.map(c => c.targetId), ['napi', 'startup', 'ndb']);
  assert.equal(cues[0].charIndex, text.indexOf('A P I'));
  assert.equal(cues[1].charIndex, text.indexOf('depends'));
  assert.equal(cues[2].charIndex, text.indexOf('db'));
});

test('short labels match only exact words on explicit targets and reject common-word ambiguity', () => {
  const nodes = [
    { id: 'napi', label: 'api', role: 'component' },
    { id: 'ndb', label: 'db', role: 'component' },
    { id: 'nus', label: 'us', role: 'component' },
  ];
  const match = (text, targets, graph) => computeTargetPositions(formatNarrationForSpeech(text), targets, nodes, graph).map(c => c.targetId);
  assert.deepEqual(match('api loads the dbdriver for us.', ['napi', 'ndb', 'nus'], []), ['napi']);
  assert.deepEqual(match('api uses db.', ['napi']), ['napi']);
  assert.deepEqual(match('api uses db.', ['napi', 'ndb'], []), ['napi', 'ndb']);
});

test('relationship cues follow repeated handoffs without highlighting an unrelated earlier component', () => {
  const { cues } = positions('The Browser sends a request to the API. The API reads saved data from PostgreSQL. A background worker is a separate concern.', ['request', 'query']);
  assert.deepEqual(cues.map(c => c.targetId), ['browser', 'request', 'api', 'query', 'database']);
});

test('mentioning two components does not invent a connection or reverse an existing one', () => {
  const samples = [
    ['The Browser sends a request to the API.', ['browser', 'api']],
    ['The API sends a response to the Browser.', ['request']],
    ['The Browser waits. The next component sends something to the API.', ['request']],
    ['The Browser does not send a request to the API.', ['request']],
    ['The Browser and the API are two components.', ['request']],
  ];
  for (const [text, ids] of samples) {
    assert.equal(positions(text, ids).cues.some(c => c.targetId === 'request'), false, text);
  }
});

test('parallel edges require a specific spoken relationship rather than an arbitrary animation', () => {
  const edges = [...connections, { id: 'uploads', from: 'browser', to: 'api', label: 'uploads a document' }];
  assert.equal(positions('The Browser calls the API.', ['request', 'uploads'], edges).cues.some(c => ['request', 'uploads'].includes(c.targetId)), false);
  assert.deepEqual(positions('The Browser uploads a document to the API.', ['request', 'uploads'], edges).cues.map(c => c.targetId), ['browser', 'uploads', 'api']);
});

test('edge-only explanations without named endpoints retain their connection focus', () => {
  const { cues } = positions('This arrow represents the handoff.');
  assert.deepEqual(cues.map(c => c.targetId), ['request']);
  assert.equal(cues[0].charIndex, 0);
});

test('legacy node and internal-part matching remains available without a connection graph', () => {
  const cues = computeTargetPositions('The gradient changes inside the coil.', ['coil#0'], [
    { id: 'coil', label: 'Coil', role: 'component', parts: [{ text: 'Gradient' }] },
  ]);
  assert.equal(cues[0].targetId, 'coil#0');
});

test('word boundaries carry a real connection cue through sentence playback and cancel cleanly', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { text, cues } = positions('The Browser sends a request to the API. Then the API queries PostgreSQL.', ['request', 'query']);
  const controller = new AbortController();
  const utterances = [], focused = [];
  playDeviceNarrationChunks({ speak: utterance => utterances.push(utterance), cancel() {} }, text,
    { voice: null, lang: 'en-US', rate: .92, pitch: 1 }, {
      signal: controller.signal, cues,
      onStart() {}, onTarget: id => focused.push(id), onEnd() {}, onError() {},
    }, value => ({ text: value }));
  const first = utterances[0];
  first.onstart();
  first.onboundary({ name: 'word', charIndex: first.text.indexOf('Browser') });
  first.onboundary({ name: 'word', charIndex: first.text.indexOf('sends') });
  first.onboundary({ name: 'word', charIndex: first.text.indexOf('A P I') });
  assert.deepEqual(focused, ['browser', 'request', 'api']);
  first.onend();
  controller.abort();
  t.mock.timers.tick(10_000);
  assert.equal(utterances.length, 1);
});

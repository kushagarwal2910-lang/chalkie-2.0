import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNarrationForSpeech as speak, splitSpeechForPlayback } from '../lib/speech-formatter.ts';
import { playDeviceNarrationChunks } from '../lib/playback-sync.ts';
import { computeTargetPositions } from '../lib/target-matcher.ts';

test('abbreviations never corrupt everyday words or engineering vocabulary', () => {
  const text = 'Security checks the minimum requirement, secondary replicas, departments, and etcd.';
  assert.equal(speak(text), text);
  assert.equal(speak('Wait 2 min and 5 sec, approx. 10% of the time.'), 'Wait 2 minutes and 5 seconds, approximately 10 percent of the time.');
});

test('engineering names and initialisms get explicit readings', () => {
  assert.equal(speak('Next.js API receives HTTP requests and JSON from PostgreSQL.'), 'Next J S A P I receives H T T P requests and jay son from Postgres S Q L.');
  assert.equal(speak('2 APIs use AWS S3 and n8n.'), "2 A P I's use A W S S 3 and N eight N.");
  assert.equal(speak('REST APIs support CRUD, not a RAG pipeline.'), "rest A P I's support crud, not a rag pipeline.");
  assert.equal(speak('IMPORTANT: use Redis and Docker.'), 'IMPORTANT, use Redis and Docker.');
});

test('markdown, filenames, paths and identifiers remain understandable', () => {
  assert.equal(speak('**GitHub** reads `package.json` and [docs](https://example.com).'), 'Git Hub reads package dot jay son and docs.');
  assert.equal(speak('getHTTPResponse and user_id use /api/users.'), 'get H T T P Response and user id use slash A P I slash users.');
  assert.equal(speak('C++ and C# use CI/CD.'), 'C plus plus and C sharp use C I slash C D.');
  assert.equal(speak('input/output'), 'input slash output.');
});

test('measurements, decimals, empty text and sentence punctuation stay intact', () => {
  assert.equal(speak(''), '');
  assert.equal(speak('3.5 GHz, 20 ms, 2 GB.'), '3.5 gigahertz, 20 milliseconds, 2 gigabytes.');
  assert.equal(speak('Read this.\nThen that.'), 'Read this. Then that.');
});

test('chunks preserve every word and its offset, including decimals and initialisms', () => {
  const text = speak('The API waits 2.5 seconds. ' + 'A component passes data to the next component, '.repeat(20) + 'then stops.');
  const chunks = splitSpeechForPlayback(text);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.map(c => c.text).join(' '), text);
  assert.ok(chunks.every(c => c.text === text.slice(c.start, c.start + c.text.length)));
  assert.ok(chunks.every(c => c.text.length <= 240));
  assert.equal(chunks[0].text, 'The A P I waits 2.5 seconds.');
});

test('diagram cues still match acronyms after spoken text expansion', () => {
  const text = speak('First the API receives data. Later PostgreSQL stores it.');
  const cues = computeTargetPositions(text, ['api', 'database'], [
    { id: 'api', label: 'API', role: 'component' },
    { id: 'database', label: 'PostgreSQL', role: 'component' },
  ]);
  assert.equal(cues.find(c => c.targetId === 'api').charIndex, text.indexOf('A P I'));
  assert.equal(cues.find(c => c.targetId === 'database').charIndex, text.indexOf('Postgres'));
});

function playback() {
  const controller = new AbortController();
  const utterances = [], events = [];
  const text = 'First sentence. Second sentence.';
  playDeviceNarrationChunks({ speak: u => utterances.push(u), cancel: () => events.push('cancel') }, text,
    { voice: null, lang: 'en-US', rate: .92, pitch: 1 }, {
      signal: controller.signal, cues: [{ charIndex: 0, targetId: 'first' }, { charIndex: 16, targetId: 'second' }],
      onStart: () => events.push('start'), onTarget: id => events.push(id),
      onEnd: () => events.push('end'), onError: () => events.push('error'),
    }, value => ({ text: value }));
  return { controller, utterances, events };
}

test('sentences play sequentially with the same voice, one reveal, and correct cursor offsets', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = playback();
  assert.equal(f.utterances.length, 1);
  f.utterances[0].onstart();
  f.utterances[0].onboundary({ name: 'word', charIndex: 0 });
  f.utterances[0].onend();
  assert.equal(f.events.includes('end'), false);
  t.mock.timers.tick(160);
  const second = f.utterances[1];
  assert.equal(second.text, 'Second sentence.');
  assert.equal(second.lang, 'en-US');
  assert.equal(second.rate, .92);
  second.onstart();
  second.onboundary({ name: 'word', charIndex: 0 });
  second.onend();
  assert.deepEqual(f.events, ['start', 'first', 'second', 'end']);
});

test('interrupting between sentences prevents queued speech and stale completion', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = playback();
  f.utterances[0].onstart();
  f.utterances[0].onend();
  f.controller.abort();
  t.mock.timers.tick(10000);
  assert.equal(f.utterances.length, 1);
  assert.deepEqual(f.events, ['start']);
});

test('a speech error stops instead of skipping the remainder of the explanation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = playback();
  f.utterances[0].onerror();
  t.mock.timers.tick(10000);
  assert.equal(f.utterances.length, 1);
  assert.deepEqual(f.events, ['error']);
});

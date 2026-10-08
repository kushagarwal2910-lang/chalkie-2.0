import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNarrationForSpeech as speak, shortenNarrationReferences as shorten, splitSpeechForPlayback } from '../lib/speech-formatter.ts';
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

test('narration keeps concise basenames rather than repository paths or line citations', () => {
  const cases = [
    ['The setup is in src/backend/auth/service.ts:42-58.', 'The setup is in service.ts.'],
    ['Check `./packages/api/src/index.ts#L12-L20` next.', 'Check index.ts next.'],
    ['Read ../docs/architecture/README.md (lines 20–28).', 'Read README.md.'],
    ['See /home/developer/project/config/Dockerfile.', 'See Dockerfile.'],
    ['Start with ./Dockerfile and ../package.json.', 'Start with Dockerfile and package.json.'],
    ['The code is in \\src\\services\\handler.py:18:2.', 'The code is in handler.py.'],
    ['Read C:\\Users\\Jane Doe\\project\\src\\service.ts:12.', 'Read service.ts.'],
    ['Read C:\\service.ts and /service.ts.', 'Read service.ts and service.ts.'],
    ['Check `my project/src/service.ts` next.', 'Check service.ts next.'],
    ['Check "/Users/Jane Doe/project/src/service.ts" next.', 'Check service.ts next.'],
    ['Check `docs/design guides/Service Design.md` next.', 'Check Service Design.md next.'],
    ['Inspect config.yaml#L8 and service.ts:4:2-8:9.', 'Inspect config.yaml and service.ts.'],
    ['Inspect `service.ts`:42 and `config.yaml` (lines 8-12).', 'Inspect service.ts and config.yaml.'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shorten(input), expected, input);
    assert.equal(shorten(shorten(input)), expected, 'shortening is idempotent: ' + input);
  }
  assert.equal(speak(cases[0][0]), 'The setup is in service dot T S.');
});

test('GitHub blob links lose URL metadata while descriptive Markdown labels remain natural', () => {
  const input = 'See https://github.com/team/project/blob/main/src/service.ts?plain=1#L21-L34, then [the setup guide](https://github.com/team/project/blob/main/docs/README.md#L8).';
  assert.equal(shorten(input), 'See service.ts, then the setup guide.');
  assert.equal(shorten('[src/service.ts#L4](https://github.com/team/project/blob/main/src/service.ts#L4)'), 'service.ts');
  assert.equal(shorten('See github.com/team/project/blob/main/src/service.ts#L7.'), 'See service.ts.');
  assert.equal(shorten('See https://github.com/team/project/blob/main/docs/My%20Guide.md#L7.'), 'See My Guide.md.');
  assert.doesNotMatch(speak(input), /github|team|project|plain|L21|L34|slash/i);
});

test('unwieldy filenames become a source reference without inventing a component name', () => {
  const longName = 'automatically-generated-production-onboarding-configuration-snapshot-final.json';
  const hashName = '0123456789abcdef0123456789abcdef.ts';
  assert.equal(shorten('Open src/generated/' + longName + ':128.'), 'Open the source file.');
  assert.equal(shorten('Look in the `' + longName + '` next.'), 'Look in the source file next.');
  assert.equal(shorten('Open ' + hashName + '.'), 'Open the source file.');
  assert.equal(shorten('Open service.ts.'), 'Open service.ts.');
});

test('reference shortening leaves endpoints, fractions, product names and normal prose intact', () => {
  const text = 'Next.js calls /api/login and /api/schema.json. Use 1/2, 1/2.5 or x/y, CI/CD, and input/output for a well-known API. The gradient is ∂L/∂W.';
  assert.equal(shorten(text), text);
  assert.equal(shorten('The product is Node.js. The host is https://example.com/api/schema.json.'), 'The product is Node.js. The host is https://example.com/api/schema.json.');
  assert.equal(shorten('Compute `x/y` and `1/2`.'), 'Compute `x/y` and `1/2`.');
});

test('shortened narration stays stable through speech formatting and diagram cue matching', () => {
  const raw = 'The API reads src/backend/service.ts:22 before it queries PostgreSQL.';
  const prepared = shorten(raw);
  const spoken = speak(prepared);
  assert.equal(speak(raw), spoken);
  assert.equal(speak(spoken), spoken);
  const cues = computeTargetPositions(spoken, ['api', 'db'], [
    { id: 'api', label: 'API', role: 'component' },
    { id: 'db', label: 'PostgreSQL', role: 'component' },
  ]);
  assert.equal(cues.find(c => c.targetId === 'api').charIndex, spoken.indexOf('A P I'));
  assert.equal(cues.find(c => c.targetId === 'db').charIndex, spoken.indexOf('Postgres'));
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

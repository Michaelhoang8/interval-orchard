import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV,
  fromCSV,
  validateRows,
  threshold,
  analyze,
  sweep,
  fixture,
  intervalCSV,
} from '../core.js';
const row = (id, split, truth, prediction = 0, scale = 1, group = 'all') => ({
  id,
  split,
  truth,
  prediction,
  scale,
  group,
});
test('finite-sample rank uses exact integer coverage arithmetic and no interpolated quantile', () => {
  assert.deepEqual(threshold([4, 1, 3, 2], 800), {
    rank: 4,
    n: 4,
    threshold: 4,
    unbounded: false,
    sorted: [1, 2, 3, 4],
  });
  assert.equal(
    threshold(
      Array.from({ length: 19 }, (_, i) => i),
      950,
    ).rank,
    19,
  );
  assert.equal(threshold([1, 2, 3, 4], 900).unbounded, true);
});
test('small calibration sets return explicit unbounded intervals and JSON-safe metadata', () => {
  const r = analyze(fixture('tiny'));
  assert.equal(r.quantile.rank, 6);
  assert.equal(r.quantile.threshold, null);
  assert.equal(r.quantile.unbounded, true);
  assert.equal(r.summary.meanWidth, null);
  assert.ok(
    r.evaluation.every((x) => x.covered && x.unbounded && x.lower === null && x.upper === null),
  );
  assert.ok(!JSON.stringify(r).includes('Infinity'));
});
test('leave-one-out rank enumeration gives nominal finite-sample marginal coverage', () => {
  for (const target of [500, 600, 700, 800, 900, 950]) {
    let covered = 0;
    for (let held = 0; held < 10; held++) {
      const rows = Array.from({ length: 10 }, (_, i) =>
        row(String(i), i === held ? 'evaluation' : 'calibration', i),
      );
      covered += analyze(rows, { target }).evaluation[0].covered;
    }
    assert.equal(covered, Math.min(10, Math.ceil((10 * target) / 1000)));
    assert.ok(covered / 10 >= target / 1000);
  }
});
test('ties and exact interval boundaries are included conservatively', () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => row(`c${i}`, 'calibration', 2)),
    row('e', 'evaluation', -2),
  ];
  const r = analyze(rows);
  assert.equal(r.quantile.threshold, 2);
  assert.equal(r.evaluation[0].covered, true);
  assert.equal(r.evaluation[0].lower, -2);
  assert.equal(r.evaluation[0].upper, 2);
});
test('scaled scores produce interval widths proportional to fixed scale predictions', () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => row(`c${i}`, 'calibration', (i + 1) * 2, 0, 2)),
    row('a', 'evaluation', 15, 0, 3),
    row('b', 'evaluation', 15, 0, 1),
  ];
  const r = analyze(rows, { mode: 'scaled', target: 900 });
  assert.equal(r.quantile.threshold, 9);
  assert.equal(r.evaluation[0].width, 54);
  assert.equal(r.evaluation[1].width, 18);
  assert.equal(r.evaluation[0].covered, true);
  assert.equal(r.evaluation[1].covered, false);
});
test('evaluation outcomes never influence the calibration threshold', () => {
  const rows = fixture(),
    a = analyze(rows, { mode: 'scaled' });
  for (const r of rows)
    if (r.split === 'evaluation') {
      r.truth = 999999;
      r.prediction = -999999;
      r.scale = 100;
    }
  const b = analyze(rows, { mode: 'scaled' });
  assert.deepEqual(a.quantile, b.quantile);
  assert.equal(b.summary.covered, 0);
});
test('group counts partition evaluation rows and summary errors match direct arithmetic', () => {
  const rows = fixture(),
    r = analyze(rows),
    evaluations = rows.filter((r) => r.split === 'evaluation');
  assert.equal(
    r.groups.reduce((sum, g) => sum + g.n, 0),
    r.summary.n,
  );
  assert.equal(
    r.groups.reduce((sum, g) => sum + g.covered, 0),
    r.summary.covered,
  );
  assert.equal(
    r.summary.mae,
    evaluations.reduce((sum, r) => sum + Math.abs(r.truth - r.prediction), 0) / evaluations.length,
  );
  assert.equal(
    r.summary.rmse,
    Math.sqrt(
      evaluations.reduce((sum, r) => sum + (r.truth - r.prediction) ** 2, 0) / evaluations.length,
    ),
  );
});
test('coverage sweep widths and covered sets are monotone for a fixed calibration set', () => {
  const rows = fixture(),
    curve = sweep(rows, 'scaled', 925);
  assert.equal(curve.length, 8);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].coverage >= curve[i - 1].coverage);
    if (curve[i].meanWidth !== null) assert.ok(curve[i].meanWidth >= curve[i - 1].meanWidth);
  }
});
test('CSV parser handles BOM, escaped quotes, CRLF, quoted newlines, and strict syntax', () => {
  assert.deepEqual(parseCSV('\ufeffa,b\r\n"hello, world","a""b"\r\n"multi\nline",3'), [
    ['a', 'b'],
    ['hello, world', 'a"b'],
    ['multi\nline', '3'],
  ]);
  for (const csv of ['a\n"unclosed', 'a\n"closed"junk', 'a\nb"c'])
    assert.throws(() => parseCSV(csv));
});
test('CSV input defaults optional fields and rejects duplicate or malformed records', () => {
  const text = 'id,split,truth,prediction\nc,calibration,1,0\ne,evaluation,2,0\n';
  const r = fromCSV(text);
  assert.equal(r[0].scale, 1);
  assert.equal(r[0].group, 'all');
  for (const bad of [
    text.replace('e,evaluation', 'c,evaluation'),
    text.replace('1,0', 'NaN,0'),
    text.replace('1,0', ',0'),
    text.replace('id,split', 'id,id'),
    text.replace('truth', 'unknown'),
  ])
    assert.throws(() => fromCSV(bad));
});
test('validation enforces disjoint IDs, positive scales, finite values, and valid targets', () => {
  const rows = [row('c', 'calibration', 1), row('e', 'evaluation', 2)];
  for (const change of [
    { scale: 0 },
    { truth: NaN },
    { prediction: Infinity },
    { split: 'train' },
    { group: '\n' },
  ])
    assert.throws(() => validateRows([rows[0], { ...rows[1], ...change }]));
  assert.throws(() => validateRows([rows[0], { ...rows[1], id: ' c ' }]));
  assert.throws(() => analyze(rows, { target: 900.5 }));
  assert.throws(() => analyze(rows, { mode: 'unsupported' }));
});
test('exports preserve infinity markers, neutralize spreadsheet labels, and leave source rows unchanged', () => {
  const rows = fixture('tiny'),
    copy = structuredClone(rows);
  rows.find((r) => r.split === 'evaluation').id = '=unsafe';
  const r = analyze(rows),
    csv = intervalCSV(r),
    parsed = parseCSV(csv);
  assert.equal(parsed[1][0], "'=unsafe");
  assert.equal(parsed[1][5], '-Infinity');
  assert.equal(parsed[1][6], 'Infinity');
  assert.equal(parsed[1][8], 'true');
  rows.find((r) => r.split === 'evaluation').id = copy.find((r) => r.split === 'evaluation').id;
  assert.deepEqual(rows, copy);
  assert.deepEqual(fixture(), fixture());
});

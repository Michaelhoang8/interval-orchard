import { fixture, fromCSV, validateRows, intervalCSV } from './core.js';
const $ = (id) => document.getElementById(id),
  percent = (value) => (value * 100).toFixed(1) + '%',
  format = (value) =>
    value === null ? '∞' : Math.abs(value) >= 100000 ? value.toExponential(3) : value.toFixed(2);
let rows = fixture(),
  result = null,
  curve = [],
  worker = null,
  revision = 0,
  datasetName = 'Mixed noise levels';
function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function svg(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
function status(text) {
  $('status').textContent = text;
}
function invalidate() {
  revision++;
  worker?.terminate();
  worker = null;
  result = null;
  $('run').disabled = false;
  $('results').hidden = true;
}
function plot() {
  const group = $('group').value,
    misses = $('misses').checked,
    matching = result.evaluation.filter(
      (r) => (!group || r.group === group) && (!misses || !r.covered),
    ),
    shown = matching.slice(0, 60),
    values = shown.flatMap((r) =>
      r.unbounded ? [r.truth, r.prediction] : [r.truth, r.prediction, r.lower, r.upper],
    );
  let min = values.length ? Math.min(...values) : 0,
    max = values.length ? Math.max(...values) : 1;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padding = (max - min) * 0.03;
  min -= padding;
  max += padding;
  const left = 155,
    right = 970,
    width = 1000,
    height = Math.max(100, shown.length * 23 + 55),
    px = (value) => left + ((value - min) / (max - min)) * (right - left),
    fragment = document.createDocumentFragment();
  for (let tick = 0; tick <= 4; tick++) {
    const x = left + ((right - left) * tick) / 4;
    fragment.append(
      svg('line', { x1: x, x2: x, y1: 25, y2: height - 20, stroke: '#edf1e8' }),
      svg('text', { x, y: 16, 'text-anchor': 'middle' }, format(min + ((max - min) * tick) / 4)),
    );
  }
  shown.forEach((r, i) => {
    const y = 40 + i * 23;
    fragment.append(
      svg('text', { x: 10, y: y + 3 }, r.id.length > 21 ? r.id.slice(0, 20) + '…' : r.id),
    );
    const interval = svg('line', {
      x1: r.unbounded ? left : px(r.lower),
      x2: r.unbounded ? right : px(r.upper),
      y1: y,
      y2: y,
      stroke: '#acc19b',
      'stroke-width': 3,
      'stroke-dasharray': r.unbounded ? '5 4' : 'none',
    });
    interval.append(
      svg('title', {}, r.unbounded ? 'Unbounded interval' : `${r.lower} to ${r.upper}`),
    );
    fragment.append(
      interval,
      svg('rect', {
        x: px(r.prediction) - 3,
        y: y - 3,
        width: 6,
        height: 6,
        fill: '#fff',
        stroke: '#61794f',
      }),
    );
    const truth = svg('circle', {
      cx: px(r.truth),
      cy: y,
      r: 3.7,
      fill: r.covered ? '#566d45' : '#bf7950',
    });
    truth.append(
      svg(
        'title',
        {},
        `${r.id} / ${r.group}: truth ${r.truth}; prediction ${r.prediction}; ${r.covered ? 'covered' : 'missed'}`,
      ),
    );
    fragment.append(truth);
    if (r.unbounded) fragment.append(svg('text', { x: right + 5, y: y + 3 }, '∞'));
  });
  $('intervals').setAttribute('viewBox', `0 0 ${width} ${height}`);
  $('intervals').setAttribute('height', height);
  $('intervals').replaceChildren(fragment);
  $('plot-count').textContent =
    `Showing the first ${shown.length} of ${matching.length} matching evaluation rows. Exports contain all ${result.evaluation.length} evaluation rows.`;
}
function coverageCurve() {
  const fragment = document.createDocumentFragment(),
    x = (v) => 45 + ((v - 0.5) / 0.5) * 375,
    y = (v) => 210 - v * 180;
  for (const value of [0, 0.25, 0.5, 0.75, 1])
    fragment.append(
      svg('line', { x1: 45, x2: 420, y1: y(value), y2: y(value), stroke: '#dfe7d5' }),
      svg('text', { x: 8, y: y(value) + 3 }, `${Math.round(value * 100)}%`),
    );
  for (const value of [0.5, 0.75, 1])
    fragment.append(
      svg('text', { x: x(value), y: 230, 'text-anchor': 'middle' }, `${Math.round(value * 100)}%`),
    );
  fragment.append(
    svg('line', {
      x1: x(0.5),
      y1: y(0.5),
      x2: x(1),
      y2: y(1),
      stroke: '#b5bda8',
      'stroke-dasharray': '5 4',
    }),
    svg('polyline', {
      points: curve.map((r) => `${x(r.target / 1000)},${y(r.coverage)}`).join(' '),
      fill: 'none',
      stroke: '#758b5f',
      'stroke-width': 2,
    }),
  );
  for (const r of curve) {
    const dot = svg('circle', {
      cx: x(r.target / 1000),
      cy: y(r.coverage),
      r: 3,
      fill: r.unbounded ? '#bf8b4f' : '#758b5f',
    });
    dot.append(
      svg(
        'title',
        {},
        `Target ${r.target / 10}%; observed ${percent(r.coverage)}; width ${format(r.meanWidth)}`,
      ),
    );
    fragment.append(dot);
  }
  $('curve').replaceChildren(fragment);
}
function render() {
  const q = result.quantile;
  $('nominal').textContent = percent(result.target / 1000);
  $('observed').textContent = percent(result.summary.coverage);
  $('covered').textContent = `${result.summary.covered} / ${result.summary.n} outcomes covered`;
  $('width').textContent = format(result.summary.meanWidth);
  $('quantile').textContent =
    `${q.n} calibration rows → rank ceil((${q.n} + 1) × ${result.target / 1000}) = ${q.rank} → threshold ${format(q.threshold)}`;
  $('unbounded').hidden = !q.unbounded;
  $('unbounded').textContent =
    `The requested rank exceeds the calibration set. Intervals are unbounded, so 100% observed coverage here is not useful precision. At least ${Math.ceil(result.target / (1000 - result.target))} calibration rows are needed for a finite threshold at this target.`;
  $('group').replaceChildren(el('option', 'All groups'));
  $('group').firstElementChild.value = '';
  for (const item of result.groups) {
    const option = el('option', item.group);
    option.value = item.group;
    $('group').append(option);
  }
  $('misses').checked = false;
  $('groups').replaceChildren(
    ...result.groups.map((group) => {
      const row = el('tr');
      for (const value of [
        group.group,
        `${group.covered} / ${group.n}`,
        percent(group.coverage),
        format(group.meanWidth),
      ])
        row.append(el('td', value));
      return row;
    }),
  );
  $('sweep').replaceChildren(
    ...curve.map((item) => {
      const row = el('tr');
      for (const value of [
        percent(item.target / 1000),
        format(item.threshold),
        percent(item.coverage),
        format(item.meanWidth),
      ])
        row.append(el('td', value));
      return row;
    }),
  );
  $('formula').textContent =
    `Scores are ${result.mode === 'scaled' ? '|truth − prediction| / scale' : '|truth − prediction|'}. Select the ceil((n+1) × target) order statistic without interpolation. An out-of-range rank gives an unbounded interval. Finite intervals are prediction ± threshold${result.mode === 'scaled' ? ' × scale' : ''}; ties are included.`;
  $('results').hidden = false;
  plot();
  coverageCurve();
}
function run(candidate = rows, name = datasetName) {
  const coverage = Number($('target').value),
    target = Math.round(coverage * 10);
  if (
    !$('target').value.trim() ||
    !Number.isFinite(coverage) ||
    Math.abs(coverage * 10 - target) > 1e-7
  ) {
    status('Enter target coverage in increments of 0.1%.');
    return;
  }
  worker?.terminate();
  const ticket = ++revision,
    current = new Worker('./worker.js', { type: 'module' });
  worker = current;
  $('run').disabled = true;
  status('Calibrating scores and auditing held-out outcomes…');
  current.onmessage = ({ data }) => {
    if (ticket !== revision) return;
    current.terminate();
    worker = null;
    $('run').disabled = false;
    if (data.error) {
      status(data.error);
      return;
    }
    rows = candidate;
    datasetName = name;
    result = data.result;
    curve = data.curve;
    render();
    status(
      `${datasetName} · ${result.calibrationCount} calibration / ${result.summary.n} evaluation rows. Thresholds use calibration outcomes only.`,
    );
  };
  current.onerror = () => {
    if (ticket !== revision) return;
    current.terminate();
    worker = null;
    $('run').disabled = false;
    status('The audit worker failed. Try again.');
  };
  current.postMessage({ rows: candidate, settings: { mode: $('mode').value, target } });
}
$('run').addEventListener('click', () => run());
for (const id of ['mode', 'target'])
  $(id).addEventListener('input', () => {
    invalidate();
    status('Settings changed. Calibrate again to update the audit.');
  });
$('example').addEventListener('change', () => {
  invalidate();
  rows = fixture($('example').value);
  datasetName = $('example').selectedOptions[0].textContent;
  run();
});
$('group').addEventListener('change', plot);
$('misses').addEventListener('change', plot);
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('csv').addEventListener('click', () =>
  download('prediction-intervals.csv', intervalCSV(result), 'text/csv;charset=utf-8'),
);
$('report').addEventListener('click', () =>
  download('interval-audit.json', JSON.stringify({ dataset: datasetName, result, curve }, null, 2)),
);
$('dataset').addEventListener('click', () =>
  download('interval-dataset.json', JSON.stringify({ rows }, null, 2)),
);
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  worker?.terminate();
  worker = null;
  $('run').disabled = false;
  const ticket = ++revision;
  try {
    if (file.size > 2000000) throw Error('Dataset files are limited to 2 MB.');
    const text = await file.text();
    let candidate;
    if (file.name.toLowerCase().endsWith('.json')) {
      const value = JSON.parse(text);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !Object.hasOwn(value, 'rows')
      )
        throw Error('JSON needs a rows array only.');
      candidate = validateRows(value.rows);
    } else candidate = fromCSV(text);
    if (ticket === revision) run(candidate, file.name);
  } catch (e) {
    if (ticket === revision) status(`Dataset rejected: ${e.message}`);
  } finally {
    $('file').value = '';
  }
});
run();

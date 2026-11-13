export function parseCSV(text) {
  if (typeof text !== 'string' || text.length > 2000000)
    throw Error('CSV is limited to 2,000,000 characters.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  function cell() {
    row.push(field);
    field = '';
    closed = false;
    if (row.length > 16) throw Error('Too many CSV columns.');
  }
  function record() {
    cell();
    if (row.some((v) => v.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length > 10001) throw Error('CSV is limited to 10,000 data rows.');
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ',') cell();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record();
    } else if (c === '"') {
      if (field || closed) throw Error('Unexpected quote in CSV field.');
      quoted = true;
    } else {
      if (closed) throw Error('Unexpected text after a quoted CSV field.');
      field += c;
    }
    if (field.length > 4096) throw Error('CSV fields are limited to 4,096 characters.');
  }
  if (quoted) throw Error('Unclosed CSV quote.');
  if (field || row.length || closed) record();
  return rows;
}
export function fromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw Error('CSV needs a header and data.');
  const header = rows.shift().map((s) => s.trim()),
    allowed = ['id', 'split', 'truth', 'prediction', 'scale', 'group'];
  if (
    new Set(header).size !== header.length ||
    header.some((h) => !allowed.includes(h)) ||
    !['id', 'split', 'truth', 'prediction'].every((h) => header.includes(h))
  )
    throw Error('CSV requires id, split, truth, prediction; optional scale and group.');
  return validateRows(
    rows.map((values, index) => {
      if (values.length !== header.length)
        throw Error(`CSV row ${index + 2} has the wrong number of columns.`);
      const row = Object.fromEntries(header.map((h, i) => [h, values[i].trim()]));
      for (const key of ['truth', 'prediction', 'scale']) {
        if (key === 'scale' && !Object.hasOwn(row, key)) {
          row.scale = 1;
          continue;
        }
        if (row[key] === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(row[key]))
          throw Error(`CSV row ${index + 2}: invalid ${key}.`);
        row[key] = Number(row[key]);
      }
      row.group ??= 'all';
      return row;
    }),
  );
}
export function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 10000)
    throw Error('Provide 2–10,000 rows, including calibration and evaluation data.');
  const ids = new Set(),
    groups = new Set();
  let calibration = 0,
    evaluation = 0;
  const clean = rows.map((row) => {
    const fields = ['id', 'split', 'truth', 'prediction', 'scale', 'group'];
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).length !== 6 ||
      fields.some((k) => !Object.hasOwn(row, k))
    )
      throw Error('Rows need id, split, truth, prediction, scale, and group only.');
    for (const [key, max] of [
      ['id', 64],
      ['group', 40],
    ])
      if (
        typeof row[key] !== 'string' ||
        !row[key].trim() ||
        row[key].length > max ||
        /[\x00-\x1f]/.test(row[key])
      )
        throw Error(`${key} must be a nonempty printable label of at most ${max} characters.`);
    const id = row.id.trim(),
      group = row.group.trim();
    if (ids.has(id)) throw Error(`Duplicate ID ${id}; splits must be disjoint.`);
    ids.add(id);
    groups.add(group);
    if (!['calibration', 'evaluation'].includes(row.split))
      throw Error('Split must be calibration or evaluation.');
    if (row.split === 'calibration') calibration++;
    else evaluation++;
    for (const key of ['truth', 'prediction'])
      if (
        typeof row[key] !== 'number' ||
        !Number.isFinite(row[key]) ||
        Math.abs(row[key]) > 1000000
      )
        throw Error(`${key} must be finite and between −1,000,000 and 1,000,000.`);
    if (
      typeof row.scale !== 'number' ||
      !Number.isFinite(row.scale) ||
      row.scale < 1e-6 ||
      row.scale > 1e6
    )
      throw Error('Scale must be between 0.000001 and 1,000,000.');
    return { ...row, id, group };
  });
  if (!calibration || !evaluation)
    throw Error('Both calibration and evaluation rows are required.');
  if (groups.size > 30) throw Error('Use at most 30 group labels.');
  return clean;
}
export function threshold(scores, target) {
  if (!Array.isArray(scores) || !scores.length || scores.some((s) => !Number.isFinite(s) || s < 0))
    throw Error('Calibration scores must be finite nonnegative values.');
  if (!Number.isInteger(target) || target < 500 || target > 999)
    throw Error('Target coverage must be an integer from 500 to 999 per thousand.');
  const rank = Math.ceil(((scores.length + 1) * target) / 1000),
    sorted = [...scores].sort((a, b) => a - b);
  return {
    rank,
    n: scores.length,
    threshold: rank > sorted.length ? null : sorted[rank - 1],
    unbounded: rank > sorted.length,
    sorted,
  };
}
function summary(rows) {
  const n = rows.length,
    covered = rows.filter((r) => r.covered).length;
  return {
    n,
    covered,
    coverage: n ? covered / n : null,
    meanWidth:
      n && rows.every((r) => !r.unbounded) ? rows.reduce((s, r) => s + r.width, 0) / n : null,
    mae: n ? rows.reduce((s, r) => s + Math.abs(r.truth - r.prediction), 0) / n : null,
    rmse: n ? Math.sqrt(rows.reduce((s, r) => s + (r.truth - r.prediction) ** 2, 0) / n) : null,
  };
}
export function analyze(input, { mode = 'absolute', target = 900 } = {}) {
  const rows = validateRows(input);
  if (!['absolute', 'scaled'].includes(mode)) throw Error('Mode must be absolute or scaled.');
  const score = (row) => Math.abs(row.truth - row.prediction) / (mode === 'scaled' ? row.scale : 1),
    calibration = rows.filter((r) => r.split === 'calibration'),
    quantile = threshold(calibration.map(score), target),
    evaluation = rows
      .filter((r) => r.split === 'evaluation')
      .map((row) => {
        const margin = quantile.unbounded
          ? null
          : quantile.threshold * (mode === 'scaled' ? row.scale : 1);
        return {
          ...row,
          score: score(row),
          lower: margin === null ? null : row.prediction - margin,
          upper: margin === null ? null : row.prediction + margin,
          width: margin === null ? null : margin * 2,
          covered: quantile.unbounded || score(row) <= quantile.threshold,
          unbounded: quantile.unbounded,
        };
      }),
    groups = [...new Set(evaluation.map((r) => r.group))]
      .sort()
      .map((group) => ({ group, ...summary(evaluation.filter((r) => r.group === group)) }));
  return {
    mode,
    target,
    quantile,
    calibrationCount: calibration.length,
    evaluation,
    summary: summary(evaluation),
    groups,
  };
}
export function sweep(rows, mode, target) {
  return [...new Set([500, 600, 700, 800, 900, 950, 990, target])]
    .sort((a, b) => a - b)
    .map((level) => {
      const r = analyze(rows, { mode, target: level });
      return {
        target: level,
        threshold: r.quantile.threshold,
        unbounded: r.quantile.unbounded,
        ...r.summary,
      };
    });
}
function quote(value, protect) {
  const text = String(value ?? '');
  return (
    '"' +
    (protect && typeof value === 'string' && /^[=+\-@]/.test(text) ? "'" + text : text).replaceAll(
      '"',
      '""',
    ) +
    '"'
  );
}
export function intervalCSV(result) {
  return (
    [
      ['id', 'group', 'truth', 'prediction', 'scale', 'lower', 'upper', 'width', 'covered'],
      ...result.evaluation.map((row) => [
        row.id,
        row.group,
        row.truth,
        row.prediction,
        row.scale,
        row.unbounded ? '-Infinity' : row.lower,
        row.unbounded ? 'Infinity' : row.upper,
        row.unbounded ? 'Infinity' : row.width,
        row.covered,
      ]),
    ]
      .map((row) => row.map((value, column) => quote(value, column < 2)).join(','))
      .join('\r\n') + '\r\n'
  );
}
export function fixture(kind = 'mixed') {
  if (!['mixed', 'shift', 'tiny'].includes(kind)) throw Error('Unknown fixture.');
  let seed = 8421;
  function uniform() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed + 0.5) / 4294967296;
  }
  function normal() {
    return Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  }
  const rows = [];
  for (const split of ['calibration', 'evaluation']) {
    const count = kind === 'tiny' ? (split === 'calibration' ? 5 : 40) : 200;
    for (let i = 0; i < count; i++) {
      const group = i % 2 ? 'wide' : 'narrow',
        scale = group === 'wide' ? 12 : 3,
        prediction = 40 + 60 * uniform(),
        noise = normal() * scale * (kind === 'shift' && split === 'evaluation' ? 2 : 1);
      rows.push({
        id: `${split}-${i + 1}`,
        split,
        group,
        scale,
        prediction,
        truth: prediction + noise,
      });
    }
  }
  return rows;
}

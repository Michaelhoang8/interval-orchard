import { analyze, sweep } from './core.js';
self.onmessage = ({ data }) => {
  try {
    const result = analyze(data.rows, data.settings),
      curve = sweep(data.rows, data.settings.mode, data.settings.target);
    self.postMessage({ result, curve });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

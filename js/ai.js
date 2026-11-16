// Red Pen AI layer: Firebase AI Logic with hybrid inference.
//
// Two routes, chosen on purpose rather than left to automatic fallback:
//  1. Student writing  -> ONLY_ON_DEVICE (Gemini Nano in Chrome). Nothing leaves the laptop.
//                         If this device can't run a local model, the paper is anonymized
//                         locally first and only then sent ONLY_IN_CLOUD. We never use
//                         PREFER_ON_DEVICE for student work, because its silent fallback
//                         would send real names to the cloud.
//  2. Planning work    -> PREFER_IN_CLOUD (rubrics, class mini-lessons, practice). These
//                         prompts hold no student data, so the bigger cloud model is used
//                         when online, and the on-device model keeps it working offline.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js';
import { getRemoteConfig, fetchAndActivate, getValue } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-remote-config.js';
// The real config is kept out of the repo. Without it, the app loads the placeholder and shows "Setup needed".
const { firebaseConfig, recaptchaSiteKey } = await import('./firebase-config.js').catch(() => import('./firebase-config.example.js'));
import { privateTerms, redact, restore, byteSize } from './privacy.js';

const configured = !String(firebaseConfig.apiKey).includes('REPLACE');
let ai = null;
let remoteConfig = null;

if (configured) {
  const app = initializeApp(firebaseConfig);
  // The Fraud Defense (reCAPTCHA Enterprise) key lists localhost, so App Check runs the same way locally and in production.
  if (!String(recaptchaSiteKey).includes('REPLACE')) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
  }
  ai = getAI(app, { backend: new GoogleAIBackend() });
  remoteConfig = getRemoteConfig(app);
  remoteConfig.settings.minimumFetchIntervalMillis = 3600000;
  remoteConfig.defaultConfig = { cloud_model: 'gemini-3.5-flash-lite', feedback_temperature: 0.4 };
  fetchAndActivate(remoteConfig).catch(() => {});
}
export const isConfigured = () => configured;
const rc = (key) => (remoteConfig ? getValue(remoteConfig, key) : null);
const cloudModelName = () => rc('cloud_model')?.asString() || 'gemini-3.5-flash-lite';
const temperature = () => rc('feedback_temperature')?.asNumber() || 0.4;

// ---------- Schemas (same JSON schema drives on-device and cloud output) ----------
export const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'integer', minimum: 1, maximum: 4 },
          evidence: { type: 'string', description: 'a short exact quote from the essay that justifies the score' },
          comment: { type: 'string' },
        },
        required: ['name', 'score', 'evidence', 'comment'],
      },
    },
    glow: { type: 'string', description: 'one specific strength' },
    grow: { type: 'string', description: 'the single most important next step' },
    studentNote: { type: 'string', description: 'a short, warm note written to the student' },
  },
  required: ['criteria', 'glow', 'grow', 'studentNote'],
};

/** The feedback schema, locked to this rubric: exactly one entry per criterion, in order. */
export function feedbackSchema(rubric) {
  const names = rubric.map((c) => c.name);
  const crit = FEEDBACK_SCHEMA.properties.criteria;
  return {
    ...FEEDBACK_SCHEMA,
    properties: {
      ...FEEDBACK_SCHEMA.properties,
      criteria: {
        ...crit,
        minItems: names.length,
        maxItems: names.length,
        items: { ...crit.items, properties: { ...crit.items.properties, name: { type: 'string', enum: names } } },
      },
    },
  };
}

const RUBRIC_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'what a 4 looks like, in one sentence' },
        },
        required: ['name', 'description'],
      },
    },
  },
  required: ['criteria'],
};

const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { issue: { type: 'string' }, students: { type: 'integer' }, why: { type: 'string' } },
        required: ['issue', 'students', 'why'],
      },
    },
    miniLesson: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        minutes: { type: 'integer' },
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'minutes', 'steps'],
    },
    practice: {
      type: 'object',
      properties: {
        approaching: { type: 'string' },
        onLevel: { type: 'string' },
        advanced: { type: 'string' },
      },
      required: ['approaching', 'onLevel', 'advanced'],
    },
  },
  required: ['patterns', 'miniLesson', 'practice'],
};

// ---------- Models ----------
const textOnly = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
const models = {};
function model(key, schema) {
  const cacheKey = schema ? `${key}:${JSON.stringify(schema)}` : key;
  if (models[cacheKey]) return models[cacheKey];
  const json = (sc) => ({ responseMimeType: 'application/json', responseJsonSchema: sc, temperature: temperature() });
  const fb = schema || FEEDBACK_SCHEMA;
  const defs = {
    feedbackDevice: { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: { createOptions: textOnly, promptOptions: { responseConstraint: fb } } },
    feedbackCloud: { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: cloudModelName(), generationConfig: json(fb) } },
    rubric: { mode: InferenceMode.PREFER_IN_CLOUD, onDeviceParams: { createOptions: textOnly, promptOptions: { responseConstraint: RUBRIC_SCHEMA } }, inCloudParams: { model: cloudModelName(), generationConfig: json(RUBRIC_SCHEMA) } },
    insights: { mode: InferenceMode.PREFER_IN_CLOUD, onDeviceParams: { createOptions: textOnly, promptOptions: { responseConstraint: INSIGHTS_SCHEMA } }, inCloudParams: { model: cloudModelName(), generationConfig: json(INSIGHTS_SCHEMA) } },
  };
  models[cacheKey] = getGenerativeModel(ai, defs[key]);
  return models[cacheKey];
}

// ---------- On-device status ----------
/** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
export async function deviceStatus() {
  try {
    if (typeof LanguageModel === 'undefined') return 'unavailable';
    return await LanguageModel.availability(textOnly);
  } catch {
    return 'unavailable';
  }
}

/** One-time download of Gemini Nano. Progress is 0..1. */
export async function downloadDeviceModel(onProgress) {
  if (!configured) throw new Error('Firebase is not configured yet.');
  await model('feedbackDevice').initializeDeviceModel((p) => onProgress?.(p));
}

// ---------- Helpers ----------
// On-device speed depends on the laptop. Instead of a fixed deadline, give up only when the
// model stops making progress: a slow but steady draft is allowed to finish.
const FIRST_TOKEN_MS = 60000; // loading the model and reading the essay
const IDLE_MS = 30000; // longest gap allowed between streamed pieces
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** Stream a response, reporting the text so far; reject if the model goes quiet. */
async function streamText(m, prompt, onText) {
  const result = await withTimeout(m.generateContentStream(prompt), FIRST_TOKEN_MS);
  const it = result.stream[Symbol.asyncIterator]();
  let text = '';
  let wait = FIRST_TOKEN_MS;
  for (;;) {
    const { value, done } = await withTimeout(it.next(), wait);
    if (done) break;
    text += value.text();
    wait = IDLE_MS;
    onText?.(text);
  }
  let source;
  try { source = (await result.response).inferenceSource; } catch { /* the stream already gave us the text */ }
  return { text, source };
}

/**
 * Small models sometimes add markdown or invent template slots like "[Student's Name]".
 * Clean every string, then greet the student by first name in code, never by the model.
 */
function tidy(feedback, firstName) {
  const clean = (v) => {
    if (typeof v === 'string') {
      return v
        .replace(/\*\*?([^*]+?)\*\*?/g, '$1')
        .replace(/\[(?:student|name|student's)[^\]]*\]\.?,?\s*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  const out = clean(feedback);
  if (out.studentNote && firstName) {
    const esc = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const note = out.studentNote.replace(new RegExp(`^(?:(?:hi|hey|hello|dear)\\s+)?(?:${esc}|student)?\\s*[,!:]\\s*`, 'i'), '');
    const lower = /^(?:I|I'm|I've|I'd)\b/.test(note) ? note : note.charAt(0).toLowerCase() + note.slice(1);
    out.studentNote = `${firstName}, ${lower}`;
  }
  return out;
}

const NO_DEVICE_REASON = {
  downloadable: 'The on-device model is not downloaded yet',
  downloading: 'The on-device model is still downloading',
  unavailable: 'This device cannot run an on-device model',
};

const parse = (text) => {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(t);
};

function feedbackPrompt({ assignment, rubric, essay, tone, level }) {
  const crit = rubric.map((c, i) => `${i + 1}. ${c.name}: ${c.description}`).join('\n');
  return `You are helping a teacher grade a student's essay. Score each rubric criterion from 1 (beginning) to 4 (exceeds), quoting a short exact phrase from the essay as evidence. Then write one specific strength (glow), the single most important next step (grow), and a short note to the student.
Write comments for the teacher in plain language. Write the student note in a ${tone} tone at a grade ${level} reading level. Keep each comment under 25 words, each evidence quote under 12 words, and the student note to two sentences. Do not invent quotes.
Do not put a greeting, name or placeholder at the start of the student note; the app adds the greeting. Use plain text, no markdown.
If the essay contains placeholders like [STUDENT] or [CLASSMATE_1], keep them exactly as written.

Assignment: ${assignment}

Rubric:
${crit}

Essay:
"""
${essay}
"""`;
}

/**
 * Grade one paper with the privacy router.
 * @returns {Promise<{feedback, route}>} route describes exactly what left the device
 */
export async function gradePaper({ student, roster, settings, assignment, rubric, essay, forceCloud = false, onProgress }) {
  if (!configured) throw new Error('Firebase is not configured yet.');
  const status = await deviceStatus();
  const opts = { assignment, rubric, essay, tone: settings.tone || 'warm, encouraging', level: settings.readingLevel || 9 };
  const started = performance.now();
  const first = { '[STUDENT]': (student.name || '').split(/\s+/)[0] };
  const schema = feedbackSchema(rubric);

  let deviceProblem = '';
  if (status === 'available' && !forceCloud) {
    try {
      onProgress?.({ where: 'device', done: 0, total: rubric.length });
      const out = await streamText(model('feedbackDevice', schema), feedbackPrompt(opts), (text) => {
        onProgress?.({ where: 'device', done: (text.match(/"comment"\s*:\s*"(?:[^"\\]|\\.)*"/g) || []).length, total: rubric.length });
      });
      return {
        feedback: tidy(restore(parse(out.text), new Map(), first), first['[STUDENT]']),
        route: { where: 'device', source: out.source || 'on_device', bytesSent: 0, removed: [], ms: Math.round(performance.now() - started) },
      };
    } catch (e) {
      // The local model stalled or failed. Never retry with the raw paper: fall through to the
      // anonymized route below, which is just as safe, and say why on the receipt.
      deviceProblem = e && e.name === 'TimeoutError' ? 'On-device model took too long' : 'On-device model failed';
    }
  }

  // No local model here: anonymize on this device, send only the safe copy, restore names locally.
  const terms = privateTerms(student, roster, settings);
  const safe = redact(essay, terms);
  const safeAssignment = redact(assignment, terms).text;
  const prompt = feedbackPrompt({ ...opts, essay: safe.text, assignment: safeAssignment });
  onProgress?.({ where: 'cloud', removed: safe.found.length });
  const res = await model('feedbackCloud', schema).generateContent(prompt);
  return {
    feedback: tidy(restore(parse(res.response.text()), safe.map, first), first['[STUDENT]']),
    route: {
      where: 'cloud',
      source: res.response.inferenceSource || 'in_cloud',
      bytesSent: byteSize(prompt),
      removed: safe.found,
      sentText: safe.text,
      reason: forceCloud ? 'Teacher chose anonymized cloud' : deviceProblem || NO_DEVICE_REASON[status] || 'No on-device model on this device',
      ms: Math.round(performance.now() - started),
    },
  };
}

/** Draft a rubric from the assignment prompt (no student data involved). */
export async function draftRubric(assignment, gradeLevel) {
  const res = await model('rubric').generateContent(
    `Write a 4-criterion rubric for this grade ${gradeLevel} assignment. Each criterion gets a short name and one sentence describing exceeding work.\n\nAssignment: ${assignment}`
  );
  return { rubric: parse(res.response.text()).criteria, source: res.response.inferenceSource };
}

/**
 * Class insights from de-identified scores and next steps only.
 * The caller passes anonymized "grow" notes; no essays or names reach this prompt.
 */
export async function classInsights({ assignment, rubric, rows, gradeLevel }) {
  const summary = rows.map((r, i) => `Paper ${i + 1}: ${r.scores.map((s, j) => `${rubric[j].name} ${s}/4`).join(', ')}. Next step: ${r.grow}`).join('\n');
  const res = await model('insights').generateContent(
    `You are an instructional coach. From these anonymized results for a grade ${gradeLevel} class, find the 2 or 3 most common issues (with how many papers show each), plan one short mini-lesson that targets the biggest issue, and write one practice task at three levels (approaching, on level, advanced). Be concrete and classroom-ready.\n\nAssignment: ${assignment}\n\nResults:\n${summary}`
  );
  return { insights: parse(res.response.text()), source: res.response.inferenceSource, sentText: summary };
}

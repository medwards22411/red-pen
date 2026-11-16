// Red Pen privacy layer.
// Student writing only leaves this device after names and identifiers are swapped
// for placeholders, and the placeholders are swapped back locally when the answer returns.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = [
  { tag: 'EMAIL', re: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g },
  { tag: 'LINK', re: /\b(?:https?:\/\/|www\.)\S+/gi },
  { tag: 'PHONE', re: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  { tag: 'DATE', re: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})\b/g },
  { tag: 'ADDRESS', re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl)\b/g },
  { tag: 'ID', re: /\b\d{5,}\b/g },
];

/**
 * Build the list of private terms for one student's paper.
 * @param {object} student  the student whose paper this is
 * @param {object[]} roster  every student in the class
 * @param {object} settings  teacher name, school name, extra private terms
 */
export function privateTerms(student, roster, settings = {}) {
  const terms = [];
  const add = (text, tag) => {
    const t = (text || '').trim();
    if (t.length >= 2 && !terms.some((x) => x.text.toLowerCase() === t.toLowerCase())) terms.push({ text: t, tag });
  };
  const nameParts = (p) => [p.name, ...(p.name || '').split(/\s+/), ...(p.aliases || [])];
  // the student first, so "Maya Chen" wins over "Maya"
  for (const n of nameParts(student)) add(n, 'STUDENT');
  let i = 0;
  for (const p of roster) {
    if (p.id === student.id) continue;
    i += 1;
    for (const n of nameParts(p)) add(n, `CLASSMATE_${i}`);
  }
  if (settings.teacher) {
    add(settings.teacher, 'TEACHER');
    const last = settings.teacher.split(/\s+/).pop();
    for (const t of ['Mr.', 'Ms.', 'Mrs.', 'Mx.', 'Dr.']) add(`${t} ${last}`, 'TEACHER');
  }
  if (settings.school) add(settings.school, 'SCHOOL');
  for (const t of (settings.extraTerms || '').split(/[,\n]/)) add(t, 'PRIVATE');
  // longest first so full names replace before first names
  return terms.sort((a, b) => b.text.length - a.text.length);
}

/**
 * Replace private details with placeholders.
 * Returns the safe text plus a map to put the real values back.
 */
export function redact(text, terms) {
  let out = text;
  const found = [];
  const map = new Map(); // placeholder -> original
  const counters = {};
  const placeholderFor = (tag, original) => {
    for (const [ph, orig] of map) if (orig.toLowerCase() === original.toLowerCase()) return ph;
    let ph;
    if (/^(STUDENT|TEACHER|SCHOOL|CLASSMATE_\d+)$/.test(tag)) ph = `[${tag}]`;
    else { counters[tag] = (counters[tag] || 0) + 1; ph = `[${tag}_${counters[tag]}]`; }
    // a first name and full name of the same person share a tag; keep the longest original
    if (!map.has(ph) || map.get(ph).length < original.length) map.set(ph, original);
    return ph;
  };
  const applyPatterns = (list) => {
    for (const p of list) {
      out = out.replace(p.re, (m) => {
        const ph = placeholderFor(p.tag, m);
        found.push({ type: p.tag, original: m, placeholder: ph });
        return ph;
      });
    }
  };
  // emails and links first, so a name inside an address doesn't break detection
  applyPatterns(PATTERNS.filter((p) => p.tag === 'EMAIL' || p.tag === 'LINK'));
  for (const t of terms) {
    const re = new RegExp(`(?<![\\w'])${esc(t.text)}(?:'s)?(?![\\w])`, 'gi');
    out = out.replace(re, (m) => {
      const possessive = /'s$/i.test(m) && !/'s$/i.test(t.text);
      const base = possessive ? m.slice(0, -2) : m;
      const ph = placeholderFor(t.tag, base);
      found.push({ type: t.tag.replace(/_\d+$/, ''), original: base, placeholder: ph });
      return possessive ? `${ph}'s` : ph;
    });
  }
  applyPatterns(PATTERNS.filter((p) => p.tag !== 'EMAIL' && p.tag !== 'LINK'));
  return { text: out, found, map };
}

/** Put the real values back into anything the cloud model returned. */
export function restore(value, map, firstNames = {}) {
  if (typeof value === 'string') {
    return value.replace(/\[(STUDENT|TEACHER|SCHOOL|CLASSMATE_\d+|EMAIL_\d+|LINK_\d+|PHONE_\d+|DATE_\d+|ADDRESS_\d+|ID_\d+|PRIVATE_\d+)\]/g, (ph) => {
      // address the student by first name in feedback, not "Maya Chen"
      if (firstNames[ph]) return firstNames[ph];
      return map.get(ph) ?? ph;
    });
  }
  if (Array.isArray(value)) return value.map((v) => restore(v, map, firstNames));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, map, firstNames)]));
  }
  return value;
}

export const byteSize = (s) => new TextEncoder().encode(s).length;

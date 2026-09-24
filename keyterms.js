/* Deepgram keyterms: technical terms from the job description (e.g. "S/4HANA", "CPI", "iFlow")
   sent with live listening so Nova-3 transcribes them correctly.
   Deepgram allows 500 tokens across all keyterms and recommends the 20-50 most important. */

const MAX_TERMS = 50;
const MAX_TOTAL_CHARS = 1200; // stays well under Deepgram's 500-token limit
const MAX_TERM_CHARS = 40;

const PROMPT = `From the job description below, list the technical terms a speech-to-text system is most likely to mishear in an interview about this role: product and module names, acronyms, tools, frameworks, protocols, and domain jargon (for SAP roles, e.g. S/4HANA, BTP, CPI, iFlow, IDoc, OData, ABAP, Fiori, CAP, RAP, MM, SD, FICO).

Rules:
- At most ${MAX_TERMS} terms, most important first.
- Exact spelling and capitalization as written or as officially styled.
- Skip generic words (e.g. "team", "experience", "communication", "cloud").
- Reply with only a JSON array of strings.`;

/* Cleans a list: trims, drops junk and duplicates (case-insensitive), caps count and total size. */
function clean(list) {
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > MAX_TERM_CHARS || !/[A-Za-z]/.test(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    if (total + t.length > MAX_TOTAL_CHARS) break;
    seen.add(k);
    out.push(t);
    total += t.length;
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/* Fallback without Claude: acronyms (CPI, S/4HANA, OData), mixed-case words (iFlow, SuccessFactors),
   and words joined to "SAP" (SAP Ariba). Ranked by how often they appear. */
function heuristic(jd) {
  const counts = new Map();
  const add = (t) => counts.set(t, (counts.get(t) || 0) + 1);
  const text = String(jd || '');
  for (const m of text.matchAll(/\bSAP\s+(?:[A-Z][A-Za-z0-9/]*)(?:\s+[A-Z][A-Za-z0-9/]*)?/g)) add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z0-9]*[A-Z][A-Za-z0-9]*(?:\/[A-Za-z0-9]+)*\b/g)) {
    const w = m[0];
    const acronym = /^[A-Z0-9/]{2,}$/.test(w) && /[A-Z]/.test(w);
    const mixed = /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1)); // iFlow, OData, SuccessFactors
    const withSlash = w.includes('/');
    if (acronym || mixed || withSlash) add(w);
  }
  const common = new Set(['I', 'A', 'US', 'OR', 'AND', 'THE', 'TO', 'IN', 'OF', 'IT', 'HR', 'OK', 'EOE']);
  const ranked = [...counts.entries()].filter(([t]) => !common.has(t)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  return clean(ranked);
}

/* Asks Claude for the terms; falls back to the heuristic on any problem. */
async function extract(jd, client, model) {
  if (client) {
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 600,
        messages: [{ role: 'user', content: `${PROMPT}\n\nJOB DESCRIPTION:\n${String(jd).slice(0, 12000)}` }],
      });
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
      const terms = clean(JSON.parse(json));
      if (terms.length) return terms;
    } catch (e) {
      console.error('Keyterm extraction fell back to the simple extractor:', e.message);
    }
  }
  return heuristic(jd);
}

/* Adds the terms to a Deepgram listen URL as repeated keyterm= parameters. */
function withKeyterms(baseUrl, terms) {
  const url = new URL(baseUrl);
  for (const t of terms || []) url.searchParams.append('keyterm', t);
  return url.toString();
}

module.exports = { extract, heuristic, clean, withKeyterms };

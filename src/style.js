// Each business's own messaging psychology: a playbook for every message, plus rules and example
// messages for each kind of customer. The AI follows them and imitates the examples; RecoverKit's
// safety rules (no invented facts, links, phone numbers or pressure) still apply on top.

export const STAGES = {
  funded_not_bought: { label: 'Funded their wallet, never bought', hint: 'They trusted you with money and stopped.' },
  registered: { label: 'Signed up, never did anything', hint: 'They never got started.' },
  checkout_abandoned: { label: 'Started a checkout, never paid', hint: 'Something stopped them at the last step.' },
  browsed: { label: 'Browsed, never bought', hint: 'Interested, not convinced yet.' },
  bought_once: { label: 'Bought once, went quiet', hint: 'One purchase, then nothing.' },
  lapsed_repeat: { label: 'Regular customer, went quiet', hint: 'Used to buy often, then stopped.' },
};
export const LIMITS = { playbook: 4000, rules: 1000, example: 500, examples: 5 };

const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

/** Examples are pasted one per paragraph (separated by a blank line). */
export function splitExamples(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((e) => clean(e, LIMITS.example)).filter((e) => e.length >= 5).slice(0, LIMITS.examples);
}

export function validateStyle(input) {
  const out = { playbook: clean(input.playbook, LIMITS.playbook), stages: {} };
  for (const k of Object.keys(STAGES)) {
    const rules = clean(input[`rules_${k}`], LIMITS.rules);
    const examples = splitExamples(input[`examples_${k}`]);
    for (const e of examples) {
      if (/https?:\/\/|www\./i.test(e)) throw new Error(`${STAGES[k].label}: leave links out of examples (your payment link is added for you)`);
      if (/\+?\d[\d\s-]{8,}\d/.test(e)) throw new Error(`${STAGES[k].label}: leave phone numbers out of examples`);
    }
    if (rules || examples.length) out.stages[k] = { rules, examples };
  }
  return out;
}

export const parseStyle = (json) => { try { const s = JSON.parse(json || '{}'); return { playbook: s.playbook || '', stages: s.stages || {} }; } catch { return { playbook: '', stages: {} }; } };

/** The part of the system prompt that carries the business's own style for this customer's stage. */
export function stylePrompt(style, stage) {
  const s = style || { playbook: '', stages: {} };
  const st = s.stages?.[stage] || null;
  if (!s.playbook && !st) return '';
  const parts = ['\n\nThe business has written its own messaging playbook. Follow it: where it differs from the general style advice above, the business wins. The rules about never inventing facts, discounts or deadlines, no links or phone numbers, and no pressure or guilt still always apply.'];
  if (s.playbook) parts.push(`\n<business_playbook>\n${s.playbook}\n</business_playbook>`);
  if (st?.rules) parts.push(`\nFor this kind of customer (${STAGES[stage]?.label || stage}), the business says:\n<stage_rules>\n${st.rules}\n</stage_rules>`);
  if (st?.examples?.length) {
    parts.push(`\nMessages the business wrote for this kind of customer. Match their tone, length, structure and psychology, but write a fresh message for this person; don't copy one word for word:\n${st.examples.map((e, i) => `<example n="${i + 1}">\n${e}\n</example>`).join('\n')}`);
  }
  return parts.join('');
}

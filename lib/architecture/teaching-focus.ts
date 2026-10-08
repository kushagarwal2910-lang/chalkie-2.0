const audienceFocus = {
  developer: {
    label: "Engineer onboarding",
    summary: "Understand the purpose, follow a documented workflow, and find where to start contributing.",
    prompt: "Explain this repository to an engineer joining the team. Establish what problem it solves, then trace one concrete supported workflow through the actual implementation: input, entry point, transformations, calls, relevant decisions and output. Explain why each handoff matters for the next step. Include enough mechanism to let the engineer reason about a change, then point to the relevant extension point when evidenced.",
  },
  "cross-team": {
    label: "Product & engineering",
    summary: "Connect the documented purpose to component roles, handoffs, and outcomes in plain language.",
    prompt: "Explain this repository to product and engineering teammates. Connect its documented purpose to the roles of its components, their supported handoffs, and the resulting outcome. Define necessary technical terms through the example and clarify responsibilities only when documented.",
  },
  leadership: {
    label: "Leadership overview",
    summary: "Explain the documented purpose, the main moving parts, and the outcome without jargon.",
    prompt: "Explain this repository to a nontechnical leader or investor. Start with its documented purpose and outcome, then walk through the main component roles and supported handoffs in plain language. Do not invent business impact, performance, scale, customers, or operational maturity.",
  },
} as const;

function focusFor(audience: string) {
  return audience === "cross-team" || audience === "leadership" ? audienceFocus[audience] : audienceFocus.developer;
}

export function defaultExplanationFocus(audience: string = "developer") {
  return focusFor(audience).prompt + " Teach like a patient teammate using the diagram. Synthesize code and documentation into cause and effect, never a list of filenames or captions. Use a concrete illustrative input when helpful without inventing repository behavior. Keep code details and full paths in source references. Separate static implementation from verified runtime state; be precise about any remaining missing fact instead of saying broadly that you lack context.";
}

export function effectiveExplanationFocus(custom: string | undefined, audience: string) {
  return custom?.trim() || defaultExplanationFocus(audience);
}

/** UI copy describes the default without placing generated instructions in user input. */
export function defaultExplanationFocusHint(audience: string = "developer") {
  const { label, summary } = focusFor(audience);
  return { label, summary };
}

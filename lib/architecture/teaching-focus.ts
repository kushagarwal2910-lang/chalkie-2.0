const audienceFocus = {
  developer: {
    label: "Engineer onboarding",
    summary: "Understand the purpose, follow a documented workflow, and find where to start contributing.",
    prompt: "Explain this repository to an engineer joining the team. Start with its documented purpose, then walk through one supported workflow: where it starts, what each component does, what passes between components, and what it produces. Point out where to inspect or contribute first only when the sources support it.",
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
  return focusFor(audience).prompt + " Teach like a patient teammate using the diagram, not a list of labels. Base repository claims on the supplied evidence and separate general background from documented behavior. If no workflow is documented, explain the supported roles or structure instead of inventing a sequence.";
}

export function effectiveExplanationFocus(custom: string | undefined, audience: string) {
  return custom?.trim() || defaultExplanationFocus(audience);
}

/** UI copy describes the default without placing generated instructions in user input. */
export function defaultExplanationFocusHint(audience: string = "developer") {
  const { label, summary } = focusFor(audience);
  return { label, summary };
}

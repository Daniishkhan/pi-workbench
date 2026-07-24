---
name: grill-me
description: Pressure-test a plan or design through a bounded Socratic interview, one consequential question at a time. Use when a planning task explicitly asks to grill, interview, harden, or challenge the target before finalizing it.
---

# Grill a plan

Pressure-test the current plan, design, spec, or idea before producing the final planning artifact. Critique the proposal, never the person.

## Protocol

1. Read the target, repository instructions, and relevant source evidence before asking anything. Do not ask the user for facts you can verify yourself.
2. Identify the single unknown whose answer could invalidate the largest part of the plan.
3. Ask exactly one concise question through `contact_supervisor` with `reason: "interview_request"`. Request one text answer; never batch questions or finish the child turn with a question in normal assistant text.
4. Stay alive for the reply. Incorporate it, record any decision or conceded gap, inspect more evidence when useful, and choose the next highest-risk unknown.
5. Stop when no consequential user-owned unknown remains, the user says to stop, or eight questions have been answered. Do not prolong the interview for reversible implementation details that existing repository patterns settle.
6. Produce the hardened plan rather than a standalone interview transcript.

## What to challenge

Prioritize:

- hidden assumptions and untested premises;
- expected day-one behavior omitted from scope;
- dependency, integration, malformed-input, retry, concurrency, and cleanup failures;
- irreversible choices, migrations, and blast radius;
- observable acceptance criteria and validation evidence;
- non-goals that users could reasonably mistake for supported behavior.

Push back once when an answer is materially vague. If it remains unresolved, record an open risk and move on rather than looping.

## Supervisor request shape

Use a single-question structured request shaped like:

```json
{
  "reason": "interview_request",
  "message": "Plan grill: resolving the highest-risk remaining assumption.",
  "interview": {
    "title": "Plan grill",
    "questions": [
      {
        "id": "answer",
        "prompt": "<one sharp question>",
        "type": "text"
      }
    ]
  }
}
```

Accept the supervisor's reply as the user's answer. If the live supervisor channel is unavailable, do not invent answers: finish with the blocked question listed as the highest open risk.

## Final artifact additions

Alongside the planner's normal implementation plan and handoff, include:

- **Hardened summary** — the amended behavior and scope;
- **Decisions made** — one plain-language line per answer that changed or confirmed the plan;
- **Open risks** — unresolved gaps ranked by blast radius, including the blocked question when applicable.

Remain read-only. The runtime may persist the final planning artifact, but do not modify project or source files.

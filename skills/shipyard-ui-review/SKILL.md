---
name: shipyard-ui-review
description: Review UI changes for user-flow correctness, accessibility, responsive behavior, state feedback, copy, and visual regressions. Use when implementation changes screens, components, forms, navigation, or user-facing status.
---

# Shipyard UI review

Review the product behavior, not only component syntax.

Check:

- primary flow, empty/loading/error/success/disabled states;
- keyboard access, focus order, visible focus, and focus restoration;
- semantic elements, labels, names, roles, announcements, and error association;
- contrast, truncation, overflow, responsive layout, zoom, and reduced motion;
- stale state, duplicate submission, optimistic updates, and navigation races;
- user-visible copy for precision, actionability, and consistency;
- visual hierarchy and whether controls look and behave like their affordances;
- browser interaction or screenshots when available.

Trace data and event flow through the component boundary. A visually plausible static state is not sufficient if keyboard, asynchronous, or failure behavior is wrong.

Record only concrete failures with an affected user scenario and focused validation steps.

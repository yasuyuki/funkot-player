---
name: ui-design
description: Review or refine funkot-player UI layout and interaction hierarchy with the project’s rendered-screen review procedure.
---

# UI design

Use this skill for UI, layout, or interaction changes in `funkot-player`. Read [the project UI design and review procedure](../../../docs/ui-design.md) first; it is the single source for principles and the eight visual review criteria.

Inspect the existing related screens and entrypoints before designing a change.
Before implementation, record:

- the user’s main goal and task sequence;
- primary, secondary, and rare actions;
- the permanent UI area or controls being added;
- why an existing entrypoint cannot be reused, but only when proposing a new entrypoint.

Choose one recommended UI that serves the stated task. Do not invent a generic platform or unspecified design system. Group search, sort, and filter controls by purpose, distinguish displayed metadata from interactive controls, and preserve title, artist, and the main row action area. Use progressive disclosure for rare actions and reuse existing components, tokens, and entrypoints first.

After implementation, run the relevant existing unit tests and `npm run check`. Then run the documented `npm run ui:capture` entrypoint and inspect the 1280×900 and 412×915 library, tag filter, and tag editor captures. Extend the fixture/captures when the changed screen or state is not covered by the Library examples. Apply all eight criteria in the linked document; the command and HTML report are evidence of rendering, not human visual approval. A trivial CSS or text change may skip capture only when it clearly cannot affect layout or interaction hierarchy. This exception does not authorize a broader unreviewed fix.

This workflow does not require external design services or large vendored guidelines. Preserve accessible names, focus, keyboard order, contrast, targets, and meaningful UI states.

Record the source revision, checks, reviewed captures and main findings in the task’s result location. Do not declare the affected UI complete with a clear new hierarchy or density problem unresolved; distinguish pre-existing findings outside the task from changes you must fix.

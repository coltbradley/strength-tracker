# Version D: session header and sync chip

Review items 12-13 of the Version D redesign (`chats/chat1.md`).

- The session topbar replaces the "SET" wordmark with `☰ done/total` and a
  Focus | List toggle. App owns the topbar and provides a DOM slot through
  `SessionHeaderSlotContext`; Session portals its controls into it
  (`components/session/SessionHeader.tsx`). Without a shell (isolated test
  renders) the controls render inline instead.
- `☰` opens "Today's workout" (`TodayWorkoutSheet.tsx`): the units switch,
  one row per exercise, Finish session. The list-mode heading no longer has a
  unit switch of its own. `renderRowHandle` is the reserved place for the
  drag-to-reorder handle.
- The sync pill became a chip: a round 44px ✓ when synced, widening to glyph
  + label (`◐ On phone · N`, `↑ Sending · N`, `‖ Held`, filled `! Review`).
  Tap behaviour is unchanged: flush for waiting/retrying, open the queue for
  held and failed. A retryable failure stays neutral ("On phone"); only a
  dead write is filled danger.
- The design prototype's inline styles were not copied: all rules are tokens in
  `styles.css` under "session header (Version D)" and "sync chip".

# Delver Themes

Built-in color themes for Delver.

- **Delver Dark** — default dark theme.
- **Delver Light** — default light theme.

These themes reserve a semantic palette for reverse-engineering content:

- `delver.listing.controlFlow` — control-flow instructions
- `delver.listing.dataRef` — data references
- `delver.listing.stringRef` — string references
- `delver.listing.importThunk` — imports and thunks
- `delver.diff.modifiedBytes` — modified bytes
- `delver.state.uncertain` — analysis results with low confidence
- `delver.state.stale` — stale or cached data
- `delver.state.unreadable` — unreadable memory
- `delver.state.proposed` — proposed or speculative results

Individual Delver contributions register these color IDs with defaults; the
Delver themes override them to keep meaning consistent across the UI.

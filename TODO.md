# TODO / FEATURE WISHLIST

- Text: select fonts and choose them from Google Fonts as well
- Text: styling text spans by selecting text and styling it, e.g. making a section bold or italic, changing a font, or color, ...
- work more on refining the design: tighten up in some spaces, where you can, make the UI feel nice and usable
- more complex path operations like outline stroke, or even pathfinder operations like union/subtract,intersect,exclude (flatten + "frame selection" in the right-click menu wait on this)

# DONE (things are moved here once they are done)

- Outliner drag-reorganization: drag layer rows to reorder; drop onto a frame/group row to nest inside it (drop zones: above / into / below, with indicators)

- Text: word wrapping to the text box (greedy, against real canvas metrics) with explicit newlines; Enter inserts a newline while editing, Escape commits
- Text: horizontal (left/center/right) and vertical (top/middle/bottom) alignment, honored on canvas, in the inline editor, and in SVG export

- Image uploads: drop a file on the canvas or File > Place image. Assets are content-addressed in R2 (re-uploads dedupe); image nodes move/resize/blend like any layer and export to SVG/PNG

- Multiplayer presence: live named cursors over WebSockets (one presence room per document, hosted by its Durable Object), plus live document sync — when another editor saves, your copy refreshes automatically (unless you have unsaved changes; then last writer wins)
- Blend modes (multiply, screen, overlay, … — all 16 CSS modes) per layer, in canvas rendering and SVG export

- Custom color picker (SV square, hue + opacity sliders, hex input) with an eyedropper that samples pixels already on the canvas; picker drags coalesce into one undo step

- Text: text bug: text shifts around when clicking it to edit on the canvas
- If I draw an object in a frame, it appears in the outliner as belonging to that frame (and stays selectable inside it)
- Cmd-+ Cmd-- to zoom in / zoom out
- If I have multiple shapes I can transform them together (resize handles on the joint bounding box; also resizes groups)
- Right click menu: copy, cut, paste, duplicate, bring to front, send to back, group/ungroup, show/hide, lock/unlock, delete (+ ⌘C/⌘X/⌘V/⌘]/⌘[ shortcuts)

- Option-dragging to copy shapes
- Snapping to other shapes (edges + centers, red guide lines while dragging)
- Renaming a frame by clicking the name on the canvas (double-click the label)
- Editing text on the canvas by double-clicking and just typing
- "Copy as SVG" feature (Edit menu)
- Ligma menu that has all features of the app sorted like a classical Mac app (File/Edit/View/Object)
- Arrange options to align multiple objects or distribute them horizontally/vertically
- Change filename (click the name in the top bar)
- See file name in HTML title attribute and see it change when file name is changed in the doc

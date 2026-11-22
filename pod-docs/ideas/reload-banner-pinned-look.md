# Idea: Polish the pinned Reload banner's look

Status: parked

## The idea
Make the Reload banner look good when it is pinned. PR #159 pins it to the top of the main column with `position: sticky` (`alert-banner.css`). It works: when the page scrolls, the banner stays in view. But the human found it does not look good (2026-11-22, in the browser build, on Settings scrolled down). It reads as a box that floats over the scrolled content, inside the 720 px column, and the page shows beside it and above it.

Directions to draw and compare:
- A full-width bar across the top of the window.
- A background strip behind the box, so content does not show around it.
- A slim one-line form once the page scrolls.
- A shadow or a rule under it.

Related: the queue entry of 2026-11-21 says the scroll room above a focused field is fixed (92 px, or 124 px at 480 px and below), not the banner's real height. A new look changes the height, so fix both together.

## Why it's on hold
It is polish. The banner works, and desktop users rarely see it, because the desktop app reloads its window by itself after a server restart.

## What would make it worth building
A UI polish pass before v0.1.0, or a change that touches the banner or the page layout again.

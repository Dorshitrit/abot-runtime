# Store artwork

These PNG/ICO files render the existing `src/web-ui/app/favicon.svg` artwork,
using its dark-background colors (`#eafffb`, `#33f2bd`) and transparent background.
No new logo or icon design was introduced. The manifest supplies the dark tile color.

Generated with `@resvg/resvg-js` 2.6.2: remove the SVG `<style>` element, replace
class `a`/`b` with the two fills above, render with `fitTo: {mode: 'width', value: N}`.
The dimensions are 50, 44, and 150 pixels. `Companion.ico` contains one 256-pixel
PNG image in a standard ICO container (one plane, 32 bits per pixel).

The conversion tool is maintainer tooling only; it is not a Companion dependency.

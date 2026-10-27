// Renders the 14b logo to a multi-size Windows icon.
//
//   node tools/maintenance/make-app-icon.cjs <out.ico> [<png-dir>]
//
// Needs @resvg/resvg-js, which is NOT a project dependency. Install it outside the repository and point
// NODE_PATH at that node_modules folder, for example:
//   NODE_PATH=<tool-dir>/node_modules node tools/maintenance/make-app-icon.cjs out.ico
const fs = require("fs");
const path = require("path");

const SOURCE = path.join(__dirname, "..", "..", "docs", "design", "rewind-3a", "assets", "logo-14b.svg");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function iconSvg() {
  const source = fs.readFileSync(SOURCE, "utf8");
  // The export carries a provenance blob and a CSS drop shadow that would be clipped at the icon's edge.
  return source
    .replace(/<metadata>[\s\S]*?<\/metadata>/, "")
    .replace(/^<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">');
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    entries.writeUInt8(size === 256 ? 0 : size, at);
    entries.writeUInt8(size === 256 ? 0 : size, at + 1);
    entries.writeUInt8(0, at + 2);
    entries.writeUInt8(0, at + 3);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

function main() {
  const [out, pngDir] = process.argv.slice(2);
  if (!out) {
    console.error("usage: make-app-icon.cjs <out.ico> [<png-dir>]");
    process.exit(2);
  }
  const { Resvg } = require("@resvg/resvg-js");
  const svg = iconSvg();
  const images = SIZES.map((size) => {
    const rendered = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
    if (rendered.width !== size || rendered.height !== size) {
      throw new Error(`Expected ${size}x${size}, rendered ${rendered.width}x${rendered.height}`);
    }
    const png = rendered.asPng();
    if (pngDir) fs.writeFileSync(path.join(pngDir, `icon-${size}.png`), png);
    console.log(`${size}x${size}: ${png.length} bytes`);
    return { size, png };
  });
  fs.writeFileSync(out, ico(images));
  console.log(`${out}: ${fs.statSync(out).size} bytes, ${images.length} sizes`);
}

main();

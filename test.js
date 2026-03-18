const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('script.js', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');
console.log("HTML length:", html.length);
console.log("JS length:", js.length);
console.log("CSS length:", css.length);

const hitTest = js.includes('tw.addEventListener');
const tgtTest = js.includes('main-target');
const ptTest = css.includes('pointer-events: auto');
console.log("tw bound:", hitTest);
console.log("main target bound:", tgtTest);
console.log("pointer events:", ptTest);


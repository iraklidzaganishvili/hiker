// scripts/simplify-hikes.js
// One-time migration: simplify routes + assign stable IDs
// Run: node scripts/simplify-hikes.js <input> <output>

const fs = require('fs');
const turf = require('@turf/turf');
const crypto = require('crypto');

const input = process.argv[2];
const output = process.argv[3];

if (!input || !output) {
  console.error('Usage: node simplify-hikes.js <input.json> <output.json>');
  process.exit(1);
}

const hikes = JSON.parse(fs.readFileSync(input, 'utf-8'));
let totalBefore = 0;
let totalAfter = 0;

const simplified = hikes.map(h => {
  // Ensure stable ID
  if (h.id == null || typeof h.id === 'number') {
    h.id = crypto.randomUUID();
  }

  if (h.route && h.route.coordinates && h.route.coordinates.length > 2) {
    const before = h.route.coordinates.length;
    totalBefore += before;

    const line = turf.lineString(h.route.coordinates);
    const simple = turf.simplify(line, { tolerance: 0.00005, highQuality: true });
    h.route.coordinates = simple.geometry.coordinates;

    const after = h.route.coordinates.length;
    totalAfter += after;

    console.log(`${h.name}: ${before} -> ${after} points (${((1 - after/before) * 100).toFixed(0)}% reduction)`);
  }
  return h;
});

fs.writeFileSync(output, JSON.stringify(simplified, null, 2), 'utf-8');
const sizeBefore = fs.statSync(input).size;
const sizeAfter = fs.statSync(output).size;
console.log(`\nTotal points: ${totalBefore} -> ${totalAfter}`);
console.log(`File size: ${(sizeBefore/1024/1024).toFixed(1)} MB -> ${(sizeAfter/1024/1024).toFixed(1)} MB`);

const fs = require('fs');
for (const p of [
  'modules/vehicle-tracker/android/src/main/java/expo/modules/vehicletracker/TrackingService.kt',
  'modules/vehicle-tracker/android/src/main/java/expo/modules/vehicletracker/TrackingConfig.kt',
]) {
  const src = fs.readFileSync(p, 'utf8');
  const stripped = src
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(\.|[^"\])*"/g, '""')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  let d = 0, min = 0;
  for (const ch of stripped) {
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d < min) min = d; }
  }
  const name = p.split('/').pop();
  console.log(`${name.padEnd(22)} balance ${d}  minDepth ${min}  ${d === 0 && min === 0 ? 'OK' : '** UNBALANCED **'}`);
}

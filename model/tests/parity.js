// Usage: node parity.js <ipos.json> <params.json> <today>  → JSON array of scores (same order as ipos)
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'site', 'score.js'));
const [,, iposPath, paramsPath, today] = process.argv;
const live = JSON.parse(fs.readFileSync(iposPath, 'utf8'));
const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
const out = live.ipos.map(ipo => S.scoreIpo(ipo, params, live.market, S.defaultCosts(), today));
process.stdout.write(JSON.stringify(out));

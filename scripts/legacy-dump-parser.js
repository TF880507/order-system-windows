'use strict';

const fs = require('fs');

const INSERT_MARKER = 'INSERT INTO `';

function decodeEscape(character) {
  return ({ '0':'\0', b:'\b', n:'\n', r:'\r', t:'\t', Z:'\x1a' })[character] ?? character;
}

async function* parseLegacyDump(filePath, acceptedTables = null) {
  const stream = fs.createReadStream(filePath, { encoding:'utf8', highWaterMark:1024 * 1024 });
  let mode = 'search';
  let markerIndex = 0;
  let table = '';
  let valuesIndex = 0;
  const valuesMarker = 'VALUES ';
  let accepted = false;
  let inTuple = false;
  let inString = false;
  let escaped = false;
  let token = '';
  let row = [];

  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];

      if (mode === 'search') {
        if (character === INSERT_MARKER[markerIndex]) {
          markerIndex += 1;
          if (markerIndex === INSERT_MARKER.length) {
            mode = 'table';
            table = '';
            markerIndex = 0;
          }
        } else {
          markerIndex = character === INSERT_MARKER[0] ? 1 : 0;
        }
        continue;
      }

      if (mode === 'table') {
        if (character === '`') {
          accepted = !acceptedTables || acceptedTables.has(table);
          mode = 'values';
          valuesIndex = 0;
        } else {
          table += character;
        }
        continue;
      }

      if (mode === 'values') {
        if (character === valuesMarker[valuesIndex]) {
          valuesIndex += 1;
          if (valuesIndex === valuesMarker.length) mode = 'rows';
        } else {
          valuesIndex = character === valuesMarker[0] ? 1 : 0;
          if (character === ';' || character === '\n') mode = 'search';
        }
        continue;
      }

      if (!inTuple) {
        if (character === '(') {
          inTuple = true;
          inString = false;
          escaped = false;
          token = '';
          row = [];
        } else if (character === ';') {
          mode = 'search';
        }
        continue;
      }

      if (escaped) {
        token += decodeEscape(character);
        escaped = false;
      } else if (inString && character === '\\') {
        escaped = true;
      } else if (character === "'") {
        inString = !inString;
      } else if (!inString && (character === ',' || character === ')')) {
        const trimmed = token.trim();
        row.push(trimmed === 'NULL' ? null : token);
        token = '';
        if (character === ')') {
          inTuple = false;
          if (accepted) yield { table, row };
        }
      } else {
        token += character;
      }
    }
  }

  if (inTuple || inString || escaped) throw new Error('SQL dump 結尾不完整，無法安全匯入');
}

module.exports = { parseLegacyDump };

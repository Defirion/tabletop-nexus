// Dependency-free QR Code generator for short portal links.
//
// Scope is deliberately narrow: byte mode, error-correction level M, versions
// 1-10 (up to 213 UTF-8 bytes), best-of-eight mask selection. Longer input
// throws rather than silently degrading. Loaded as a classic script that
// publishes `globalThis.nexusQr`; it never touches the DOM, so the portal can
// run without it and tests can evaluate it in isolation.
(() => {
  const MAX_VERSION = 10;
  // Level M tables for versions 1..10 (ISO/IEC 18004).
  const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const BLOCK_COUNT = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const FORMAT_BITS_M = 0;

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function reedSolomonDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < degree; j += 1) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 2);
    }
    return result;
  }

  function reedSolomonRemainder(data, degree) {
    const divisor = reedSolomonDivisor(degree);
    const result = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
    }
    return result;
  }

  function rawModuleCount(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const aligns = Math.floor(version / 7) + 2;
      result -= (25 * aligns - 10) * aligns - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewordCount(version) {
    return Math.floor(rawModuleCount(version) / 8)
      - ECC_PER_BLOCK[version - 1] * BLOCK_COUNT[version - 1];
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let position = version * 4 + 10; positions.length < count; position -= step) {
      positions.splice(1, 0, position);
    }
    return positions;
  }

  function utf8(text) {
    return [...new TextEncoder().encode(text)];
  }

  function buildDataCodewords(bytes, version) {
    const capacityBits = dataCodewordCount(version) * 8;
    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    push(0, Math.min(4, capacityBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
    }
    return codewords;
  }

  function addEccAndInterleave(data, version) {
    const blocks = BLOCK_COUNT[version - 1];
    const eccLength = ECC_PER_BLOCK[version - 1];
    const raw = Math.floor(rawModuleCount(version) / 8);
    const shortBlocks = blocks - (raw % blocks);
    const shortLength = Math.floor(raw / blocks);
    const split = [];
    for (let i = 0, offset = 0; i < blocks; i += 1) {
      const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
      const block = data.slice(offset, offset + length);
      offset += length;
      split.push({ block, ecc: reedSolomonRemainder(block, eccLength) });
    }
    const result = [];
    for (let i = 0; i < shortLength - eccLength + 1; i += 1) {
      split.forEach(({ block }) => { if (i < block.length) result.push(block[i]); });
    }
    for (let i = 0; i < eccLength; i += 1) split.forEach(({ ecc }) => result.push(ecc[i]));
    return result;
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => {
      modules[y][x] = dark;
      reserved[y][x] = true;
    };
    for (let i = 0; i < size; i += 1) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = alignmentPositions(version);
    const last = positions.length - 1;
    positions.forEach((cy, i) => positions.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }));
    drawFormat(modules, reserved, size, 0);
    if (version >= 7) {
      let remainder = version;
      for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      const bits = (version << 12) | remainder;
      for (let i = 0; i < 18; i += 1) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(a, b, dark);
        setFunction(b, a, dark);
      }
    }
    return { size, modules, reserved };
  }

  function drawFormat(modules, reserved, size, mask) {
    const data = (FORMAT_BITS_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  function placeCodewords(matrix, codewords) {
    const { size, modules, reserved } = matrix;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!reserved[y][x] && index < codewords.length * 8) {
            modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
            index += 1;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
    (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];

  function applyMask(matrix, mask) {
    const { size, modules, reserved } = matrix;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules) {
    const size = modules.length;
    const lines = [];
    for (let i = 0; i < size; i += 1) {
      lines.push(modules[i].map((dark) => (dark ? "1" : "0")).join(""));
      lines.push(modules.map((row) => (row[i] ? "1" : "0")).join(""));
    }
    let score = 0;
    for (const line of lines) {
      for (const run of line.match(/0+|1+/g)) if (run.length >= 5) score += 3 + run.length - 5;
      score += 40 * ((line.match(/(?=10111010000|00001011101)/g) ?? []).length);
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) score += 3;
      }
    }
    const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
    return score;
  }

  function encode(text) {
    if (typeof text !== "string" || text.length === 0) throw new TypeError("QR text must be a non-empty string");
    const bytes = utf8(text);
    let version = 1;
    while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewordCount(version) * 8) {
      version += 1;
    }
    if (version > MAX_VERSION) throw new RangeError("QR text is too long for this generator");
    const matrix = createMatrix(version);
    placeCodewords(matrix, addEccAndInterleave(buildDataCodewords(bytes, version), version));
    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(matrix, mask);
      drawFormat(matrix.modules, matrix.reserved, matrix.size, mask);
      const score = penalty(matrix.modules);
      if (best === null || score < best.score) {
        best = { score, mask, modules: matrix.modules.map((row) => [...row]) };
      }
      applyMask(matrix, mask);
    }
    return { version, mask: best.mask, size: matrix.size, modules: best.modules };
  }

  function toSvg(text, { quietZone = 4 } = {}) {
    const { size, modules } = encode(text);
    const total = size + quietZone * 2;
    let path = "";
    modules.forEach((row, y) => {
      for (let x = 0; x < size; x += 1) {
        if (!row[x]) continue;
        let end = x;
        while (end + 1 < size && row[end + 1]) end += 1;
        path += `M${x + quietZone} ${y + quietZone}h${end - x + 1}v1h-${end - x + 1}z`;
        x = end;
      }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
      + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  function toDataUrl(text) {
    return `data:image/svg+xml,${encodeURIComponent(toSvg(text))}`;
  }

  globalThis.nexusQr = Object.freeze({ encode, toSvg, toDataUrl, reedSolomonRemainder });
})();

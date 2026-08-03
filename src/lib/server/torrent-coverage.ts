const seasonRangePatterns = [
  /\bS(?:eason)?[ ._-]*0?(\d{1,2})\s*(?:-|to|through|thru)\s*S?(?:eason)?[ ._-]*0?(\d{1,2})\b/gi,
  /\bSeasons?[ ._-]*0?(\d{1,2})\s*(?:-|to|through|thru)\s*0?(\d{1,2})\b/gi,
];

const seasonPatterns = [
  /\bS0?(\d{1,2})(?=E\d{1,3}\b|\b|[ ._-])/gi,
  /\bSeasons?[ ._-]*0?(\d{1,2})\b/gi,
];

function addSeason(seasons: Set<number>, value: number) {
  if (Number.isInteger(value) && value >= 0 && value <= 99) seasons.add(value);
}

export function seasonNumbersFromManifest(payloadName: string, files: string[]) {
  const seasons = new Set<number>();
  const inputs = [payloadName, ...files].filter(Boolean);
  for (const input of inputs) {
    for (const pattern of seasonRangePatterns) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > 30) continue;
        for (let season = start; season <= end; season += 1) addSeason(seasons, season);
      }
    }
    for (const pattern of seasonPatterns) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) addSeason(seasons, Number(match[1]));
    }
  }
  return [...seasons].sort((left, right) => left - right);
}

export function coversSeasons(actual: number[], required: number[]) {
  if (!required.length) return true;
  const available = new Set(actual);
  return required.every((season) => available.has(season));
}

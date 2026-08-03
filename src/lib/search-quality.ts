export type QualityPresetId = "balanced" | "compatibility" | "compact" | "maximum" | "custom";

export type SearchQualityProfile = {
  preset: QualityPresetId;
  preferredResolution: 0 | 720 | 1080 | 2160;
  minimumResolution: 0 | 480 | 720 | 1080 | 2160;
  maximumResolution: 0 | 720 | 1080 | 2160;
  hdrMode: "allow" | "avoid" | "prefer";
  codec: "any" | "h264" | "h265";
  maxSourceGiB: number;
};

export const qualityPresets: Record<Exclude<QualityPresetId, "custom">, SearchQualityProfile> = {
  balanced: {
    preset: "balanced",
    preferredResolution: 1080,
    minimumResolution: 720,
    maximumResolution: 2160,
    hdrMode: "allow",
    codec: "any",
    maxSourceGiB: 0,
  },
  compatibility: {
    preset: "compatibility",
    preferredResolution: 1080,
    minimumResolution: 720,
    maximumResolution: 1080,
    hdrMode: "avoid",
    codec: "h264",
    maxSourceGiB: 0,
  },
  compact: {
    preset: "compact",
    preferredResolution: 720,
    minimumResolution: 480,
    maximumResolution: 1080,
    hdrMode: "allow",
    codec: "h265",
    maxSourceGiB: 12,
  },
  maximum: {
    preset: "maximum",
    preferredResolution: 2160,
    minimumResolution: 1080,
    maximumResolution: 2160,
    hdrMode: "prefer",
    codec: "any",
    maxSourceGiB: 0,
  },
};

const resolutions = new Set([0, 480, 720, 1080, 2160]);

function resolution(value: unknown, fallback: number) {
  const parsed = Number(value);
  return resolutions.has(parsed) ? parsed as 0 | 480 | 720 | 1080 | 2160 : fallback;
}

export function normalizeQualityProfile(value: unknown): SearchQualityProfile {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requestedPreset = String(input.preset || "balanced") as QualityPresetId;
  const preset = requestedPreset in qualityPresets ? requestedPreset as Exclude<QualityPresetId, "custom"> : "balanced";
  const base = qualityPresets[preset];
  const minimumResolution = resolution(input.minimumResolution, base.minimumResolution) as SearchQualityProfile["minimumResolution"];
  const maximumResolution = resolution(input.maximumResolution, base.maximumResolution) as SearchQualityProfile["maximumResolution"];
  const preferredResolution = resolution(input.preferredResolution, base.preferredResolution) as SearchQualityProfile["preferredResolution"];
  const hdrMode = ["allow", "avoid", "prefer"].includes(String(input.hdrMode))
    ? String(input.hdrMode) as SearchQualityProfile["hdrMode"]
    : base.hdrMode;
  const codec = ["any", "h264", "h265"].includes(String(input.codec))
    ? String(input.codec) as SearchQualityProfile["codec"]
    : base.codec;
  const requestedMax = Number(input.maxSourceGiB);
  const maxSourceGiB = Number.isFinite(requestedMax) ? Math.min(1000, Math.max(0, requestedMax)) : base.maxSourceGiB;
  const boundedMinimum = maximumResolution && minimumResolution > maximumResolution
    ? maximumResolution as SearchQualityProfile["minimumResolution"]
    : minimumResolution;
  const customized = preferredResolution !== base.preferredResolution
    || boundedMinimum !== base.minimumResolution
    || maximumResolution !== base.maximumResolution
    || hdrMode !== base.hdrMode
    || codec !== base.codec
    || maxSourceGiB !== base.maxSourceGiB;
  return {
    preset: customized || requestedPreset === "custom" ? "custom" : preset,
    preferredResolution,
    minimumResolution: boundedMinimum,
    maximumResolution,
    hdrMode,
    codec,
    maxSourceGiB,
  };
}

export function qualitySearchTerms(profile: SearchQualityProfile) {
  const terms: string[] = [];
  if (profile.preferredResolution) terms.push(`${profile.preferredResolution}p`);
  if (profile.codec === "h264") terms.push("x264");
  if (profile.codec === "h265") terms.push("x265");
  if (profile.hdrMode === "prefer") terms.push("HDR");
  return terms.join(" ");
}

export function assessSearchQuality(
  profile: SearchQualityProfile,
  name: string,
  totalBytes: number,
) {
  const normalized = name.toLowerCase();
  const detectedResolution = Number(normalized.match(/\b(2160|1080|720|480)p\b/)?.[1] || 0);
  const hdr = /\b(?:hdr10\+?|dolby[ ._-]*vision|dovi|dv)\b/i.test(name);
  const codec = /\b(?:x265|h\.?265|hevc)\b/i.test(name)
    ? "h265"
    : /\b(?:x264|h\.?264|avc)\b/i.test(name)
      ? "h264"
      : "unknown";
  const violations: string[] = [];
  if (detectedResolution && profile.minimumResolution && detectedResolution < profile.minimumResolution) {
    violations.push(`${detectedResolution}p is below the ${profile.minimumResolution}p minimum`);
  }
  if (detectedResolution && profile.maximumResolution && detectedResolution > profile.maximumResolution) {
    violations.push(`${detectedResolution}p exceeds the ${profile.maximumResolution}p maximum`);
  }
  if (profile.hdrMode === "avoid" && hdr) violations.push("HDR is disabled by the profile");
  if (profile.codec !== "any" && codec !== "unknown" && codec !== profile.codec) {
    violations.push(`${codec.toUpperCase()} does not match the ${profile.codec.toUpperCase()} codec requirement`);
  }
  if (profile.maxSourceGiB > 0 && totalBytes > profile.maxSourceGiB * 1024 ** 3) {
    violations.push(`source exceeds ${profile.maxSourceGiB} GiB`);
  }
  let score = 0;
  if (detectedResolution && profile.preferredResolution) {
    const distance = Math.abs(Math.log2(detectedResolution / profile.preferredResolution));
    score += Math.max(-22, 24 - distance * 18);
  }
  if (profile.codec !== "any" && codec !== "unknown") score += codec === profile.codec ? 14 : -9;
  if (profile.hdrMode === "prefer") score += hdr ? 14 : 0;
  return { allowed: violations.length === 0, violations, score, detectedResolution, hdr, codec };
}

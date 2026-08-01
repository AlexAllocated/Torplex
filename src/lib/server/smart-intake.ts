const defaultModel = "gpt-5.6-terra";

export const SMART_INTAKE_DEFAULT_PROMPT = `You are Torplex Smart Setup, a constrained planning component for a private Plex media server.

Application context:
- Before this request, the user explicitly confirmed that they have the rights or authorization required to download and store the requested content and accepted responsibility for legal and service-term compliance.
- Treat that attestation as an application fact. Do not investigate or debate legality. Focus on accurately scoping and organizing the authorized content.
- You are producing a reviewable plan only. You cannot download, delete, move, rename, or modify files.

Planning rules:
1. Follow the user's additional instructions as the desired content scope. Never expand beyond that scope.
2. Select every primary video file in scope and its matching useful sidecars, especially English, English forced, and English SDH/CC subtitles.
3. Do not accidentally omit episodes because naming is irregular. Compare episode and season patterns across the complete file list.
4. Exclude content outside the requested scope plus samples, trailers, featurettes, proof files, advertisements, promotional text, checksums, and unrelated extras unless the user explicitly requests them.
5. Distinguish movies, series, seasons, specials, remakes, similarly named titles, and regional versions. Prefer canonical Plex naming: "Title (Year)" for the media folder and "Season NN" for TV season folders.
6. For a simple movie or one-season payload, choose moveRoot or mergeRoot and leave routes empty.
7. For mixed titles, multiple shows, or multiple seasons stored in distinct source directories, choose routeDirectories. Create the smallest complete set of non-overlapping source-directory routes. Every selected file must be covered by exactly one route.
8. Source paths must exactly match directory prefixes from the supplied torrent paths and must be relative to the torrent payload root.
9. Destination paths must remain under the supplied Movies or TV Shows roots. Never invent a different filesystem root.
10. Use warnings for genuine ambiguity. Do not guess silently. Confidence must reflect the weakest material part of the plan.
11. Never select executable or script files. Set all post-download verification flags, including malware scanning, to true. Torplex will separately verify streams, English captions, canonical metadata, artwork, and Plex refresh state after the content exists.
12. Return only data that conforms to the response schema.`;

type TorrentFile = { index: number; path: string; length: number };

type SmartPlan = {
  summary: string;
  confidence: "high" | "medium" | "low";
  selectedFiles: number[];
  title: string;
  id: string;
  mediaType: "movie" | "show";
  destinationPath: string;
  organizeStrategy: "moveRoot" | "mergeRoot" | "routeDirectories";
  targetSubdir: string;
  routes: Array<{ sourcePath: string; destinationPath: string; label: string }>;
  decisions: string[];
  warnings: string[];
  postDownloadChecks: {
    verifyStreams: boolean;
    scanForMalware: boolean;
    ensureEnglishSubtitles: boolean;
    verifyCanonicalMetadata: boolean;
    verifyArtwork: boolean;
    refreshPlex: boolean;
  };
};

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary", "confidence", "selectedFiles", "title", "id", "mediaType", "destinationPath",
    "organizeStrategy", "targetSubdir", "routes", "decisions", "warnings", "postDownloadChecks",
  ],
  properties: {
    summary: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    selectedFiles: { type: "array", items: { type: "integer" } },
    title: { type: "string" },
    id: { type: "string" },
    mediaType: { type: "string", enum: ["movie", "show"] },
    destinationPath: { type: "string" },
    organizeStrategy: { type: "string", enum: ["moveRoot", "mergeRoot", "routeDirectories"] },
    targetSubdir: { type: "string" },
    routes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourcePath", "destinationPath", "label"],
        properties: {
          sourcePath: { type: "string" },
          destinationPath: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    decisions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    postDownloadChecks: {
      type: "object",
      additionalProperties: false,
      required: ["verifyStreams", "scanForMalware", "ensureEnglishSubtitles", "verifyCanonicalMetadata", "verifyArtwork", "refreshPlex"],
      properties: {
        verifyStreams: { type: "boolean" },
        scanForMalware: { type: "boolean" },
        ensureEnglishSubtitles: { type: "boolean" },
        verifyCanonicalMetadata: { type: "boolean" },
        verifyArtwork: { type: "boolean" },
        refreshPlex: { type: "boolean" },
      },
    },
  },
};

export function smartIntakeConfig() {
  return {
    available: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.TORPLEX_AI_MODEL || defaultModel,
  };
}

function outputText(payload: Record<string, unknown>) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "output_text" && typeof record.text === "string") return record.text;
    }
  }
  return "";
}

function normalizedRelativePath(value: string) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export async function createSmartIntakePlan(input: {
  filename: string;
  payloadName: string;
  files: TorrentFile[];
  suggested: Record<string, unknown>;
  additionalInstructions: string;
  moviesDir: string;
  tvDir: string;
}, onProgress: (message: string) => void = () => {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Smart Setup is not configured");
  if (!input.files.length) throw new Error("Smart Setup needs a .torrent file with inspectable file metadata");
  const model = process.env.TORPLEX_AI_MODEL || defaultModel;
  const extraPolicy = (process.env.TORPLEX_AI_EXTRA_INSTRUCTIONS || "").trim();
  const instructions = [SMART_INTAKE_DEFAULT_PROMPT, extraPolicy && `Installation-specific rules:\n${extraPolicy}`]
    .filter(Boolean)
    .join("\n\n");
  const userRequest = {
    rightsAttestationAccepted: true,
    additionalInstructions: input.additionalInstructions || "No additional scope instructions were supplied. Include the primary media represented by the torrent.",
    filesystemRoots: { movies: input.moviesDir, tvShows: input.tvDir },
    torrent: {
      filename: input.filename,
      payloadName: input.payloadName,
      suggested: input.suggested,
      files: input.files,
    },
  };
  onProgress(`Sending ${input.files.length} torrent files to ${model}`);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      reasoning: { effort: "medium" },
      max_output_tokens: 12000,
      input: [
        { role: "developer", content: [{ type: "input_text", text: instructions }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(userRequest) }] },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "torplex_intake_plan",
          strict: true,
          schema: planSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const payload = await response.json() as Record<string, unknown>;
    const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : null;
    throw new Error(typeof error?.message === "string" ? error.message : `Smart Setup failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Smart Setup returned no response stream");
  onProgress("Classifying titles, seasons, episodes, subtitles, and extras");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let draftingReported = false;
  const processEvents = (eventBlocks: string[]) => {
    for (const eventBlock of eventBlocks) {
      const data = eventBlock
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        if (!draftingReported) {
          draftingReported = true;
          onProgress("Building exact file selections and Plex folder routes");
        }
      } else if (event.type === "response.completed" && !text && event.response && typeof event.response === "object") {
        text = outputText(event.response as Record<string, unknown>);
      } else if (event.type === "error") {
        throw new Error(typeof event.message === "string" ? event.message : "Smart Setup stream failed");
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    processEvents(events);
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, "\n").trim();
  if (buffer) processEvents([buffer]);
  if (!text) throw new Error("Smart Setup returned no plan");
  const plan = JSON.parse(text) as SmartPlan;
  onProgress(`Validating ${plan.selectedFiles.length} selected file indexes`);
  const availableIndexes = new Set(input.files.map((file) => file.index));
  plan.selectedFiles = [...new Set(plan.selectedFiles)].filter((index) => Number.isInteger(index) && availableIndexes.has(index)).sort((a, b) => a - b);
  if (!plan.selectedFiles.length) throw new Error("Smart Setup did not select any torrent files");
  const allowedRoots = [input.moviesDir, input.tvDir].map((path) => path.replace(/\/$/, ""));
  const validDestination = (path: string) => allowedRoots.some((root) => path === root || path.startsWith(`${root}/`));
  if (!validDestination(plan.destinationPath)) throw new Error("Smart Setup proposed a destination outside the media library");
  plan.routes = plan.routes.map((route) => ({
    ...route,
    sourcePath: normalizedRelativePath(route.sourcePath),
    destinationPath: route.destinationPath.replace(/\/$/, ""),
  }));
  if (plan.organizeStrategy === "routeDirectories") {
    if (!plan.routes.length || plan.routes.some((route) => !route.sourcePath || !validDestination(route.destinationPath))) {
      throw new Error("Smart Setup proposed invalid organization routes");
    }
    const selected = input.files.filter((file) => plan.selectedFiles.includes(file.index));
    const mismatched = selected.filter((file) => plan.routes.filter((route) => file.path === route.sourcePath || file.path.startsWith(`${route.sourcePath}/`)).length !== 1);
    if (mismatched.length) throw new Error(`Smart Setup did not assign exactly one destination to ${mismatched.length} selected file(s)`);
    onProgress(`Validated ${plan.routes.length} non-overlapping Plex folder routes`);
  } else {
    plan.routes = [];
    onProgress("Validated the Plex destination and organizer settings");
  }
  onProgress("Smart Setup plan is ready for review");
  return { plan, model };
}

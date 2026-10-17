export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Responses-format models must be declared explicitly; every other free model
    // (glm-5.3-flash-free, nemotron-*, longcat, deepseek, mimo, beam, space-bunny,
    // big-pickle) streams through /inference/v1/chat/completions via passthroughModels.
    // Live-verified via GET /inference/v1/models + inference probes on 2026-10-17:
    // - muse-spark-1.2-contributor-free: ABSENT from the /models listing but the
    //   inference endpoint still serves it (dashboard ping 200) — keep declared.
    // - muse-spark-1.3-contributor-free: upstream 410 ModelDeprecated — keep out.
    // - union-alpha: removed from the free tier — keep out.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/inference/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/latest/2.0.29/cli",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};

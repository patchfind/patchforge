export const config = {
  httpPort: Number(process.env.PORT || 3000),
  wsPort: Number(process.env.WS_PORT || 3001),

  trueforge: {
    // The TrueForge server serves BOTH the API and the admin UI on one port
    // (container 8790). In-compose that is http://trueforge:8790; hosted
    // separately it is whatever host port you mapped (their compose uses 8791).
    baseUrl: process.env.TRUEFOUNDRY_BASE_URL || 'http://trueforge:8790',
    // Optional. TrueForge only enforces identity when OIDC_ISSUER_URL and
    // friends are configured; with OIDC unset it serves anonymous sessions, so
    // a local/standalone deployment needs no token at all.
    apiKey: process.env.TRUEFOUNDRY_API_KEY || undefined,
  },

  // Registry identifiers configured in Plane 1 (see config/harness-bindings.yaml).
  // FQN is `<provider>/<model>`, and for well-known providers the provider name
  // IS its type — so Gemini registered via the `google-gemini` provider is
  // `google-gemini/gemini-2.5-flash`. Verified against GET /api/v1/models.
  model: process.env.TRUEFORGE_MODEL || 'google-gemini/gemini-3-6-flash',
  // GitHub's official remote MCP server, which ships in TrueForge's connector
  // catalog as `github` (https://api.githubcopilot.com/mcp/). No self-hosted
  // gateway to run: register it once in Settings > Connectors with a PAT.
  // Read-only, for rebuilding diffs. Writes go through the MCP connector.
  githubToken: process.env.GITHUB_TOKEN || '',

  mcpServerName: process.env.TRUEFORGE_MCP_SERVER || 'github',

  // Optional. When set, sessions reference a REUSABLE agent saved in the
  // TrueForge Agents Library instead of sending an inline spec.
  //
  // Trade-off worth knowing: a saved agent carries a fixed skill list, so the
  // model must pick the right migration guide from their descriptions. The
  // inline path scopes the session to exactly the one skill the CVE needs,
  // which is more deterministic. Inline stays the default for that reason;
  // the saved agent exists so the same behaviour is drivable from the
  // TrueForge chat UI.
  savedAgentName: process.env.TRUEFORGE_AGENT_NAME || undefined,

  // Name the reusable agent is published under, and whether to publish it at
  // boot. Publishing is independent of USING it: the worker keeps its inline
  // per-task spec unless TRUEFORGE_AGENT_NAME is also set.
  savedAgentDefinitionName:
    process.env.TRUEFORGE_AGENT_DEFINITION_NAME || 'patchforge-orchestrator',
  registerAgentOnBoot: process.env.REGISTER_AGENT_ON_BOOT !== 'false',

  // The tool that must never fire without a human decision.
  approvalGateTool: 'create_pull_request',

  compactionThresholdTokens: Number(process.env.COMPACTION_THRESHOLD || 50000),
  iterationLimit: Number(process.env.ITERATION_LIMIT || 60),

  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',
  rabbitUrl: process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672',
  queue: 'tasks.patching',
  poolMonitorUrl: process.env.POOL_MONITOR_URL || 'http://pool-monitor:8080',

  // How long a paused session waits for a human before it is abandoned.
  approvalTtlSeconds: Number(process.env.APPROVAL_TTL || 86400),
  // Concurrent patching sessions.
  prefetch: Number(process.env.AMQP_PREFETCH || 2),
};

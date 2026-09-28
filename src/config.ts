export type SinkAuthMode = "header" | "basic" | "bearer" | "none";
export type LlmProvider = "openai" | "anthropic" | "template";

export interface Config {
  env: string;
  port: number;
  publicBaseUrl: string;
  storeTz: string;
  logLevel: string;
  cox: {
    lm: { baseUrl: string; apiKey: string; apiKeyHeader: string; tokenUrl: string; clientId: string; clientSecret: string; userId?: string };
    defaultRepId?: string;
    storeName: string;
    events: { baseUrl: string; apiKey: string; accept: string; tokenUrl: string; clientId: string; clientSecret: string; scope: string };
    sandboxDealerId?: string;
    sink: {
      mode: SinkAuthMode;
      headerName: string;
      secret?: string;
      basicUser?: string;
      basicPass?: string;
      allowedIps: string[];
    };
  };
  twilio: { accountSid?: string; authToken?: string; defaultFrom?: string };
  postmark: { serverToken?: string; fromDomain: string; messageStream: string; inboundSecret?: string };
  llm: { provider: LlmProvider; openaiKey?: string; openaiModel: string; anthropicKey?: string; anthropicModel: string };
  setupAdminToken?: string;
}

const str = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const opt = (k: string): string | undefined => (str(k) === "" ? undefined : str(k));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prev = process.env;
  if (env !== process.env) (process as any).env = env;
  try {
    const mode = (str("COX_SINK_AUTH_MODE", "header") as SinkAuthMode);
    const nodeEnv = str("NODE_ENV", "development");
    if (!["header", "basic", "bearer", "none"].includes(mode)) throw new Error(`COX_SINK_AUTH_MODE invalid: ${mode}`);
    if (nodeEnv === "production" && mode === "none") throw new Error("COX_SINK_AUTH_MODE=none is not allowed in production");

    let provider = str("LLM_PROVIDER", "openai") as LlmProvider;
    if (provider === "openai" && !opt("OPENAI_API_KEY")) provider = "template";
    if (provider === "anthropic" && !opt("ANTHROPIC_API_KEY")) provider = "template";

    return {
      env: nodeEnv,
      port: Number(str("PORT", "8080")),
      publicBaseUrl: str("PUBLIC_BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
      storeTz: str("STORE_TZ", "America/Los_Angeles"),
      logLevel: str("LOG_LEVEL", "info"),
      cox: {
        lm: {
          baseUrl: str("COX_LM_BASE_URL", "https://sandbox.api.vinsolutions.com").replace(/\/$/, ""),
          apiKey: str("COX_LM_API_KEY"),
          // Sandbox gateway rejects x-api-key for Lead Management; it wants api_key. Confirmed 2026-09-27.
          apiKeyHeader: str("COX_LM_API_KEY_HEADER", "api_key"),
          // Lead Management needs the same OAuth bearer as the event service. Fall back to those creds.
          tokenUrl: str("COX_LM_TOKEN_URL") || str("COX_EVENTS_TOKEN_URL", "https://authentication.vinsolutions.com/connect/token"),
          clientId: str("COX_LM_CLIENT_ID") || str("COX_EVENTS_CLIENT_ID"),
          clientSecret: str("COX_LM_CLIENT_SECRET") || str("COX_EVENTS_CLIENT_SECRET"),
          userId: opt("COX_LM_USER_ID"),
        },
        defaultRepId: opt("COX_DEFAULT_REP_ID"),
        storeName: str("STORE_NAME", "the dealership"),
        events: {
          baseUrl: str("COX_EVENTS_BASE_URL", "https://sandbox.api.coxautoinc.com/vinsolutions/eventingapi").replace(/\/$/, ""),
          apiKey: str("COX_EVENTS_API_KEY"),
          accept: str("COX_EVENTS_ACCEPT", "application/vnd.coxauto.v1+json"),
          tokenUrl: str("COX_EVENTS_TOKEN_URL", "https://authentication.vinsolutions.com/connect/token"),
          clientId: str("COX_EVENTS_CLIENT_ID"),
          clientSecret: str("COX_EVENTS_CLIENT_SECRET"),
          scope: str("COX_EVENTS_SCOPE", "PublicAPI"),
        },
        sandboxDealerId: opt("COX_SANDBOX_DEALER_ID"),
        sink: {
          mode,
          headerName: str("COX_SINK_HEADER_NAME", "x-ricochet-sink-key").toLowerCase(),
          secret: opt("COX_SINK_SECRET"),
          basicUser: opt("COX_SINK_BASIC_USER"),
          basicPass: opt("COX_SINK_BASIC_PASS"),
          allowedIps: str("COX_SINK_ALLOWED_IPS").split(",").map((s) => s.trim()).filter(Boolean),
        },
      },
      twilio: { accountSid: opt("TWILIO_ACCOUNT_SID"), authToken: opt("TWILIO_AUTH_TOKEN"), defaultFrom: opt("TWILIO_DEFAULT_FROM") },
      postmark: {
        serverToken: opt("POSTMARK_SERVER_TOKEN"),
        fromDomain: str("POSTMARK_FROM_DOMAIN", "mail.getricochet.live"),
        messageStream: str("POSTMARK_MESSAGE_STREAM", "outbound"),
        inboundSecret: opt("POSTMARK_INBOUND_SECRET"),
      },
      llm: {
        provider,
        openaiKey: opt("OPENAI_API_KEY"),
        openaiModel: str("OPENAI_MODEL", "gpt-5-mini"),
        anthropicKey: opt("ANTHROPIC_API_KEY"),
        anthropicModel: str("ANTHROPIC_MODEL", "claude-opus-5"),
      },
      setupAdminToken: opt("SETUP_ADMIN_TOKEN"),
    };
  } finally {
    if (env !== process.env) (process as any).env = prev;
  }
}

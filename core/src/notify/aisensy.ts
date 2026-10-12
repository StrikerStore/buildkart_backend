/**
 * AiSensy's Project API, over REST. No SDK: sending a template, submitting one
 * for approval and reading its verdict are the only calls this shop makes.
 *
 * Auth is one header, `X-AiSensy-Project-API-Pwd`, carrying the password of a
 * Custom App created in the AiSensy dashboard. The same app's shared secret
 * signs the webhooks that report delivery.
 *
 * Spec: https://aisensy.stoplight.io/docs/project-api
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_API = 'https://apis.aisensy.com/project-apis/v1';

/** A send must never hang the request that triggered it for long. */
const TIMEOUT_MS = 10_000;

export type AisensyConfig = {
  projectId: string;
  /** The Custom App password. */
  password: string;
};

/**
 * AiSensy answered, but not with what was asked for.
 *
 * `transient` is what the retry job reads: a timeout or a 5xx is worth trying
 * again, a 4xx (bad template name, bad number) will fail the same way forever.
 */
export class AisensyError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.transient = status === undefined || status >= 500 || status === 429;
  }
}

function apiBase(): string {
  return (process.env.AISENSY_API_BASE?.trim() || DEFAULT_API).replace(/\/+$/, '');
}

async function call<T>(
  config: AisensyConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${apiBase()}/project/${encodeURIComponent(config.projectId)}${path}`, {
      method,
      headers: {
        'X-AiSensy-Project-API-Pwd': config.password,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new AisensyError(
      controller.signal.aborted ? 'AiSensy timed out.' : 'AiSensy could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Left as text; the error branch below quotes it.
  }

  if (!response.ok) {
    // Errors come back as `{ name: "ERR400", message: "Template name already exists!" }`.
    const message =
      (parsed as { message?: string })?.message ??
      (parsed as { error?: { message?: string } })?.error?.message ??
      (typeof parsed === 'string' && parsed ? parsed.slice(0, 200) : `HTTP ${response.status}`);
    throw new AisensyError(String(message).slice(0, 400), response.status);
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type TemplateMessage = {
  /** Country code and number, digits only: `919826012345`. */
  to: string;
  /** The approved template's name. */
  name: string;
  /** `en`, `hi` — the template's language code. */
  languageCode: string;
  bodyParams: string[];
  /**
   * Parameters for a URL button, or the code for an authentication template's
   * copy-code button. Index 0 is the first button.
   */
  buttonParams?: { index: number; text: string }[];
};

/** Sends one approved template. Returns WhatsApp's `wamid.…` for the message. */
export async function sendAisensyTemplate(
  config: AisensyConfig,
  message: TemplateMessage,
): Promise<string> {
  const components: unknown[] = [];
  if (message.bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: message.bodyParams.map((text) => ({ type: 'text', text })),
    });
  }
  for (const button of message.buttonParams ?? []) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(button.index),
      parameters: [{ type: 'text', text: button.text }],
    });
  }

  const result = await call<{ messages?: { id?: string }[] }>(config, 'POST', '/messages', {
    to: message.to,
    type: 'template',
    template: {
      name: message.name,
      language: { policy: 'deterministic', code: message.languageCode },
      components,
    },
  });

  const id = result.messages?.[0]?.id;
  if (!id) throw new AisensyError('AiSensy accepted the message but returned no message id.');
  return id;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type AisensyTemplate = {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  rejected_reason?: string;
};

export type TemplateSubmission = {
  /** Lowercase, digits and underscores: Meta's rule for template names. */
  name: string;
  label: string;
  /** Meta's names; `TRANSACTIONAL` is the older name AiSensy's schema still lists. */
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION' | 'TRANSACTIONAL';
  /** AiSensy wants the language's name, not its code: "English", "Hindi". */
  language: string;
  /** Positional body: `Order {{1}} is placed.` */
  text: string;
  /** The same body with sample values, for Meta's reviewer. */
  sampleText: string;
  footerText?: string;
};

/**
 * Submits a template for Meta's approval. The verdict arrives later; read it
 * back with `getAisensyTemplate`.
 */
export async function submitAisensyTemplate(
  config: AisensyConfig,
  template: TemplateSubmission,
): Promise<AisensyTemplate> {
  return call<AisensyTemplate>(config, 'POST', '/wa_template', {
    name: template.name,
    label: template.label,
    category: template.category,
    type: 'TEXT',
    language: template.language,
    text: template.text,
    sample_text: template.sampleText,
    ...(template.footerText ? { footer_text: template.footerText } : {}),
  });
}

export async function getAisensyTemplate(
  config: AisensyConfig,
  templateId: string,
): Promise<AisensyTemplate> {
  return call<AisensyTemplate>(config, 'GET', `/wa_template/${encodeURIComponent(templateId)}`);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function hexHmacMatches(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `X-AiSensy-Signature`: hex HMAC-SHA256 of the request body under the Custom
 * App's shared secret.
 *
 * The prose of AiSensy's docs says the raw body; their own Node sample signs
 * `JSON.stringify` of the parsed body. Those differ whenever the sender's
 * serialiser spaces or escapes differently, so both are accepted — each is
 * still a full HMAC under our secret, so neither is weaker than the other.
 */
export function verifyAisensySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  if (hexHmacMatches(rawBody, secret, signature)) return true;
  try {
    return hexHmacMatches(JSON.stringify(JSON.parse(rawBody)), secret, signature);
  } catch {
    return false;
  }
}

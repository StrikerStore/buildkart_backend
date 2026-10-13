/**
 * AiSensy's Campaign API: one endpoint, one call per message.
 *
 * Each message the shop sends is an **API campaign** created by hand in the
 * AiSensy dashboard, set Live, and bound to one approved WhatsApp template.
 * This client names the campaign and supplies the template's parameters, in
 * order; the wording lives in AiSensy.
 *
 * Auth is the account's API key, sent **in the body** (AiSensy → Manage → API
 * Key). There is no header, no message id in the answer, and no webhook:
 * delivery and read receipts are only visible in the AiSensy dashboard.
 *
 * Docs: https://wiki.aisensy.com/en/articles/11501889-api-reference-docs
 */

const DEFAULT_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

/** A send must never hang the request that triggered it for long. */
const TIMEOUT_MS = 10_000;

/**
 * AiSensy answered, but not with a yes.
 *
 * `transient` is what the retry job reads: a timeout, a 5xx or a 429 is worth
 * trying again; a 4xx — a campaign that is not Live, the wrong number of
 * parameters — will fail the same way every time.
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

/** A URL or copy-code button parameter. Index 0 is the template's first button. */
export type CampaignButton = { index: number; text: string };

export type CampaignMessage = {
  /** The Live API campaign's name, exactly as AiSensy shows it. */
  campaignName: string;
  /** Country code and number, digits only: `919826012345`. */
  destination: string;
  /** Required by AiSensy; it names the contact it creates or updates. */
  userName: string;
  /** Must be exactly as many as the template has, or AiSensy rejects the call. */
  templateParams: string[];
  buttons?: CampaignButton[];
};

function campaignUrl(): string {
  return process.env.AISENSY_CAMPAIGN_URL?.trim() || DEFAULT_URL;
}

/** The request body, separate from the call so its exact shape can be tested. */
export function campaignBody(apiKey: string, message: CampaignMessage): Record<string, unknown> {
  return {
    apiKey,
    campaignName: message.campaignName,
    destination: message.destination,
    userName: message.userName,
    source: 'BuildKart',
    templateParams: message.templateParams,
    // The shape of AiSensy's own authentication-template example: the code
    // fills the body parameter and the button's URL parameter alike.
    ...(message.buttons?.length
      ? {
          buttons: message.buttons.map((button) => ({
            type: 'button',
            sub_type: 'url',
            index: String(button.index),
            parameters: [{ type: 'text', text: button.text }],
          })),
        }
      : {}),
  };
}

/** Triggers one API campaign for one number. Resolves when AiSensy accepts it. */
export async function sendAisensyCampaign(apiKey: string, message: CampaignMessage): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(campaignUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(campaignBody(apiKey, message)),
      signal: controller.signal,
    });
  } catch {
    throw new AisensyError(
      controller.signal.aborted ? 'AiSensy timed out.' : 'AiSensy could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return;

  const text = await response.text().catch(() => '');
  let reason = text.slice(0, 200) || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const candidate = parsed.message ?? parsed.errorMessage ?? parsed.error ?? parsed.msg;
    if (typeof candidate === 'string' && candidate) reason = candidate;
  } catch {
    // Not JSON; the raw text stands.
  }
  throw new AisensyError(reason.slice(0, 400), response.status);
}

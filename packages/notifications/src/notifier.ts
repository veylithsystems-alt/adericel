import { AdericelError, type Logger } from '@adericel/shared';

/**
 * Outbound notification.
 *
 * Onboarding is where this matters most: a verification link that is silently
 * dropped is a customer who never arrives, and there is nothing in the product
 * to tell anybody it happened. So delivery is explicit about its outcome, the
 * unconfigured case is a refusal rather than a no-op, and production start-up
 * checks that a real channel exists before accepting a single signup.
 */

export interface NotificationMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Every message must be readable without HTML. */
  readonly text: string;
  readonly html?: string;
  /**
   * What this message is for. Carried into logs and delivery metadata so an
   * operator can answer "did the verification emails go out this morning?"
   * without reading message bodies.
   */
  readonly kind: string;
  readonly correlationId?: string;
}

export interface DeliveryResult {
  readonly delivered: boolean;
  readonly channel: string;
  readonly reference: string | null;
  readonly detail: string;
}

export interface Notifier {
  readonly channel: string;
  /** True when this notifier can actually reach a person. */
  readonly deliversToPeople: boolean;
  send(message: NotificationMessage): Promise<DeliveryResult>;
}

/**
 * Development and test channel.
 *
 * Writes the message to the log, including any link it carries, so a developer
 * can complete a signup without an email provider. `deliversToPeople` is false,
 * which is what production start-up checks: this must never be the channel a
 * real customer's verification link goes to.
 */
export function createLogNotifier(logger: Logger): Notifier {
  return {
    channel: 'log',
    deliversToPeople: false,
    async send(message): Promise<DeliveryResult> {
      logger.info(
        {
          to: message.to,
          subject: message.subject,
          kind: message.kind,
          correlationId: message.correlationId,
          body: message.text,
        },
        'notification (log channel — not delivered to a person)',
      );
      return {
        delivered: true,
        channel: 'log',
        reference: null,
        detail: 'Written to the application log. No message was sent.',
      };
    },
  };
}

/** Captures messages in memory. For tests that assert on what was sent. */
export interface RecordingNotifier extends Notifier {
  readonly sent: readonly NotificationMessage[];
  clear(): void;
  /** The most recent message to an address, or null. */
  lastTo(email: string): NotificationMessage | null;
}

export function createRecordingNotifier(): RecordingNotifier {
  const sent: NotificationMessage[] = [];
  return {
    channel: 'recording',
    deliversToPeople: false,
    sent,
    clear(): void {
      sent.length = 0;
    },
    lastTo(email: string): NotificationMessage | null {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]!.to.toLowerCase() === email.toLowerCase()) return sent[i]!;
      }
      return null;
    },
    async send(message): Promise<DeliveryResult> {
      sent.push(message);
      return { delivered: true, channel: 'recording', reference: null, detail: 'Recorded' };
    },
  };
}

export interface HttpEmailOptions {
  /** Transactional email API endpoint, e.g. a Postmark or SendGrid send URL. */
  readonly endpoint: string;
  /** Header carrying the API credential, e.g. 'X-Postmark-Server-Token'. */
  readonly authHeader: string;
  readonly authToken: string;
  readonly fromAddress: string;
  readonly fromName: string;
  /**
   * Maps a message onto the provider's request body. Providers disagree about
   * field names and nothing is gained by pretending otherwise, so the shape is
   * configuration rather than a guess.
   */
  readonly body: (message: NotificationMessage, from: { address: string; name: string }) => unknown;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Transactional email over a provider's HTTP API.
 *
 * HTTP rather than SMTP deliberately: it needs no long-lived connection, no
 * extra dependency, and it reports a per-message reference that can be
 * correlated with the provider's own delivery record when a customer says they
 * never received anything.
 */
export function createHttpEmailNotifier(options: HttpEmailOptions): Notifier {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    channel: 'http-email',
    deliversToPeople: true,
    async send(message): Promise<DeliveryResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await doFetch(options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            [options.authHeader]: options.authToken,
          },
          body: JSON.stringify(
            options.body(message, { address: options.fromAddress, name: options.fromName }),
          ),
          signal: controller.signal,
        });

        const text = await response.text();
        if (!response.ok) {
          // Returned rather than thrown: the caller decides whether an
          // undelivered notification is fatal to the operation that produced
          // it, and for most operations it is not.
          return {
            delivered: false,
            channel: 'http-email',
            reference: null,
            detail: `Provider rejected the message: ${response.status} ${text.slice(0, 300)}`,
          };
        }
        let reference: string | null = null;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const candidate = parsed.MessageID ?? parsed.messageId ?? parsed.id;
          reference = typeof candidate === 'string' ? candidate : null;
        } catch {
          reference = null;
        }
        return {
          delivered: true,
          channel: 'http-email',
          reference,
          detail: 'Accepted by the provider',
        };
      } catch (error) {
        return {
          delivered: false,
          channel: 'http-email',
          reference: null,
          detail: `Delivery failed: ${(error as Error).message}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * Refuse to run in production without a channel that reaches people.
 *
 * A deployment that accepts signups and writes their verification links to a
 * log file has not onboarded anybody; it has collected email addresses and lost
 * them. Failing at start-up is the only outcome an operator will notice.
 */
export function assertNotifierUsableInProduction(notifier: Notifier, isProduction: boolean): void {
  if (!isProduction || notifier.deliversToPeople) return;
  throw new AdericelError(
    'CONFIGURATION_INVALID',
    `Notification channel "${notifier.channel}" cannot deliver to a person, so signup ` +
      'verification and invitations would be silently lost. Configure NOTIFY_DRIVER=http-email ' +
      'with NOTIFY_HTTP_ENDPOINT, NOTIFY_HTTP_AUTH_HEADER, NOTIFY_HTTP_AUTH_TOKEN and ' +
      'NOTIFY_FROM_ADDRESS before starting in production.',
  );
}

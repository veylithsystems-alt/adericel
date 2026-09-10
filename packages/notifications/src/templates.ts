import type { NotificationMessage } from './notifier.js';

/**
 * Onboarding messages.
 *
 * These are the first words Adericel says to a customer, and they set what the
 * product will be believed to have promised. So they say what will actually
 * happen — including that the first thing they will see is a page full of
 * UNKNOWN, and why that is the correct answer rather than a broken one.
 *
 * A compliance product that opens on a green dashboard before it has looked at
 * anything has already told its first lie. Saying so up front turns the most
 * confusing moment of onboarding into the moment the product explains itself.
 */

export interface SignupVerificationContext {
  readonly to: string;
  readonly contactName: string;
  readonly organisationName: string;
  readonly accountKind: 'MSP' | 'DIRECT';
  readonly verifyUrl: string;
  readonly expiresInHours: number;
  readonly correlationId?: string;
}

export function signupVerificationMessage(ctx: SignupVerificationContext): NotificationMessage {
  const audience =
    ctx.accountKind === 'MSP'
      ? 'You will be set up as an operator account, so you can onboard the organisations you look after.'
      : `You will be set up with a single organisation, ${ctx.organisationName}.`;

  const text = [
    `Hello ${ctx.contactName},`,
    '',
    `Confirm your email address to finish setting up Adericel for ${ctx.organisationName}.`,
    '',
    ctx.verifyUrl,
    '',
    `This link works once and expires in ${ctx.expiresInHours} hours. If you did not ask for it, ` +
      'you can ignore this message — no account exists until the link is used.',
    '',
    audience,
    '',
    'What happens next:',
    '',
    '  1. You choose a password and set up a second factor.',
    '  2. You connect a source — a directory, an endpoint manager, a cloud account.',
    '  3. Adericel collects evidence and tells you what it can and cannot determine.',
    '',
    'One thing worth knowing before you see it: your first view will show almost every',
    'control as UNKNOWN. That is deliberate and it is the correct answer. Adericel has not',
    'looked at anything yet, and a product that showed you a clean result at that point',
    'would be guessing. Each control turns into a determination — satisfied or not — as',
    'evidence arrives, and every one of them will tell you what it was based on.',
    '',
    '— Adericel',
  ].join('\n');

  return {
    to: ctx.to,
    subject: `Confirm your email to set up Adericel for ${ctx.organisationName}`,
    text,
    kind: 'signup-verification',
    correlationId: ctx.correlationId,
  };
}

export interface InvitationContext {
  readonly to: string;
  readonly inviterName: string;
  readonly scopeName: string;
  readonly roles: readonly string[];
  readonly acceptUrl: string;
  readonly expiresInHours: number;
  readonly message: string | null;
  readonly correlationId?: string;
}

export function invitationMessage(ctx: InvitationContext): NotificationMessage {
  const canApprove = ctx.roles.includes('ORG_APPROVER');
  const lines = [
    `Hello,`,
    '',
    `${ctx.inviterName} has invited you to ${ctx.scopeName} on Adericel.`,
    '',
    ctx.acceptUrl,
    '',
    `This link works once and expires in ${ctx.expiresInHours} hours.`,
    '',
    `You have been invited as: ${ctx.roles.join(', ')}.`,
  ];

  if (canApprove) {
    lines.push(
      '',
      'You are being asked to be an approver. That means Adericel will not change anything',
      'in the estate without a person like you agreeing to it first — and the person who',
      'proposed a change can never be the person who approves it. You will be asked to set',
      'up a second factor, because approval is where you take responsibility for a change',
      "to someone else's production systems.",
    );
  }

  if (ctx.message) lines.push('', `They added: "${ctx.message}"`);
  lines.push('', '— Adericel');

  return {
    to: ctx.to,
    subject: `${ctx.inviterName} invited you to ${ctx.scopeName} on Adericel`,
    text: lines.join('\n'),
    kind: 'invitation',
    correlationId: ctx.correlationId,
  };
}

import type { AutonomyPolicyDefinition } from '@adericel/autonomy';

/**
 * Veylith's default autonomy policy.
 *
 * Lives here rather than in `@adericel/autonomy` because that package is the
 * engine and this is one company's answer. An engine shipping a policy named
 * after a particular company is an engine that has quietly stopped being
 * general — and the whole point of separating them is that a customer running
 * Adericel on their own infrastructure gets the mechanism without inheriting
 * Veylith's commercial judgement.
 *
 * Written as the answer to one question, asked of every operation: what is the
 * worst thing that happens if this runs unattended and is wrong?
 *
 * Where the answer is "an internal record is wrong", the operation is permitted.
 * Where it is "a customer receives something they should not have", it needs a
 * person. Where it is "money moves" or "a legal position is taken", it is
 * refused outright and no rule here can be configured to permit it.
 *
 * The fallback is UNKNOWN. An operation nobody has written a rule for is not
 * permitted by omission.
 */
export const DEFAULT_COMPANY_POLICY: AutonomyPolicyDefinition = {
  key: 'veylith.company.default',
  name: 'Veylith default autonomy policy',
  description:
    'What the company may do without a person. Restrictive by construction: rules narrow ' +
    'authority and can never widen it, and an operation no rule covers is UNKNOWN.',
  fallback: 'UNKNOWN',
  rules: [
    // ---- Internal record-keeping -------------------------------------------
    {
      id: 'internal.record-keeping',
      description:
        'Maintaining the company’s own records is unattended work. Getting it wrong ' +
        'produces a bad internal record, which is recoverable and visible.',
      operations: ['market.*', 'sales.qualification.*', 'product.feedback.*', 'engineering.ci.*'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiredApprovals: 0,
      requiredAuthority: '',
      rateLimitPerHour: 5000,
      allowedUtcHours: [],
      requiresFacts: [],
    },

    // ---- Anything that leaves the company ----------------------------------
    {
      id: 'outward.contact-requires-consent',
      description:
        'Nothing reaches a person outside the company without a lawful basis established and ' +
        'recorded. An unestablished basis yields UNKNOWN, not permission.',
      operations: ['sales.outreach.*', 'marketing.*', 'customer_ops.reporting.*'],
      riskClasses: ['OUTWARD_FACING'],
      maxUnattendedRisk: 'OUTWARD_FACING',
      minMaturity: 3,
      outcome: 'PERMIT',
      requiredApprovals: 1,
      requiredAuthority: 'Commercial owner',
      // A cap that a working system never approaches, and a malfunctioning one
      // hits within the hour instead of by the end of the week.
      rateLimitPerHour: 120,
      allowedUtcHours: [],
      requiresFacts: ['lawful_basis_recorded', 'not_suppressed', 'content_approved'],
    },
    {
      id: 'outward.preparation-is-internal',
      description:
        'Drafting a message is internal work and must not need a person. Sending it is a ' +
        'separate, separately gated operation, so a bug anywhere in the preparation path can ' +
        'at worst produce a draft nobody sent.',
      operations: [
        'sales.outreach.prepare',
        'sales.proposal.draft',
        'marketing.draft',
        'customer_ops.reporting.prepare',
        'legal.contract.prepare',
      ],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiredApprovals: 0,
      requiredAuthority: '',
      rateLimitPerHour: 1000,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'outward.first-contact-wording',
      description:
        'First contact wording is a reputational decision. The system may draft it; a person ' +
        'signs it off once per template, not once per send.',
      operations: ['sales.outreach.first_contact'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'REQUIRE_APPROVAL',
      requiredApprovals: 1,
      requiredAuthority: 'Commercial owner',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },

    // ---- Customer operations ----------------------------------------------
    {
      id: 'customer.onboarding',
      description:
        'Preparing a tenant, seeding controls and running collection are the productised parts ' +
        'of onboarding and must not need a person.',
      operations: ['onboarding.tenant.*', 'customer_ops.health.*', 'support.triage.*'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiredApprovals: 0,
      requiredAuthority: '',
      rateLimitPerHour: 1000,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'customer.environment-access',
      description:
        'Reaching into a customer environment requires their recorded consent for that ' +
        'specific access. Consent to onboarding is not consent to change anything.',
      operations: ['onboarding.integrations.*', 'support.resolution.*'],
      riskClasses: [],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 3,
      outcome: 'PERMIT',
      requiredApprovals: 1,
      requiredAuthority: 'Customer administrator',
      rateLimitPerHour: 200,
      allowedUtcHours: [],
      requiresFacts: ['customer_consent_recorded', 'within_contracted_scope'],
    },

    // ---- Money -------------------------------------------------------------
    {
      id: 'billing.routine',
      description:
        'Issuing an invoice against an agreed subscription is bookkeeping. Deciding what a ' +
        'customer owes is not, and is not covered here.',
      operations: ['billing.subscription.invoice', 'billing.subscription.record_payment'],
      riskClasses: ['INTERNAL', 'FINANCIAL'],
      maxUnattendedRisk: 'FINANCIAL',
      minMaturity: 3,
      outcome: 'PERMIT',
      requiredApprovals: 1,
      requiredAuthority: 'Finance owner',
      rateLimitPerHour: 500,
      allowedUtcHours: [],
      requiresFacts: ['subscription_active', 'amount_matches_agreement'],
    },
    {
      id: 'billing.suspension',
      description:
        'Suspending a paying customer is disproportionate to the most common billing event ' +
        'there is, an expired card. A person decides.',
      operations: ['billing.dunning.suspend', 'billing.dunning.write_off'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'REQUIRE_APPROVAL',
      requiredApprovals: 1,
      requiredAuthority: 'Finance owner',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'finance.no-banking-authority',
      description:
        'No autonomous system holds banking authority. Not at any maturity, not with any ' +
        'approval count, not under any configuration. This rule exists to be unremovable.',
      operations: ['finance.payments.*', 'finance.*'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'DENY',
      requiredApprovals: 0,
      requiredAuthority: 'A director, outside this system',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },

    // ---- Legal -------------------------------------------------------------
    {
      id: 'legal.no-liability-acceptance',
      description:
        'The system prepares and routes contracts. It does not accept liability, vary terms, ' +
        'or exercise legal judgement.',
      operations: ['legal.*'],
      riskClasses: ['CONTRACTUAL', 'IRREVERSIBLE'],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'DENY',
      requiredApprovals: 0,
      requiredAuthority: 'A director, with legal advice',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'legal.administrative',
      description: 'Generating a standard contract from an approved template, and tracking it.',
      operations: ['legal.contract.generate', 'legal.contract.track'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiredApprovals: 1,
      requiredAuthority: 'Commercial owner',
      rateLimitPerHour: 100,
      allowedUtcHours: [],
      requiresFacts: ['template_is_approved_standard', 'no_terms_varied'],
    },

    // ---- Security and engineering ------------------------------------------
    {
      id: 'security.detect-and-classify',
      description: 'Detecting and classifying a security event must never wait for a person.',
      operations: ['security.monitoring.*'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiredApprovals: 0,
      requiredAuthority: '',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'security.containment',
      description:
        'Containment has customer impact and is frequently irreversible. Escalate rather than ' +
        'ask for approval: the right response is a person taking charge, not a rubber stamp.',
      operations: ['security.response.*'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'ESCALATE',
      requiredApprovals: 0,
      requiredAuthority: 'Security owner, immediately',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'engineering.low-risk',
      description: 'Dependency updates and build remediation that touch no authority path.',
      operations: ['engineering.dependencies.patch', 'engineering.ci.*'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 3,
      outcome: 'PERMIT',
      requiredApprovals: 0,
      requiredAuthority: '',
      rateLimitPerHour: 50,
      allowedUtcHours: [],
      requiresFacts: ['tests_pass', 'not_authority_path'],
    },
    {
      id: 'engineering.production',
      description: 'Production deployment authority stays with a person.',
      operations: ['engineering.deployment.*'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'REQUIRE_APPROVAL',
      requiredApprovals: 1,
      requiredAuthority: 'Engineering owner',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },

    // ---- The backstop ------------------------------------------------------
    {
      id: 'global.irreversible',
      description:
        'Nothing irreversible happens unattended, whatever else permits it. Because rules ' +
        'combine to the most restrictive result, this cannot be overridden by adding a rule.',
      operations: ['*'],
      riskClasses: ['IRREVERSIBLE'],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'REQUIRE_APPROVAL',
      requiredApprovals: 1,
      requiredAuthority: 'The owner of the affected process',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
    {
      id: 'global.strategy',
      description: 'The system does not decide what the company does.',
      operations: ['strategy.*'],
      riskClasses: [],
      maxUnattendedRisk: null,
      minMaturity: 0,
      outcome: 'DENY',
      requiredApprovals: 0,
      requiredAuthority: 'A director',
      rateLimitPerHour: null,
      allowedUtcHours: [],
      requiresFacts: [],
    },
  ],
};

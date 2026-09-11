# ADR-0001: Assurance Graph as Canonical Domain Model

**Status:** Accepted

**Date:** 2026-09-09

---

## Context

Adericel must maintain an authoritative, continuously updated model of organisational security state. Traditional compliance systems fragment assurance across spreadsheets, documents, tools, and point-in-time audits.

The company's core intellectual property is the ability to:

- Know what exists
- Determine what is true
- Prove what can be proven
- Identify what is wrong
- Act where authorised
- Verify results
- Maintain historical state

This requires a unified domain model that connects observations to assurance through evidence.

---

## Problem

Without a canonical domain model, Adericel becomes:

- A collection of integrations without coherent truth
- Unable to distinguish observation from inference from proof
- Unable to maintain evidence provenance
- Unable to trace assurance back to its sources
- Unable to scale to multiple frameworks
- Unable to support autonomous action with safety

---

## Decision

**Adopt the Organisational Assurance Graph as the canonical, persistent domain model.**

The graph represents:

### Core Entities (Nodes)

| Entity           | Purpose                                                             | Cardinality                          |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------ |
| **Organisation** | Customer tenant boundary                                            | One per customer                     |
| **Person**       | Human identity holder                                               | Multiple per org                     |
| **Identity**     | Authenticatable credential (Entra ID user, service principal, etc.) | Multiple per person                  |
| **Device**       | Managed endpoint                                                    | Multiple per org                     |
| **Application**  | Software service                                                    | Multiple per org                     |
| **Service**      | Cloud/infrastructure service                                        | Multiple per org                     |
| **Data**         | Information asset                                                   | Multiple per org                     |
| **Supplier**     | External organisation                                               | Multiple per org                     |
| **Observation**  | Raw fact collected from a source system                             | Multiple (continuous)                |
| **Evidence**     | Normalised, validated observation                                   | Multiple                             |
| **Finding**      | Assessment that a control is not met                                | Multiple (temporal)                  |
| **Control**      | Security control                                                    | Multiple per framework               |
| **Requirement**  | Security requirement                                                | Multiple per framework               |
| **Framework**    | Compliance/assurance framework (Cyber Essentials, ISO 27001, etc.)  | Multiple per org                     |
| **Policy**       | Organisational decision rule for autonomous action                  | Multiple per org                     |
| **Action**       | Remediation or configuration change                                 | Multiple (temporal)                  |
| **Verification** | Proof that an action was successful                                 | Multiple (temporal, 1:N with Action) |
| **Assurance**    | Current state of a requirement/control/framework                    | Multiple (temporal)                  |

### Relationships (Edges)

| Relationship      | From         | To                               | Purpose                                   |
| ----------------- | ------------ | -------------------------------- | ----------------------------------------- |
| **owns**          | Organisation | Person/Device/Application/Data   | Asset ownership                           |
| **authenticates** | Person       | Identity                         | Identity binding                          |
| **uses**          | Identity     | Device/Application               | Usage relationship                        |
| **runs_on**       | Application  | Device/Service                   | Deployment                                |
| **processes**     | Application  | Data                             | Data processing                           |
| **protects**      | Control      | Data/Device/Identity/Application | Control scope                             |
| **satisfies**     | Control      | Requirement                      | Requirement coverage                      |
| **implements**    | Requirement  | Framework                        | Framework requirement                     |
| **observes**      | Observation  | Entity                           | What was observed                         |
| **evidences**     | Evidence     | Observation                      | Evidence source                           |
| **proves**        | Evidence     | Control                          | Control proof                             |
| **triggers**      | Finding      | Control                          | Control failure                           |
| **remediates**    | Action       | Finding                          | Remediation target                        |
| **verified_by**   | Action       | Verification                     | Action undergoes verification             |
| **produced_by**   | Evidence     | Verification                     | Verification produces evidence of success |
| **affected_by**   | Entity       | Supplier                         | Supplier dependency                       |

### Properties (Attributes)

Every node carries:

```
{
  id: UUID,
  organisationId: UUID (tenant boundary),
  type: string,
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: actor,
  source: integration source,
  externalId: reference to source system,

  // State tracking
  state: ACTIVE | ARCHIVED | UNKNOWN,
  lastObservedAt: timestamp,
  lastVerifiedAt: timestamp,

  // Evidence provenance
  evidenceChain: [Evidence],
  historicalStates: [HistoricalState]
}
```

### State Machines

**Observation → Evidence → Proof**

```
RAW_OBSERVATION
      ↓
  NORMALISED (validated format, deduplicated)
      ↓
  EVIDENCE (source verified, retention policy applied)
      ↓
  CONTROL_INPUT (mapped to control assessment)
```

**Control Evaluation**

```
UNKNOWN (no evidence or stale evidence)
   ↙     ↓     ↘
PROVEN  FAILING  NOT_APPLICABLE
   ↘     ↓     ↙
      EXCEPTION (explicitly authorised deviation)
```

**Action Lifecycle**

```
INTENT
   ↓
POLICY_EVALUATED
   ↓
AUTHORISATION_REQUIRED?
   ├─ YES → AWAITING_APPROVAL
   │         ↓
   │    APPROVED | DENIED
   │         ↓
   │    [if APPROVED]
   └─ NO → READY_TO_EXECUTE
            ↓
         EXECUTING
            ↓
          EXECUTED
            ↓
         VERIFYING
            ↓
   VERIFIED_SUCCESS | VERIFIED_FAILURE
            ↓
   [creates Verification node]
            ↓
   [Verification produces Evidence via produced_by edge]
```

---

## Alternatives Considered

### 1. Relational Database Without Graph Semantics

**Rejected:** Would require re-modelling for each new relationship type. Proof chains and evidence provenance become difficult to query and maintain.

### 2. Document-Per-Control Model

**Rejected:** Loses organisational relationships, creates data duplication, unable to trace control dependencies or asset relationships.

### 3. External Compliance Platform Integration

**Rejected:** Makes Adericel dependent on external platform models, loses control over schema evolution, creates vendor lock-in, unable to maintain framework-independent model.

---

## Consequences

### Positive

- **Unified truth source:** All security state flows through the graph
- **Evidence provenance:** Every claim traces back to observations and evidence
- **Framework agnostic:** New frameworks require mapping only, not re-architecture
- **Autonomous action:** Policy engine can query relationships to determine action scope and impact
- **Temporal queries:** Can reconstruct historical assurance states
- **Scalability:** Graph structure supports distributed querying and caching
- **Auditability:** Every change produces traceable edge modifications
- **Extensibility:** New entity types and relationships can be added without breaking existing structures
- **Verification chain:** Actions produce verifiable evidence, creating closed remediation loops

### Negative

- **Complexity:** Requires rigorous schema discipline
- **Query performance:** Graph queries more expensive than flat table queries (mitigated by caching, indexing)
- **Operational burden:** Database must maintain referential integrity across organisations
- **Learning curve:** Team must understand graph semantics

---

## Security Implications

- **Tenant isolation:** Every node must carry `organisationId`. Queries must filter by tenant.
- **Data access:** Permissions model must traverse graph relationships (person → identity → device → data)
- **Audit integrity:** Graph mutations are append-only where possible; deletions are rare
- **Evidence immutability:** Observation/Evidence nodes should be immutable after creation; corrections create new nodes with provenance
- **Verification integrity:** Verification nodes are immutable; failures create audit trail of attempted remediation

---

## Scalability Implications

- **Initial:** Single PostgreSQL with Apache AGE graph extension
- **Mid-scale:** Graph caching layer (Redis) for frequently traversed paths
- **Large-scale:** Distributed graph database or graph replication across regions

The model supports all deployment patterns without re-architecture.

---

## Operational Implications

- **Observability:** Graph statistics become operational metrics (node counts, relationship density, query patterns)
- **Backup/recovery:** Graph consistency must be tested in recovery procedures
- **Data migration:** New integrations require translation to canonical graph model
- **Verification monitoring:** Verification success/failure rates signal remediation effectiveness

---

## Reversal Conditions

This decision is reversed if:

1. The graph model becomes a performance bottleneck that caching cannot solve
2. A framework is encountered that requires non-relational semantics
3. Multi-tenant queries become operationally infeasible

---

## Related ADRs

- ADR-0002: Deterministic System as Source of Truth
- ADR-0003: Evidence Provenance and Historical Retention
- ADR-0006: Framework-Independent Requirement Model

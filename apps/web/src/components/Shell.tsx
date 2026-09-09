import type { ReactElement, ReactNode } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { Wordmark } from './Mark.js';
import { signOut } from '../lib/api.js';
import type { Me } from '../lib/types.js';

/**
 * Application shell.
 *
 * Navigation follows the assurance chain rather than a feature list, which is
 * how the people using it actually think about the work:
 *
 *   Assurance — what is true now, and what is unknown
 *   Fix       — findings and the action centre
 *   Proof     — evidence and its provenance
 *   Change    — what moved, and why
 *   Ask       — explore the graph and query the record
 */
export function Shell({ me, children }: { me: Me; children: ReactNode }): ReactElement {
  const { organisationId } = useParams();
  const base = organisationId ? `/organisations/${organisationId}` : null;

  return (
    <div className="app">
      <header className="masthead">
        <NavLink to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Wordmark size={22} inverse />
        </NavLink>
        <div className="masthead__context">
          <span>{me.principal.displayName}</span>
          <button
            type="button"
            className="button button--small button--secondary"
            style={{ color: 'var(--text-inverse)', borderColor: 'currentColor' }}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="nav" aria-label="Primary">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
        >
          Portfolio
        </NavLink>
        {base ? (
          <>
            <NavLink
              to={base}
              end
              className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
            >
              Assurance
            </NavLink>
            <NavLink
              to={`${base}/fix`}
              className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
            >
              Fix
            </NavLink>
            <NavLink
              to={`${base}/proof`}
              className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
            >
              Proof
            </NavLink>
            <NavLink
              to={`${base}/change`}
              className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
            >
              Change
            </NavLink>
            <NavLink
              to={`${base}/ask`}
              className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
            >
              Ask
            </NavLink>
          </>
        ) : null}
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lead ? <p className="page-header__lead">{lead}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  note,
  actions,
  children,
}: {
  title: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="section">
      <div className="section__head">
        <h2>{title}</h2>
        {actions ?? (note ? <span className="section__note">{note}</span> : null)}
      </div>
      {children}
    </section>
  );
}

export function Loading({ what }: { what: string }): ReactElement {
  return <div className="empty">Loading {what}…</div>;
}

export function ErrorNotice({ error }: { error: { message: string; code?: string; correlationId?: string } }): ReactElement {
  return (
    <div className="notice notice--failing">
      <div className="notice__title">{error.code ?? 'Error'}</div>
      <p>{error.message}</p>
      {error.correlationId ? (
        <p className="hash" style={{ marginTop: 'var(--space-2)' }}>
          Correlation {error.correlationId}
        </p>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="empty">{children}</div>;
}

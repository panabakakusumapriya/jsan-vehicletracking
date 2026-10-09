import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isAdminRole, type Project } from '../lib/types';

/**
 * The project filter every list page uses, with one rule about WHO sees which projects.
 *
 * An admin sees every project and starts on "All projects". Anyone else — a manager, a team lead —
 * works for particular projects: they are offered only those, and someone on exactly ONE project
 * starts on it, with no "All projects" to pick, because for them there is nothing else. Someone on
 * several gets "All my projects" plus each of theirs.
 *
 * The list comes from GET /api/projects, which the server narrows to the caller's own projects for
 * anyone but an admin — and is narrowed again here against the projects on the signed-in account
 * itself, so the rule holds even against a server that still returns every project.
 */

let cache: Promise<Project[]> | null = null;
let cachedFor = '';

function myProjects(userId: string): Promise<Project[]> {
  if (!cache || cachedFor !== userId) {
    cachedFor = userId;
    cache = api
      .get<{ projects: Project[] }>('/api/projects')
      .then((r) => r.projects || [])
      .catch(() => {
        cache = null;
        return [];
      });
  }
  return cache;
}

export interface ProjectScope {
  /** False for an admin: every project, "All projects" offered. */
  restricted: boolean;
  /** The caller's projects (all of them for an admin). Null until loaded. */
  projects: Project[] | null;
  /** When restricted to exactly one project, that project. */
  only: Project | null;
}

/** The project ids on the account, whether they arrived as ids or as populated documents. */
function ownProjectIds(user: { projectIds?: unknown[] } | null): string[] {
  return (user?.projectIds || [])
    .map((p) => (p && typeof p === 'object' ? String((p as { _id: string })._id) : String(p)))
    .filter(Boolean);
}

export function useProjectScope(): ProjectScope {
  const { user } = useAuth();
  const restricted = Boolean(user && !isAdminRole(user.role));
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    myProjects(user._id).then((list) => {
      if (!alive) return;
      if (!restricted) {
        setProjects(list);
        return;
      }
      const own = ownProjectIds(user);
      let mine = list.filter((p) => own.includes(p._id));
      // The account names projects the list did not return (inactive, or not loaded): use what the
      // account itself carries — populated names, or the single project name a driver record keeps.
      if (!mine.length && own.length) {
        const populated = (user.projectIds || []).filter(
          (p): p is { _id: string; name: string } => Boolean(p && typeof p === 'object' && 'name' in p)
        );
        mine = populated.length
          ? populated.map((p) => ({ _id: String(p._id), name: p.name }) as Project)
          : user.project
            ? [{ _id: own[0], name: user.project } as Project]
            : [];
      }
      setProjects(mine);
    });
    return () => { alive = false; };
  }, [user, restricted]);
  const only = restricted && projects && projects.length === 1 ? projects[0] : null;
  return { restricted, projects, only };
}

/**
 * Start a page's project filter on the caller's one project, once it is known — unless the page
 * already has a value (a link, a remembered filter).
 */
export function useDefaultProject(
  scope: ProjectScope,
  value: string,
  set: (v: string) => void,
  key: 'name' | 'id' = 'name'
) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !scope.only) return;
    done.current = true;
    if (!value) set(key === 'id' ? scope.only._id : scope.only.name);
  }, [scope.only, value, set, key]);
}

export function ProjectSelect({
  scope,
  value,
  onChange,
  options,
  keyBy = 'name',
  className = 'input',
  style,
  allLabel = 'All projects',
}: {
  scope: ProjectScope;
  value: string;
  onChange: (value: string) => void;
  /**
   * What this page can filter by. Pages that list projects from their own data (drivers, devices)
   * pass those names; the rest pass the project list. Narrowed to the caller's projects here.
   */
  options: { value: string; label: string }[];
  /** Whether option values are project names or ids. */
  keyBy?: 'name' | 'id';
  className?: string;
  style?: CSSProperties;
  allLabel?: string;
}) {
  const mine = scope.restricted && scope.projects
    ? new Set(scope.projects.map((p) => (keyBy === 'id' ? p._id : p.name)))
    : null;
  let shown = mine ? options.filter((o) => mine.has(o.value)) : options;
  // Their own projects are always on offer, even before the page's data mentions one of them.
  if (mine && scope.projects) {
    for (const p of scope.projects) {
      const v = keyBy === 'id' ? p._id : p.name;
      if (!shown.some((o) => o.value === v)) shown = [...shown, { value: v, label: p.name }];
    }
  }
  const single = Boolean(scope.only);
  return (
    <select
      className={className}
      style={style}
      aria-label="Project"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={single ? 'Your project' : undefined}
    >
      {!single && <option value="">{scope.restricted ? 'All my projects' : allLabel}</option>}
      {shown.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

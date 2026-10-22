import type { OperationRow } from '@joc/protocol';
import {
  Button,
  EmptyState,
  OPERATIONS_MIN_WORK,
  OperationRow as OperationRowView,
  OperationsConnect,
  OperationsGroup,
  OperationsHead,
  type OperationsLayout,
  operationsFixedWidth,
  SectionHeader,
  SegmentedControl,
  TextInput,
} from '@joc/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { installApp, reconnect, useAuth } from './auth.ts';
import { useNow, useOperations, useSessions } from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NewSessionDialog } from './NewSession.tsx';
import { isOpsFilter, type OpsFilter, opsNeeds, opsView, rowProps } from './operations.ts';
import { ago } from './time.ts';

const FILTER_ID = 'ops-filter';

/** Under this width each row is one link: title, activity, pipeline. */
const PHONE_MAX = 767;

const DESCRIPTION =
  'Every piece of work in flight, from the session to deployed. Each row is a Claude Code session, a pull request, or both, joined by branch.';

/** `/` jumps to the filter, unless the person is already typing somewhere. */
function useFilterShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = e.target;
      if (at instanceof HTMLElement && (at.isContentEditable || at.closest('input, textarea'))) {
        return;
      }
      e.preventDefault();
      document.getElementById(FILTER_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * The layout the table's width allows: every stage in its own column while Work keeps a decent
 * width, the stages folded into one pipeline cell when it wouldn't, one link per row on a phone.
 */
function useLayout(deployed: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [phone, setPhone] = useState(() => window.innerWidth <= PHONE_MAX);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setPhone(window.innerWidth <= PHONE_MAX);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const layout: OperationsLayout = phone
    ? 'phone'
    : !width || width >= operationsFixedWidth(deployed) + OPERATIONS_MIN_WORK
      ? 'full'
      : 'compact';
  return { ref, layout };
}

/** /operations: every piece of work in flight, one row each, from session to deployed. */
export function OperationsPage() {
  const ops = useOperations();
  const { sessions, connected } = useSessions();
  const auth = useAuth();
  const now = useNow();
  const [filter, setFilter] = useState<OpsFilter>('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [shippedOpen, setShippedOpen] = useState(false);
  const [starting, setStarting] = useState<OperationRow>();
  useFilterShortcut();

  // Rows keep the place they first arrived in; new ones join the end of their group.
  const order = useRef(new Map<string, number>());
  for (const r of ops?.rows ?? []) {
    if (!order.current.has(r.id)) order.current.set(r.id, order.current.size);
  }

  // A row that ships folds into Shipped only once the pointer has left the table, so the row
  // about to be clicked never moves.
  const [pointerIn, setPointerIn] = useState(false);
  const shippedIds = (ops?.rows ?? [])
    .filter((r) => r.shippedAt)
    .map((r) => r.id)
    .join('\n');
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const foldedOnce = useRef(false);
  useEffect(() => {
    if (!ops || (pointerIn && foldedOnce.current)) return;
    foldedOnce.current = true;
    setFolded(new Set(shippedIds ? shippedIds.split('\n') : []));
  }, [ops, pointerIn, shippedIds]);

  const view = ops ? opsView(ops, { filter, query, now, order: order.current, folded }) : undefined;
  const deployed = !!view?.deployed;
  const { ref, layout } = useLayout(deployed);
  const firstRun = ops?.github.state === 'none';
  const github = auth.status === 'signedIn' ? auth.github : undefined;

  const counts = view?.counts ?? { all: 0, needs: 0, review: 0, shipped: 0 };
  const filters = [
    { id: 'all', label: `All ${counts.all}` },
    { id: 'needs', label: `Needs you ${counts.needs}` },
    { id: 'review', label: `In review ${counts.review}` },
    { id: 'shipped', label: `Shipped today ${counts.shipped}` },
  ];

  const ctx = { now, deployed, onStart: setStarting };
  const deployRepos = new Set((ops?.deployRepos ?? []).map((r) => r.toLowerCase()));
  const row = (r: OperationRow, shippedGroup = false) => (
    <OperationRowView
      key={r.id}
      layout={layout}
      {...rowProps(r, {
        ...ctx,
        shippedGroup,
        repoDeploys: deployRepos.has(r.repo.toLowerCase()),
      })}
    />
  );
  const showShipped = filter === 'shipped' || shippedOpen;
  const visible = view?.groups.filter((g) => g.rows.length) ?? [];
  const nothing = !!view && view.groups.length === 0;
  const noneShown = !!view && !nothing && filter !== 'shipped' && visible.length === 0;
  const emptyText = query.trim()
    ? `Nothing matches “${query.trim()}”.`
    : filter === 'needs'
      ? 'Nothing needs you right now.'
      : filter === 'review'
        ? 'Nothing is in review.'
        : 'Nothing in flight.';

  const connect =
    github === 'install' ? (
      <Button variant="primary" onClick={installApp}>
        Connect GitHub
      </Button>
    ) : github === 'reconnect' ? (
      <Button variant="primary" onClick={reconnect}>
        Connect GitHub
      </Button>
    ) : undefined;

  return (
    <div className="joc-app app">
      <Nav page="operations" connected={connected} opsNeeds={opsNeeds(ops)} />
      <main className="joc-app__main app-page app-page--wide app-ops" ref={ref}>
        <SectionHeader size="lg" title="Operations" description={DESCRIPTION}>
          {ops?.github.state === 'reported' ? (
            <span className="app-ops__synced">
              Synced with GitHub {ago(ops.github.updatedAt, now)}
            </span>
          ) : null}
        </SectionHeader>

        {firstRun ? (
          <OperationsConnect
            title="GitHub isn't connected yet"
            body={
              connect
                ? 'Your sessions show now. Pull requests, checks, reviews, merges and deploys join each row by branch once JOC can read the repos.'
                : 'Your sessions show now. Pull requests, checks and reviews join each row by branch once your machine reads them through the GitHub CLI (gh auth login).'
            }
            action={connect}
          />
        ) : null}

        <div className="app-ops__filters">
          <SegmentedControl
            label="Show"
            options={filters}
            value={filter}
            onChange={(id) => {
              if (isOpsFilter(id)) setFilter(id);
            }}
          />
          <div className="app-ops__search">
            <TextInput
              id={FILTER_ID}
              placeholder={
                firstRun ? 'Filter by title or branch' : 'Filter by title, branch or #PR'
              }
              kbd="/"
              value={query}
              onChange={setQuery}
            />
          </div>
        </div>

        {view ? (
          <div
            className="joc-ops"
            onPointerEnter={() => setPointerIn(true)}
            onPointerLeave={() => setPointerIn(false)}
          >
            {nothing && filter !== 'shipped' && !query.trim() ? (
              <div className="joc-ops__none">
                <EmptyState
                  title="Nothing in flight"
                  body="Rows appear when a Claude Code session starts or a pull request opens on a connected repo. Start a session from your terminal:"
                  command="claude"
                />
              </div>
            ) : (
              <>
                <OperationsHead
                  layout={layout}
                  deployed={deployed}
                  note={firstRun ? 'Filled in from GitHub after you connect' : undefined}
                />
                {visible.map((g) => {
                  const closed = collapsed.has(g.repo);
                  return (
                    <div key={g.repo}>
                      <OperationsGroup
                        repo={g.repo}
                        count={
                          firstRun
                            ? `${g.all.length} ${g.all.length === 1 ? 'session' : 'sessions'}`
                            : `${g.all.length} in flight`
                        }
                        needs={g.needs}
                        collapsed={closed}
                        onToggle={() =>
                          setCollapsed((was) => {
                            const next = new Set(was);
                            if (next.has(g.repo)) next.delete(g.repo);
                            else next.add(g.repo);
                            return next;
                          })
                        }
                        note={
                          deployed && !g.deploys && layout !== 'phone'
                            ? 'No deploys reported'
                            : undefined
                        }
                        noteWidth={layout === 'full' ? 128 : undefined}
                      />
                      {closed ? null : g.rows.map((r) => row(r))}
                    </div>
                  );
                })}
                {noneShown || (nothing && filter !== 'shipped') ? (
                  <div className="joc-ops__empty">{emptyText}</div>
                ) : null}
              </>
            )}
            {view.shippedCount ? (
              <>
                <OperationsGroup
                  repo="Shipped"
                  count={`${view.shippedCount} in the last day`}
                  collapsed={!showShipped}
                  onToggle={() =>
                    filter === 'shipped' ? setFilter('all') : setShippedOpen((o) => !o)
                  }
                />
                {showShipped ? (
                  <div className="joc-ops__shipped">
                    {view.shipped.map((r) => row(r, true))}
                    {filter === 'shipped' && !view.shipped.length ? (
                      <div className="joc-ops__empty">Nothing shipped today yet.</div>
                    ) : null}
                    <div className="joc-ops__foot">
                      Shipped work leaves this list after 1 day, the same as ended sessions.
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {firstRun && view && !nothing ? (
          <span className="app-ops__note">
            Repos come from each session's git remote. After connecting, cells fill in place as data
            arrives; no row moves.
          </span>
        ) : null}
      </main>
      {starting ? (
        <NewSessionDialog
          repo={starting.repo}
          candidates={sessions.filter((s) => s.repo.toLowerCase() === starting.repo.toLowerCase())}
          sessions={sessions}
          prompt={
            starting.pull && starting.branch
              ? `Check out the branch ${starting.branch} (pull request #${starting.pull.number}) and get ready to work on it.`
              : undefined
          }
          onOpen={(id) => location.assign(`/?${new URLSearchParams({ session: id })}`)}
          onClose={() => setStarting(undefined)}
        />
      ) : null}
    </div>
  );
}

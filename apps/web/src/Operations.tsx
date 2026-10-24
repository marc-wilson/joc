import type { OperationRow } from '@joc/protocol';
import {
  Button,
  Dashboard,
  DashDrill,
  DashDrillBar,
  DashEmpty,
  DashEvent,
  DashFeed,
  DashGrid,
  DashKpi,
  DashKpis,
  DashLink,
  DashMachine,
  DashMachines,
  DashNeed,
  DashNeeds,
  DashNote,
  DashPanel,
  DashPipeline,
  DashRepo,
  DashRepos,
  DashSync,
  DashThroughput,
  OPERATIONS_MIN_WORK,
  OperationRow as OperationRowView,
  OperationsConnect,
  OperationsGroup,
  OperationsHead,
  type OperationsLayout,
  operationsFixedWidth,
  SectionHeader,
} from '@joc/ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { installApp, reconnect, useAuth } from './auth.ts';
import {
  type DashboardView,
  type Drill,
  dashboardOf,
  drillLabel,
  drillMatch,
  drillSearch,
  eventView,
  parseDrill,
  type QueueItem,
  sameDrill,
  settleQueue,
  span,
} from './dashboard.ts';
import { useActivity, useNow, useOperations, useSessions } from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NewSessionDialog } from './NewSession.tsx';
import { opsNeeds, opsTable, rowProps } from './operations.ts';
import { ago } from './time.ts';

/** Under this width each table row is one link: title, activity, pipeline. */
const PHONE_MAX = 767;

/** The feed shows this many events; it never scrolls. */
const FEED_ROWS = 8;

/** How long a resolved item takes to fade out: --duration-fade. */
const FADE_MS = 240;

const DESCRIPTION =
  'Everything in flight across your sessions and repos. Every number opens the work behind it.';

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

/** The drill-down, kept in the URL so Back and links work. */
function useDrill() {
  const [drill, setDrill] = useState<Drill | undefined>(() => parseDrill(location.search));
  useEffect(() => {
    const onPop = () => setDrill(parseDrill(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  /** Opens a drill-down; the one already open, or none, goes back to the overview. */
  const go = (next: Drill | undefined) => {
    const target = next && !sameDrill(next, drill) ? next : undefined;
    history.pushState(null, '', `${location.pathname}${drillSearch(target)}`);
    setDrill(target);
  };
  return { drill, go };
}

/**
 * What needs you, calmly: items keep their places, a new one joins where it ranks, and a
 * resolved one fades out where it was before it goes.
 */
function useCalmQueue(items: QueueItem[]) {
  const [order, setOrder] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const shown = useRef<string[]>([]);
  const known = useRef(new Map<string, QueueItem>());
  for (const item of items) known.current.set(item.key, item);
  // Item keys hold a newline; this separator never appears in one.
  const key = items.map((i) => i.key).join('\u001f');
  useEffect(() => {
    const ranked = key ? key.split('\u001f') : [];
    const was = shown.current;
    const out = settleQueue(
      was.filter((k) => ranked.includes(k)),
      ranked,
    );
    // Each resolved item stays after the one it followed until it has faded.
    const gone = was.filter((k) => !ranked.includes(k));
    for (const k of gone) {
      const before = was[was.indexOf(k) - 1];
      out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, k);
    }
    shown.current = out;
    setOrder(out);
    setLeaving(new Set(gone));
    if (!gone.length) return;
    const timer = setTimeout(() => {
      shown.current = shown.current.filter((k) => !gone.includes(k));
      setOrder(shown.current);
      setLeaving(new Set());
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return order.flatMap((k) => {
    const item = known.current.get(k);
    return item ? [{ item, leaving: leaving.has(k) }] : [];
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** /operations: a command centre over every piece of work in flight; the table is its drill-down. */
export function OperationsPage() {
  const ops = useOperations();
  const { sessions, connected } = useSessions();
  const auth = useAuth();
  const now = useNow();
  const activity = useActivity();
  const { drill, go } = useDrill();
  const [starting, setStarting] = useState<OperationRow>();

  const view = ops ? dashboardOf(ops, now) : undefined;
  const shown = view && drill ? view.rows.filter((r) => drillMatch(drill, r, now)) : [];
  const table = opsTable(shown, ops?.deployRepos ?? []);
  const { ref, layout } = useLayout(table.deployed);
  const queue = useCalmQueue(view?.queue ?? []);
  const gh = !!view?.github;
  const github = auth.status === 'signedIn' ? auth.github : undefined;

  const connect =
    github === 'install' ? installApp : github === 'reconnect' ? reconnect : undefined;
  const connectButton = (variant: 'primary' | 'secondary') =>
    connect ? (
      <Button variant={variant} size={variant === 'secondary' ? 'sm' : undefined} onClick={connect}>
        Connect GitHub
      </Button>
    ) : undefined;

  const deployRepos = new Set((ops?.deployRepos ?? []).map((r) => r.toLowerCase()));
  const row = (r: OperationRow) => (
    <OperationRowView
      key={r.id}
      layout={layout}
      {...rowProps(r, {
        now,
        deployed: table.deployed,
        shippedGroup: !!r.shippedAt,
        repoDeploys: deployRepos.has(r.repo.toLowerCase()),
        onStart: setStarting,
      })}
    />
  );

  return (
    <div className="joc-app app">
      <Nav page="operations" connected={connected} opsNeeds={opsNeeds(ops)} />
      <main className="joc-app__main app-page app-page--wide app-ops" ref={ref}>
        <Dashboard>
          <SectionHeader size="lg" title="Operations" description={DESCRIPTION}>
            {ops ? (
              <DashSync>
                {ops.github.state === 'reported'
                  ? `Synced with GitHub ${ago(ops.github.updatedAt, now)}`
                  : 'Sessions live · GitHub not connected'}
              </DashSync>
            ) : null}
          </SectionHeader>

          {view && !gh ? (
            <OperationsConnect
              title="GitHub isn't connected yet"
              body={
                connect
                  ? "Sessions, machines and Claude's activity are live now. Pull requests, checks, reviews, merges and deploys fill in once JOC can read your repos."
                  : "Sessions, machines and Claude's activity are live now. Pull requests, checks and reviews fill in once your machine reads them through the GitHub CLI (gh auth login)."
              }
              action={connectButton('primary')}
            />
          ) : null}

          {view ? (
            <DashKpis>
              {view.kpis.map((k) => {
                const selected = drill?.kind === 'kpi' && drill.id === k.id;
                return (
                  <DashKpi
                    key={k.id}
                    label={k.label}
                    value={k.value}
                    sub={k.sub}
                    lead={k.id === 'needs'}
                    needs={k.id === 'needs' && !!k.value}
                    selected={selected}
                    off={k.value === undefined}
                    ariaLabel={
                      k.value === undefined
                        ? `${k.label}: available after GitHub is connected`
                        : `${k.label}: ${k.value}. ${selected ? 'Back to the overview' : `Open the table filtered to ${k.label.toLowerCase()}`}`
                    }
                    onSelect={() => go({ kind: 'kpi', id: k.id })}
                  />
                );
              })}
            </DashKpis>
          ) : null}

          {view && drill ? (
            <DashDrill>
              <DashDrillBar
                label={drillLabel(drill, ops?.machines ?? [])}
                count={shown.length}
                onBack={() => go(undefined)}
              />
              <div className="joc-ops">
                <OperationsHead
                  layout={layout}
                  deployed={table.deployed}
                  note={gh ? undefined : 'Filled in from GitHub after you connect'}
                />
                {table.groups.map((g) => (
                  <div key={g.repo}>
                    <OperationsGroup
                      repo={g.repo}
                      count={`${g.rows.length} shown`}
                      needs={g.needs}
                    />
                    {g.rows.map(row)}
                  </div>
                ))}
                {shown.length ? null : (
                  <div className="joc-ops__empty">Nothing matches right now.</div>
                )}
              </div>
            </DashDrill>
          ) : null}

          {view && !drill ? (
            <Overview
              view={view}
              go={go}
              queue={queue}
              activity={activity}
              now={now}
              connect={connectButton('secondary')}
            />
          ) : null}
        </Dashboard>
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

interface OverviewProps {
  view: DashboardView;
  go: (drill: Drill | undefined) => void;
  queue: { item: QueueItem; leaving: boolean }[];
  activity: ReturnType<typeof useActivity>;
  now: number;
  connect?: ReactNode;
}

/** The panels: pipeline, what needs you, live activity, machines, repos, throughput. */
function Overview({ view, go, queue, activity, now, connect }: OverviewProps) {
  const gh = view.github;
  const live = queue.filter((q) => !q.leaving).length;
  const events = (activity.events ?? []).slice(0, FEED_ROWS);
  const t = view.throughput;
  return (
    <DashGrid>
      <DashPanel
        area="pipe"
        title="Pipeline"
        count={`${plural(view.rows.length, 'piece of work', 'pieces of work')}${gh ? ', in flight and shipped today' : ''}`}
        aside={
          <>
            <DashNote>
              {gh
                ? `${view.stuck} stuck · needs you or failing`
                : 'Sessions only until GitHub is connected'}
            </DashNote>
            <DashLink link={{ label: 'Open the whole table', onClick: () => go({ kind: 'all' }) }}>
              Open table
            </DashLink>
          </>
        }
      >
        <DashPipeline
          stages={view.stages.map((s) => ({
            ...s,
            onSelect: () => go({ kind: 'stage', id: s.id }),
          }))}
          note={
            gh
              ? 'Each piece of work sits at the furthest stage it has reached. Merged and Deployed count today. Stuck means it needs you or a check or deploy failed.'
              : 'Sessions are live now. Pull request, Review, Merged and Deployed fill in from GitHub, joined to each session by branch.'
          }
        />
      </DashPanel>

      <DashPanel
        area="needs"
        title="Needs you now"
        count={live ? String(live) : undefined}
        aside={<DashNote>Most urgent first</DashNote>}
        footer={
          <>
            <span>
              {live
                ? 'Each opens the exact place to act'
                : gh
                  ? 'Checked against sessions and GitHub'
                  : 'Checked against live sessions'}
            </span>
            <DashLink
              link={{
                label: 'Open the table filtered to what needs you',
                onClick: () => go({ kind: 'kpi', id: 'needs' }),
              }}
            >
              Open in table
            </DashLink>
          </>
        }
      >
        {queue.length ? (
          <DashNeeds>
            {queue.map(({ item, leaving }) => (
              <DashNeed
                key={item.key}
                reason={item.reason}
                title={item.row.title}
                repo={item.row.repo.split('/')[1] ?? item.row.repo}
                refText={item.row.pull ? `#${item.row.pull.number}` : (item.row.branch ?? '')}
                wait={`waiting ${span(item.waited)}`}
                action={item.action}
                link={{ label: item.action, href: item.href, external: item.external }}
                leaving={leaving}
              />
            ))}
          </DashNeeds>
        ) : (
          <DashEmpty
            icon="inbox"
            title="Nothing needs you"
            body="Questions from Claude, failing checks, requested changes, merge conflicts and failed deploys land here, most urgent first."
          />
        )}
      </DashPanel>

      <DashPanel
        area="feed"
        title="Live activity"
        count={gh ? 'All work' : 'Sessions only'}
        footer={
          <>
            <span>{gh ? 'New events arrive at the top' : 'GitHub events join once connected'}</span>
            <DashLink link={{ label: 'Open History', href: '/history' }}>Open History</DashLink>
          </>
        }
      >
        <DashFeed label="Live activity">
          {events.map((e) => {
            const v = eventView(e, now);
            return (
              <DashEvent
                key={v.id}
                time={v.time}
                glyph={v.glyph}
                what={v.what}
                subject={v.subject}
                where={v.where}
                fresh={activity.fresh.has(v.id)}
              />
            );
          })}
        </DashFeed>
      </DashPanel>

      <DashPanel
        area="machines"
        title="Machines"
        count={`${view.online} of ${view.machines.length} online · ${plural(view.sessions, 'session')}`}
        footer={<span>Counts come from each machine's JOC link.</span>}
      >
        {view.machines.length ? (
          <DashMachines>
            {view.machines.map((m) => (
              <DashMachine
                key={m.machine.id}
                name={m.machine.name}
                status={m.status}
                online={m.machine.online}
                live={m.live}
                states={m.states}
                onSelect={() => go({ kind: 'machine', id: m.machine.id })}
              />
            ))}
          </DashMachines>
        ) : (
          <DashEmpty
            icon="terminal"
            title="No machines yet"
            body="A machine shows here once you link it with /joc-login in Claude Code."
          />
        )}
      </DashPanel>

      <DashPanel
        area="repos"
        title="Repos"
        count={plural(view.repos.length, 'repo')}
        aside={<DashNote>Bars: work by stage, today</DashNote>}
      >
        {view.repos.length ? (
          <DashRepos>
            {view.repos.map((r) => (
              <DashRepo
                key={r.repo}
                repo={r.repo}
                inflight={r.inflight}
                needs={r.needs}
                segments={r.segments}
                note={r.note}
                onSelect={() => go({ kind: 'repo', id: r.repo })}
              />
            ))}
          </DashRepos>
        ) : (
          <DashEmpty
            icon="folder"
            title="Nothing in flight"
            body="Repos show here when a Claude Code session starts or a pull request opens."
          />
        )}
      </DashPanel>

      <DashPanel area="throughput" title="Throughput" count="Last 7 days">
        {gh ? (
          <DashThroughput
            merges={t.merges}
            deploys={t.deploys}
            median={t.medianMs === undefined ? '—' : span(t.medianMs)}
            days={t.days}
          />
        ) : (
          <DashEmpty
            icon="pr"
            title="Connect GitHub to see throughput"
            body="Merges and deploys per day, and the median time from session start to merge, come from your pull requests and deployments."
            action={connect}
          />
        )}
      </DashPanel>
    </DashGrid>
  );
}

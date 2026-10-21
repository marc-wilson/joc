import { SessionSettings, STANDARD_REVIEW, Theme } from '@joc/protocol';
import {
  Button,
  type SaveStatus,
  SegmentedControl,
  SettingRow,
  SettingsCard,
  SettingsLayout,
  SettingsSection,
  TextArea,
  TextInput,
  TextLink,
} from '@joc/ui';
import { useState } from 'react';
import { apiFetch, installApp, reconnect, useAuth } from './auth.ts';
import { appNameOf, UNTIL_COVERED, useGitHubConnection } from './GitHubConnect.tsx';
import { useReviewSettings, useSessionSettings, useSessions } from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NotificationSettingsForm, resetNotificationSettings } from './NotificationSettings.tsx';
import { updatePrefs, usePrefs } from './prefs.ts';
import { ENDED_OPTIONS, QUIET_OPTIONS } from './session-list.ts';

const SECTIONS = [
  { id: 'sessions', label: 'Session list' },
  { id: 'review', label: 'Review instructions' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
];
const GITHUB_SECTION = { id: 'github', label: 'GitHub' };

const signedInDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** How the person's GitHub reaches JOC through the GitHub App, and what to do about it. */
function GitHubConnectionRows() {
  const connection = useGitHubConnection();
  if (!connection || connection.state === 'off') return null;
  const name = appNameOf(connection);
  const reconnectButton = (
    <Button variant="secondary" size="sm" onClick={reconnect}>
      Reconnect
    </Button>
  );
  if (connection.state === 'reconnect') {
    return (
      <SettingRow
        label={`Not connected through ${name} yet`}
        hint={`You signed in before JOC used it. Reconnect to get live updates. ${UNTIL_COVERED}`}
      >
        {reconnectButton}
      </SettingRow>
    );
  }
  return (
    <>
      <SettingRow
        label={`Connected through ${name}`}
        hint={
          connection.signedInAt
            ? `Signed in through it on ${signedInDate(connection.signedInAt)}.`
            : undefined
        }
      >
        {reconnectButton}
      </SettingRow>
      {connection.accounts.map((a) => (
        <SettingRow
          key={a.login}
          label={`@${a.login}`}
          hint={`${a.type === 'Organization' ? 'Organization' : 'Your account'}${a.suspended ? ', suspended: no live updates' : ''}`}
        >
          <TextLink href={a.manageUrl}>Manage</TextLink>
        </SettingRow>
      ))}
      <SettingRow
        label={
          connection.accounts.length ? 'Another account or org' : 'Not installed where you are'
        }
        hint={
          connection.accounts.length
            ? `Install ${name} there to get its pull requests live.`
            : `Install ${name} on your account or org to get live GitHub updates. ${UNTIL_COVERED}`
        }
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={!connection.installUrl}
          onClick={installApp}
        >
          Install
        </Button>
      </SettingRow>
    </>
  );
}

/** The longest review instructions the server takes. */
const MAX_INSTRUCTIONS = 20_000;

type Track = (saving: Promise<boolean>) => void;

/** How long quiet and ended sessions stay on the live list. They stay in History either way. */
function SessionList({ track }: { track: Track }) {
  const { settings, save } = useSessionSettings();
  if (!settings) return null;
  const pick = (key: keyof SessionSettings) => (id: string) => {
    const parsed = SessionSettings.safeParse({ ...settings, [key]: id });
    if (parsed.success) track(save(parsed.data));
  };
  return (
    <>
      <SettingRow
        label="Quiet sessions"
        hint="Their machine stopped reporting without ending them, such as a laptop asleep overnight."
      >
        <SegmentedControl
          label="Quiet sessions stay for"
          options={QUIET_OPTIONS}
          value={settings.quiet}
          onChange={pick('quiet')}
        />
      </SettingRow>
      <SettingRow label="Ended sessions" hint="You exited Claude Code.">
        <SegmentedControl
          label="Ended sessions stay for"
          options={ENDED_OPTIONS}
          value={settings.ended}
          onChange={pick('ended')}
        />
      </SettingRow>
      <SettingRow label="Pinned sessions" hint="Stay until you unpin them." />
    </>
  );
}

const THEME_OPTIONS = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Light, dark, or as the system is; the page changes at once. */
function Appearance() {
  const { theme } = usePrefs();
  return (
    <SettingRow label="Theme" hint="System follows your computer's light or dark appearance.">
      <SegmentedControl
        label="Theme"
        options={THEME_OPTIONS}
        value={theme}
        onChange={(id) => {
          const parsed = Theme.safeParse(id);
          if (parsed.success) updatePrefs({ theme: parsed.data });
        }}
      />
    </SettingRow>
  );
}

type Mode = 'command' | 'prompt';

/** A slash command, or a prompt of the person's own; empty runs Claude's review. */
function ReviewInstructions({ value, track }: { value: string; track: Track }) {
  const [mode, setMode] = useState<Mode>(value && !value.startsWith('/') ? 'prompt' : 'command');
  // Each kind keeps its own text, so trying the other doesn't lose it.
  const [drafts, setDrafts] = useState<Record<Mode, string>>({
    command: value.startsWith('/') ? value : '',
    prompt: value && !value.startsWith('/') ? value : '',
  });
  const [saved, setSaved] = useState(value);

  function save(text: string) {
    const instructions = text.trim();
    if (instructions === saved) return;
    setSaved(instructions);
    track(
      apiFetch('/api/settings/review', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions: instructions || undefined }),
      })
        .then((res) => res.ok)
        .catch(() => false),
    );
  }

  const edit = (text: string) => setDrafts((d) => ({ ...d, [mode]: text }));
  return (
    <>
      <SettingRow label="Send">
        <SegmentedControl
          label="Review instructions type"
          options={[
            { id: 'command', label: 'Command' },
            { id: 'prompt', label: 'Prompt' },
          ]}
          value={mode}
          onChange={(id) => {
            const next: Mode = id === 'prompt' ? 'prompt' : 'command';
            setMode(next);
            save(drafts[next]);
          }}
        />
      </SettingRow>
      <SettingsCard>
        {mode === 'command' ? (
          <TextInput
            key="command"
            id="review-command"
            label="Command"
            mono
            placeholder={STANDARD_REVIEW}
            value={drafts.command}
            onChange={edit}
            onBlur={save}
            hint={`A slash command from the session's plugins, such as /prep-pr. {pr} is the PR number and {url} its address; with neither, the address goes after it. Empty runs Claude's review, ${STANDARD_REVIEW}.`}
          />
        ) : (
          <TextArea
            key="prompt"
            id="review-prompt"
            label="Prompt"
            placeholder="The instructions Claude should follow for a review"
            value={drafts.prompt}
            maxLength={MAX_INSTRUCTIONS}
            onChange={edit}
            onBlur={save}
            hint="{pr} is the PR number and {url} its address; with neither, the address goes on a line after it."
          />
        )}
      </SettingsCard>
    </>
  );
}

/** /settings: the person's own settings, kept by the server for every browser they use. */
export function SettingsPage() {
  const { connected } = useSessions();
  const review = useReviewSettings();
  const auth = useAuth();
  const withApp = auth.status === 'signedIn' && !!auth.github && auth.github !== 'off';
  const sections = withApp ? [...SECTIONS, GITHUB_SECTION] : SECTIONS;
  const [current, setCurrent] = useState(() => location.hash.slice(1) || 'sessions');
  // What's shown is what's saved, so the mark says so at rest too, as the design has it.
  const [status, setStatus] = useState<SaveStatus>('saved');
  const track: Track = (saving) => {
    setStatus('saving');
    void saving.then((ok) => setStatus(ok ? 'saved' : 'failed'));
  };
  return (
    <div className="joc-app app">
      <Nav page="settings" connected={connected} />
      <main className="joc-app__main app-settings-page">
        <SettingsLayout
          sections={sections}
          current={current}
          onNavigate={setCurrent}
          status={status}
        >
          <SettingsSection
            id="sessions"
            title="Session list"
            description="How long sessions stay in the list. They stay in History either way."
          >
            <SessionList track={track} />
          </SettingsSection>
          <SettingsSection
            id="review"
            title="Review instructions"
            description="What the Review button on a pull request sends to Claude, in a new session on the PR's repo."
          >
            {review ? <ReviewInstructions value={review.instructions ?? ''} track={track} /> : null}
          </SettingsSection>
          <SettingsSection
            id="notifications"
            title="Notifications"
            description="Each notification clears itself once it’s handled. History keeps them for 30 days."
            actions={
              <Button variant="ghost" size="sm" onClick={resetNotificationSettings}>
                Reset to defaults
              </Button>
            }
          >
            <NotificationSettingsForm />
          </SettingsSection>
          <SettingsSection
            id="appearance"
            title="Appearance"
            description="How JOC looks in every browser you use."
          >
            <Appearance />
          </SettingsSection>
          {withApp ? (
            <SettingsSection
              id="github"
              title="GitHub"
              description="Pull requests, reviews, CI and comments arrive live from the accounts the GitHub App is installed on."
            >
              <GitHubConnectionRows />
            </SettingsSection>
          ) : null}
        </SettingsLayout>
      </main>
    </div>
  );
}

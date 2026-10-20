import { STANDARD_REVIEW } from '@joc/protocol';
import { Button, SectionHeader, TextArea } from '@joc/ui';
import { useState } from 'react';
import { apiFetch } from './auth.ts';
import { useReviewSettings, useSessions } from './hooks.ts';
import { Nav } from './Nav.tsx';

type Saved = 'saving' | 'saved' | 'failed' | undefined;

/** The review instructions field, once the stored ones are loaded. */
function ReviewInstructions({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState<Saved>();

  async function save() {
    setSaved('saving');
    try {
      const res = await apiFetch('/api/settings/review', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions: draft.trim() || undefined }),
      });
      setSaved(res.ok ? 'saved' : 'failed');
    } catch {
      setSaved('failed');
    }
  }

  return (
    <div className="app-settings-page__form">
      <TextArea
        label="Review instructions"
        placeholder={`Empty runs Claude's review: ${STANDARD_REVIEW} and the PR number`}
        value={value}
        rows={6}
        onChange={(text) => {
          setDraft(text);
          setSaved(undefined);
        }}
        hint="A command such as /prep-pr, or a prompt of your own. {pr} is the PR number and {url} its address; with neither, the address goes after it."
      />
      <div className="app-settings-page__actions">
        <span>
          {saved === 'saved' ? 'Saved.' : saved === 'failed' ? "Couldn't save. Try again." : ''}
        </span>
        <Button
          variant="primary"
          size="sm"
          loading={saved === 'saving'}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** /settings: the person's own settings, kept by the server for every browser they use. */
export function SettingsPage() {
  const { connected } = useSessions();
  const review = useReviewSettings();
  return (
    <div className="joc-app app">
      <Nav page="settings" connected={connected} />
      <main className="joc-app__main app-page app-settings-page">
        <SectionHeader size="lg" title="Settings" />
        <SectionHeader
          title="Pull request reviews"
          description="What the Review button on a pull request runs, in a new session."
        />
        {review ? <ReviewInstructions value={review.instructions ?? ''} /> : null}
      </main>
    </div>
  );
}

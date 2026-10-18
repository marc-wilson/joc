import {
  CIBadge,
  Composer,
  DiffFileHeader,
  DiffLine,
  Message,
  PRRow,
  RepoGroupHeader,
  SessionRow,
  StateBadge,
  ThemePair,
} from '@joc/ui';

// Placeholder: a sample of design-system components until the real screens land.
export default function App() {
  return (
    <ThemePair>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StateBadge state="working" />
        <StateBadge state="background" />
        <StateBadge state="needs" />
        <StateBadge state="idle" />
        <StateBadge state="offline" />
        <CIBadge status="pass" detail="12/12" />
        <CIBadge status="pending" detail="6/12" />
        <CIBadge status="fail" detail="2/12" />
      </div>
      <div style={{ width: 340 }}>
        <RepoGroupHeader repo="harbor-labs/atlas-web" count={2} needs={1} />
        <SessionRow
          state="working"
          title="Fix OAuth redirect loop"
          branch="fix/auth-redirect"
          contextLeft={64}
          activity="pnpm test atlas-web --testFile=callback"
          time="now"
          selected
        />
        <SessionRow
          state="needs"
          title="Dark mode for settings"
          branch="feat/settings-dark-mode"
          contextLeft={41}
          activity="Asking: follow the system theme or keep a toggle?"
          time="3m"
        />
      </div>
      <PRRow
        number={238}
        repo="atlas-api"
        title="Migrate transactional mail to Resend"
        branch="feat/resend-mailer"
        author="Priya Raman"
        updated="1m ago"
        ci="pending"
        ciDetail="6/12"
        review="Review requested"
        additions={412}
        deletions={198}
        session={{ title: 'Migrate mailer to Resend', state: 'needs' }}
      />
      <Message from="claude" time="10:32">
        <p>Reproduced it. The callback reads the redirect before the session is validated.</p>
      </Message>
      <Message from="tool" name="Edit" target="apps/web/src/auth/callback.ts" meta="+24 −9" />
      <div>
        <DiffFileHeader path="apps/web/src/auth/callback.ts" additions={24} deletions={9} />
        <DiffLine kind="hunk">@@ -38,10 +38,13 @@ export async function handleCallback</DiffLine>
        <DiffLine oldNo={40} kind="del">
          const next = req.query.redirect ?? '/';
        </DiffLine>
        <DiffLine newNo={40} kind="add">
          if (!session?.valid) return redirect('/login');
        </DiffLine>
      </div>
      <Composer
        value="/te"
        query="te"
        suggestions={[{ command: 'test', description: 'Run the test suite' }]}
      />
    </ThemePair>
  );
}

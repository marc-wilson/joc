import { DropAfter, type SessionSettings } from '@joc/protocol';
import { Button, ChoiceField, Dialog } from '@joc/ui';
import { useState } from 'react';
import { DROP_AFTER_OPTIONS } from './session-list.ts';

interface Props {
  settings: SessionSettings;
  /** Resolves false when the server didn't take them. */
  onSave: (settings: SessionSettings) => Promise<boolean>;
  onClose: () => void;
}

/** How long quiet and ended sessions stay on the live list. They stay in History either way. */
export function SessionSettingsDialog({ settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pick = (key: keyof SessionSettings) => (id: string) => {
    const parsed = DropAfter.safeParse(id);
    if (parsed.success) setDraft((d) => ({ ...d, [key]: parsed.data }));
  };

  async function save() {
    setSaving(true);
    setFailed(false);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) onClose();
    else setFailed(true);
  }

  return (
    <Dialog
      label="Session list settings"
      title="Session list"
      className="app-settings-dialog"
      onClose={onClose}
      footer={
        <div className="app-settings__foot">
          <span>{failed ? "Couldn't save. Try again." : 'Every session stays in History.'}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="app-settings">
        <ChoiceField
          label="Drop quiet sessions after"
          hint="A session goes quiet when its machine stops reporting without ending it, such as a laptop asleep overnight."
          options={DROP_AFTER_OPTIONS}
          value={draft.quiet}
          onChange={pick('quiet')}
        />
        <ChoiceField
          label="Drop ended sessions after"
          hint="A session ends when you exit Claude Code."
          options={DROP_AFTER_OPTIONS}
          value={draft.ended}
          onChange={pick('ended')}
        />
      </div>
    </Dialog>
  );
}

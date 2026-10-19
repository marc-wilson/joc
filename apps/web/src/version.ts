import type { Device } from '@joc/protocol';

/** Updates the plugin, in a terminal on the machine. `/reload-plugins` then loads it. */
export const UPDATE_COMMAND =
  'claude plugin marketplace update joc && claude plugin update joc@joc';

/** "harbor-mbp", "harbor-mbp and studio-mini", "harbor-mbp, studio-mini and ci-box". */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** The banner's title for the machines whose plugin is behind `latest`. */
export function behindTitle(behind: Device[], latest: string): string {
  const [only] = behind;
  if (behind.length === 1 && only?.plugin) {
    return `${only.name} runs JOC plugin ${only.plugin}, behind ${latest}`;
  }
  const verb = behind.length === 1 ? 'runs' : 'run';
  return `${names(behind.map((d) => d.name))} ${verb} an older JOC plugin than ${latest}`;
}

/**
 * One line of markdown as plain text, for places that show a short summary (a session's last
 * activity): `**bold**`, `code`, [links](…), headings and list markers lose their syntax.
 */
export function plain(line: string): string {
  return (
    line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
      // Underscores only emphasise at word edges, so snake_case stays as it is.
      .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?=\W|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, '')
      .trim()
  );
}

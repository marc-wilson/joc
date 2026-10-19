import { type ReactNode, useState } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

const KEYWORD =
  /\b(const|let|var|function|return|if|else|for|while|import|from|export|default|async|await|new|class|extends|type|interface|true|false|null|undefined)\b/;
const TOKEN =
  /(\/\/[^\n]*|#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\()|\b([A-Za-z_$][\w$]*)\b/g;

// A tiny highlighter: comments, strings, numbers, keywords and function calls.
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1]
      ? 'c'
      : m[2]
        ? 's'
        : m[3]
          ? 'n'
          : m[4]
            ? KEYWORD.test(m[4])
              ? 'k'
              : 'f'
            : m[5] && KEYWORD.test(m[5])
              ? 'k'
              : null;
    out.push(
      cls ? (
        <span key={key++} className={`tok-${cls}`}>
          {m[0]}
        </span>
      ) : (
        m[0]
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export interface CopyButtonProps {
  text: string;
  label?: boolean;
}

export function CopyButton({ text, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cx('joc-copy', copied && 'is-copied')}
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span className="joc-copy__a">
        <Icon name="copy" size={14} />
        {label ? <span>Copy</span> : null}
      </span>
      <span className="joc-copy__b">
        <Icon name="check" size={14} />
        {label ? <span>Copied</span> : null}
      </span>
    </button>
  );
}

export interface CodeBlockProps {
  code: string;
  lang?: string;
  filename?: string;
  lineNumbers?: boolean;
}

export function CodeBlock({ code, lang, filename, lineNumbers = true }: CodeBlockProps) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <div className="joc-codeblock">
      <div className="joc-codeblock__head">
        <span className="joc-codeblock__name">{filename || lang || 'code'}</span>
        <CopyButton text={code} label />
      </div>
      <pre className="joc-codeblock__pre">
        <code>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
            <span key={i} className="joc-codeblock__line">
              {lineNumbers ? <span className="joc-codeblock__no">{i + 1}</span> : null}
              {highlight(line)}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export interface CopyCommandProps {
  command: string;
  prompt?: string;
}

export function CopyCommand({ command, prompt = '$' }: CopyCommandProps) {
  return (
    <div className="joc-cmd">
      <span className="joc-cmd__prompt" aria-hidden="true">
        {prompt}
      </span>
      <code className="joc-cmd__text">{command}</code>
      <CopyButton text={command} />
    </div>
  );
}

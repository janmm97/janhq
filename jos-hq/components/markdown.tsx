// Minimal, safe Markdown for executor answers: paragraphs, bullet/numbered lists, inline code, bold,
// fenced code. No HTML is ever interpreted; links render as text.
import type { ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code key={`${keyBase}-${i++}`} className="rounded-[3px] bg-tray px-1 py-px text-[12.5px] text-paper">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <strong key={`${keyBase}-${i++}`} className="font-semibold text-paper">
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={k++} className="code-block my-2 overflow-x-auto rounded-[4px] border border-rim bg-ground p-3 text-silver-hi">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={k++} className={ordered ? "my-2 list-decimal space-y-1 pl-5" : "my-2 list-disc space-y-1 pl-5"}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      blocks.push(
        <p key={k++} className="mt-3 font-semibold text-paper">
          {inline(line.replace(/^#{1,4}\s+/, ""), `h${k}`)}
        </p>,
      );
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^#{1,4}\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={k++} className="my-2 whitespace-pre-wrap">
        {inline(para.join("\n"), `p${k}`)}
      </p>,
    );
  }
  return <div className="max-w-[76ch] text-[14px] leading-[1.55] text-silver-hi">{blocks}</div>;
}

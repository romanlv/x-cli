// What `request:status --wait` shows while it waits: the request, then a row per stage of its run,
// the running one with what its agents are doing. On a terminal the block is redrawn in place, in
// colour and with a spinner; in a log, a line is printed once, when it first appears or what it says changes.
import type { StageRow } from "./awf";
import type { RequestRecord } from "./requests";

const STYLE = { bold: "1", dim: "2", red: "31", green: "32", magenta: "35", cyan: "36", grey: "90" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Text in a style; on a terminal, a part that spins is the spinner. */
type Part = { text: string; style?: keyof typeof STYLE; spins?: boolean };

const MARK: Record<string, Part> = {
  succeeded: { text: "✓", style: "green" },
  running: { text: "▸", style: "cyan", spins: true },
  failed: { text: "✗", style: "red" },
};

/** A line in parts, each in its style; `key` is what it says less its times and steps. */
export interface Line {
  parts: Part[];
  key: string;
}

/** Its state, and the stage it is in or stopped at, when it has one. */
export const stateOf = (r: RequestRecord): string => `${r.state}${r.stage ? ` (${r.stage})` : ""}`;

export const requestLines = (r: RequestRecord, stages: StageRow[]): Line[] => {
  const width = Math.max(0, ...stages.map((s) => s.stage.length));
  const head: Line = {
    parts: [
      { text: r.id, style: "bold" },
      { text: ` · ${stateOf(r)} · ` },
      { text: `${r.op ?? r.kind}:`, style: "magenta" },
      { text: ` ${r.text.replace(/\s+/g, " ")}`, style: "grey" },
    ],
    key: `${r.id} ${stateOf(r)}`,
  };
  const rows = stages.map(
    (s): Line => ({
      parts: [
        { text: "  " },
        MARK[s.state] ?? { text: "·" },
        { text: " " },
        { text: `${s.stage.padEnd(width)}  ${s.time}`, style: s.state === "running" ? "bold" : undefined },
        ...s.turns.map(
          (t): Part => ({
            text: ` · ${t.label} · ${t.agent}${t.model ? ` (${t.model})` : ""}${t.step ? ` · ${t.step}` : ""}`,
            style: "dim",
          }),
        ),
      ],
      key: [`${s.stage} ${s.state}`, ...s.turns.map((t) => `${t.label} · ${t.agent}`)].join(" · "),
    }),
  );
  return [head, ...rows];
};

const textOf = (parts: Part[]): string => parts.map((p) => p.text).join("");
export const lineText = (line: Line): string => textOf(line.parts);

/** The line cut to `width` characters, the last one an ellipsis. */
const fit = (parts: Part[], width: number): Part[] => {
  if (textOf(parts).length <= width) return parts;
  const kept: Part[] = [];
  let room = width - 1;
  for (const part of parts) {
    if (room <= 0) break;
    kept.push({ ...part, text: part.text.slice(0, room) });
    room -= part.text.length;
  }
  return [...kept, { text: "…" }];
};

/** Shows lines on stderr, each `show` replacing the last; `stop` ends the spinner. */
export const statusBoard = (): { show(lines: Line[]): void; stop(): void } => {
  const live = !!process.stderr.isTTY;
  const color = live && !process.env.NO_COLOR;
  let lines: Line[] = [];
  let drawn = 0;
  let frame = 0;
  const printed = new Set<string>();
  const paint = ({ text, style, spins }: Part): string => {
    const shown = spins ? SPINNER[frame % SPINNER.length]! : text;
    return color && style ? `\x1b[${STYLE[style]}m${shown}\x1b[0m` : shown;
  };
  const draw = () => {
    const width = (process.stderr.columns || 120) - 1;
    const text = lines.map((l) => `${fit(l.parts, width).map(paint).join("")}\n`).join("");
    process.stderr.write(`${drawn ? `\x1b[${drawn}F\x1b[J` : ""}${text}`);
    drawn = lines.length;
  };
  // The spinner turns between polls.
  const ticker = live
    ? setInterval(() => {
        frame++;
        if (lines.length) draw();
      }, 100)
    : undefined;
  return {
    show(next) {
      lines = next;
      if (live) return draw();
      for (const line of next.filter((l) => !printed.has(l.key))) {
        printed.add(line.key);
        process.stderr.write(`${lineText(line)}\n`);
      }
    },
    stop: () => clearInterval(ticker),
  };
};

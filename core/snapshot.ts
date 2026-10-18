// The page as an agent reads it: one line per control or heading, each control with a ref (`e14`)
// that `page:click e14` acts on. Refs are stamped on the elements as `data-ref`, so they stay the
// same across snapshots of one page and a diff marks what an action changed.
import type { Locator, Page } from "playwright";

export interface SnapshotNode {
  ref?: string;
  depth: number;
  role: string;
  name: string;
  value?: string;
  /** The id the app marks the control with, in the domain's `testIdAttribute`. */
  testId?: string;
  /** Whether that test id names this element alone on the page. */
  testIdUnique?: boolean;
  label?: string;
  /** Its text as Playwright's `hasText` and `getByText` match it (`textContent`), where that isn't its name. */
  text?: string;
  /** Whether its name is its `aria-label` or `aria-labelledby`, which `getByLabel` matches, rather than its text. */
  labelled?: boolean;
  /** Whether it has no text at all, so a name it has came from an attribute (`title`, `placeholder`) `hasText` can't match. */
  textless?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  nodes: SnapshotNode[];
}

/** Runs in the page. Kept free of closures over module scope, since Playwright serializes it. */
const collect = (testIdAttribute: string): Omit<Snapshot, "url" | "title"> => {
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "option",
    "listbox",
    "switch",
    "treeitem",
    "searchbox",
    "spinbutton",
    "menuitemcheckbox",
    "menuitemradio",
  ]);
  const STRUCTURE_ROLES = new Set(["dialog", "alertdialog", "alert", "heading", "tablist", "menu", "grid", "table", "row", "form"]);
  const clean = (text: string | null | undefined, max = 80): string => {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  /** Hidden prunes the subtree; a zero-size box, such as a popup's anchor, hides only itself. */
  const visibility = (el: Element): "hidden" | "empty" | "shown" => {
    if (el.closest("[aria-hidden='true']")) return "hidden";
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return "hidden";
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || style.position === "fixed" ? "shown" : "empty";
  };
  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "dialog") return "dialog";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "hidden") return undefined;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    return undefined;
  };
  const labelledBy = (el: Element): string =>
    clean(
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
  const labelOf = (el: Element): string => {
    const labelled = labelledBy(el);
    if (labelled) return labelled;
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return clean(label.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) return clean(wrapping.textContent);
    return clean(el.getAttribute("placeholder") ?? el.getAttribute("title"));
  };
  const nameOf = (el: Element, role: string): string => {
    if (["textbox", "combobox", "searchbox", "spinbutton", "checkbox", "radio", "listbox", "switch"].includes(role)) {
      return labelOf(el);
    }
    // A container is named by its label alone; its text is its children's.
    if (["form", "table", "grid", "row", "menu", "tablist", "dialog", "alertdialog", "listbox"].includes(role)) {
      return clean(el.getAttribute("aria-label")) || (el.getAttribute("aria-labelledby") ? labelOf(el) : "");
    }
    return clean(el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? el.textContent) || labelOf(el);
  };

  let next = 0;
  for (const el of document.querySelectorAll("[data-ref]")) {
    next = Math.max(next, Number(el.getAttribute("data-ref")!.slice(1)) || 0);
  }
  const counts = new Map<string, number>();
  for (const el of document.querySelectorAll(`[${testIdAttribute}]`)) {
    const id = el.getAttribute(testIdAttribute)!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const nodes: SnapshotNode[] = [];
  const walk = (el: Element, depth: number): void => {
    const seen = visibility(el);
    if (seen === "hidden") return;
    if (seen === "empty") {
      for (const child of el.children) walk(child, depth);
      return;
    }
    const role = roleOf(el);
    const testId = el.getAttribute(testIdAttribute) ?? undefined;
    const interactive =
      (role !== undefined && INTERACTIVE_ROLES.has(role)) ||
      (el as HTMLElement).isContentEditable ||
      (Number(el.getAttribute("tabindex") ?? -1) >= 0 && !!testId);
    const structural = role !== undefined && STRUCTURE_ROLES.has(role);
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join(" ");
    const labelText = !role && !!testId && clean(ownText) !== "";

    let childDepth = depth;
    if (interactive || structural || labelText) {
      const node: SnapshotNode = {
        depth,
        role: role ?? (interactive ? "generic" : "text"),
        name: labelText && !role ? clean(ownText) : nameOf(el, role ?? "generic"),
      };
      // Playwright matches text as textContent, children joined without the spaces innerText puts
      // between blocks, so a locator by text needs that text, not the name.
      const text = clean(el.textContent);
      if (text && text !== node.name) node.text = text;
      if (!text) node.textless = true;
      const aria = clean(el.getAttribute("aria-label"));
      if (node.name && (aria === node.name || labelledBy(el) === node.name)) node.labelled = true;
      if (testId) {
        node.testId = testId;
        node.testIdUnique = counts.get(testId) === 1;
      }
      if (interactive) {
        let ref = el.getAttribute("data-ref");
        if (!ref) {
          ref = `e${++next}`;
          el.setAttribute("data-ref", ref);
        }
        node.ref = ref;
        const label = labelOf(el);
        if (label && label !== node.name) node.label = label;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) node.checked = el.checked;
          else if (el.type !== "password") node.value = el.value;
        } else if (el instanceof HTMLSelectElement) {
          node.value = el.selectedOptions[0]?.textContent?.trim() ?? "";
        }
        if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") node.disabled = true;
        const ariaChecked = el.getAttribute("aria-checked");
        if (ariaChecked) node.checked = ariaChecked === "true";
      }
      nodes.push(node);
      childDepth = depth + 1;
      // A control's own text is already its name; containers such as a listbox go deeper, and so does
      // an element that is a control only by taking focus, such as a post with links in it.
      if (role && INTERACTIVE_ROLES.has(role) && !["listbox", "combobox", "tablist", "treeitem"].includes(role)) return;
    }
    for (const child of el.children) walk(child, childDepth);
  };
  walk(document.body, 0);
  return { nodes };
};

/** `testIdAttribute` is the domain's: the attribute the app marks its controls with. */
export const takeSnapshot = async (page: Page, testIdAttribute = "data-testid"): Promise<Snapshot> => {
  const { nodes } = await page.evaluate(collect, testIdAttribute);
  return { url: page.url(), title: await page.title(), nodes };
};

export const formatNode = (node: SnapshotNode): string => {
  let line = `${"  ".repeat(node.depth)}- ${node.role}`;
  if (node.name) line += ` "${node.name}"`;
  if (node.ref) line += ` [${node.ref}]`;
  if (node.label) line += ` label="${node.label}"`;
  if (node.value !== undefined) line += ` = "${node.value}"`;
  if (node.checked !== undefined) line += node.checked ? " (checked)" : " (unchecked)";
  if (node.disabled) line += " (disabled)";
  if (node.testId) line += ` {${node.testId}}`;
  return line;
};

/** The page as text. With `previous`, lines that are new since it are marked `+`. */
export const formatSnapshot = (snapshot: Snapshot, previous?: Snapshot): string => {
  const lines = snapshot.nodes.map(formatNode);
  const header = [`url: ${snapshot.url}`, `title: ${snapshot.title}`];
  if (!previous) return [...header, ...lines].join("\n");

  const before = new Map<string, number>();
  for (const line of previous.nodes.map(formatNode)) before.set(line, (before.get(line) ?? 0) + 1);
  let added = 0;
  const marked = lines.map((line) => {
    const left = before.get(line) ?? 0;
    if (left > 0) {
      before.set(line, left - 1);
      return `  ${line}`;
    }
    added++;
    return `+ ${line}`;
  });
  const removed = [...before.values()].reduce((a, b) => a + b, 0);
  const changed = previous.url !== snapshot.url ? "navigated" : `${added} new, ${removed} gone`;
  return [...header, `changed: ${changed} (new lines start with +)`, ...marked].join("\n");
};

export const refLocator = (page: Page, ref: string): Locator => page.locator(`[data-ref="${ref}"]`);

/** Roles whose accessible name is their text, so `getByRole` with the snapshot's name finds them. */
const NAMED_BY_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);
/** Roles the snapshot names by their label alone, as the accessible name does. */
const NAMED_BY_LABEL = new Set([
  "textbox",
  "combobox",
  "searchbox",
  "spinbutton",
  "listbox",
  "form",
  "table",
  "grid",
  "menu",
  "tablist",
  "dialog",
  "alertdialog",
]);
/** The length `collect` cuts a name to, ending it with an ellipsis. */
const NAME_MAX = 80;

/**
 * The Playwright locator an op should use for this node, preferring what survives a reload:
 * a unique test id, then the label, then role and name. Exploring logs it, so writing `op.ts`
 * starts from what worked. `getByTestId` reads the domain's `testIdAttribute` (`openSignedIn` sets it).
 */
export const suggestLocator = (node: SnapshotNode): string => {
  const q = JSON.stringify;
  if (node.testId && node.testIdUnique) return `page.getByTestId(${q(node.testId)})`;
  // A name cut short matches only as the start of the whole one, so it is matched as text, not exactly.
  const cut = (name: string): string | undefined => (name.length === NAME_MAX && name.endsWith("…") ? name.slice(0, -1) : undefined);
  const label = node.label ?? (["textbox", "combobox", "searchbox", "checkbox", "radio"].includes(node.role) ? node.name : undefined);
  if (label) return cut(label) ? `page.getByLabel(${q(cut(label))})` : `page.getByLabel(${q(label)}, { exact: true })`;
  if (!node.name) return node.testId ? `page.getByTestId(${q(node.testId)})` : `page.getByRole(${q(node.role)})`;
  const name = cut(node.name) ?? node.name;
  if (NAMED_BY_CONTENT.has(node.role) || NAMED_BY_LABEL.has(node.role)) {
    return `page.getByRole(${q(node.role)}, { name: ${q(name)}${cut(node.name) ? "" : ", exact: true"} })`;
  }
  // Any other role (an article, a region, an element that is a control only by taking focus) is
  // named by its aria-label or aria-labelledby alone, which getByLabel finds, or else by nothing: its
  // text, as Playwright reads it, narrows its test id or role down to it. Without text, a name from
  // its title or placeholder narrows nothing, so its test id or role is all there is.
  if (node.labelled) return cut(node.name) ? `page.getByLabel(${q(name)})` : `page.getByLabel(${q(name)}, { exact: true })`;
  if (node.textless) return node.testId ? `page.getByTestId(${q(node.testId)})` : `page.getByRole(${q(node.role)})`;
  const text = node.text ? (cut(node.text) ?? node.text) : name;
  const hasText = `.filter({ hasText: ${q(text)} })`;
  if (node.testId) return `page.getByTestId(${q(node.testId)})${hasText}`;
  return node.role === "generic" || node.role === "text" ? `page.getByText(${q(text)})` : `page.getByRole(${q(node.role)})${hasText}`;
};
